import type { Page, Response } from "@playwright/test";
import * as OTPAuth from "otpauth";

import {
  TOTP_ALGORITHM,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
} from "@/lib/auth/mfa/totp";

import { expect, test } from "./setup/test";
import {
  clearAuthRateLimits,
  dropMfaAccount,
  seedMfaAccount,
  type MfaJourneyAccount,
} from "./setup/mfa-journey-fixture";

/**
 * A brand-new account whose second factor is already due reaches the
 * dashboard: enrolment first, then onboarding, then the app.
 *
 * The two gates once pointed at each other. The proxy sent every page but
 * `/onboarding` to `/onboarding` while onboarding was pending, `/enroll-mfa`
 * included; the onboarding page reads the session, and a session past its
 * second-factor due date is sent to `/enroll-mfa`. The browser gave up on the
 * redirect chain and the account could do nothing. Reachable on every
 * instance whose policy is due for an account that has not onboarded yet: an
 * admin's per-account enforcement before the first sign-in (due at once, the
 * case seeded here), or a registration after the instance policy's grace.
 *
 * Its own account, per Playwright project, for the reason
 * `mfa-journey-fixture.ts` gives: the journey enrols a factor, which changes
 * how the account signs in for anyone sharing it.
 */

function account(projectName: string): MfaJourneyAccount {
  const slug = projectName.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return {
    username: `e2e-mfa-new-${slug}`,
    email: `e2e-mfa-new-${slug}@healthlog.test`,
    // 16 chars, same shape as the other fixture passwords.
    password: "E2eMfaNewPass16!",
  };
}

function totpCodeAt(secretBase32: string, atMs: number): string {
  return new OTPAuth.TOTP({
    issuer: "HealthLog",
    label: "HealthLog",
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  }).generate({ timestamp: atMs });
}

async function signIn(page: Page, who: MfaJourneyAccount): Promise<Response> {
  await clearAuthRateLimits();
  await page.goto("/auth/login");
  await page.getByTestId("login-use-password").click();
  await page.getByTestId("login-email").fill(who.username);
  await page.getByTestId("login-password").fill(who.password);
  const answer = page.waitForResponse(
    (res) =>
      res.url().includes("/api/auth/login") &&
      res.request().method() === "POST",
  );
  await page.getByTestId("login-password-submit").click();
  return answer;
}

test.describe("second factor before onboarding", () => {
  test.afterEach(async () => {
    await dropMfaAccount(account(test.info().project.name));
  });

  test("a new admin under a due second factor enrols, onboards and reaches the dashboard", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const who = account(test.info().project.name);
    await seedMfaAccount(who, {
      onboarding: "pending",
      mfaEnforced: true,
      role: "ADMIN",
    });

    // Every page response on the way, so a loop is seen as a loop.
    const redirects: string[] = [];
    page.on("response", (res) => {
      if (res.request().resourceType() === "document" && res.status() < 400) {
        const to = res.headers()["location"];
        if (to) redirects.push(`${new URL(res.url()).pathname} -> ${to}`);
      }
    });

    await test.step("signs in and lands on the enrolment surface", async () => {
      const answer = await signIn(page, who);
      expect(answer.status()).toBe(200);
      await page.waitForURL(/\/enroll-mfa$/);
      await expect(page.getByTestId("totp-card")).toBeVisible();
    });

    await test.step("a page of the app is sent to enrolment, not round", async () => {
      redirects.length = 0;
      await page.goto("/insights");
      await expect(page).toHaveURL(/\/enroll-mfa$/);
      await expect(page.getByTestId("totp-card")).toBeVisible();
      // At most proxy -> onboarding -> enrolment; a loop would be dozens.
      expect(redirects.length, redirects.join("\n")).toBeLessThanOrEqual(3);
    });

    await test.step("enrols an authenticator", async () => {
      const setup = page.waitForResponse(
        (res) =>
          res.url().includes("/api/auth/me/mfa/totp/setup") &&
          res.request().method() === "POST",
      );
      await page.getByTestId("totp-setup-start").click();
      const setupAnswer = await setup;
      expect(setupAnswer.status()).toBe(200);
      const { data } = (await setupAnswer.json()) as {
        data: { totpSecret: string };
      };
      await page
        .getByTestId("totp-confirm-code")
        .fill(totpCodeAt(data.totpSecret, Date.now()));
      const confirm = page.waitForResponse(
        (res) =>
          res.url().includes("/api/auth/me/mfa/totp/confirm") &&
          res.request().method() === "POST",
      );
      await page.getByTestId("totp-confirm-submit").click();
      expect((await confirm).status()).toBe(200);
      await expect(page.getByTestId("recovery-codes")).toBeVisible();
    });

    await test.step("onboarding opens once the factor exists", async () => {
      await page.goto("/");
      await expect(page).toHaveURL(/\/onboarding(\/[a-z/-]+)?$/);
      await expect(page.locator('[data-slot="onboarding-shell"]')).toBeVisible({
        timeout: 15_000,
      });
    });

    await test.step("finishing onboarding opens the dashboard", async () => {
      const done = await page.evaluate(async () => {
        const res = await fetch("/api/onboarding/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        return res.status;
      });
      expect(done).toBe(200);
      await page.goto("/");
      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator('[data-slot="onboarding-shell"]')).toHaveCount(
        0,
      );
    });
  });
});
