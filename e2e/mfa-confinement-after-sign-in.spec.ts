import type { Page, Response } from "@playwright/test";

import { expect, test } from "./setup/test";
import {
  clearAuthRateLimits,
  dropMfaAccount,
  enforceMfaAfterSignIn,
  seedMfaAccount,
  type MfaJourneyAccount,
} from "./setup/mfa-journey-fixture";
import { SSR_PREFETCH_BASE_URL } from "./setup/ssr-prefetch-server";

/**
 * A session that began before a second-factor policy covered its account is
 * confined like a new one once the factor is due.
 *
 * The confinement used to read a due date stamped on the session at sign-in.
 * A session from before the policy (every session open across the 1.50
 * update, or one older than an admin's per-account enforcement) carried none,
 * so it kept the whole app however long the grace period had been over. The
 * decision is made per request now, from the account and the policy.
 *
 * Its own account, per Playwright project, for the reason
 * `mfa-journey-fixture.ts` gives.
 */

function account(projectName: string, variant = "old"): MfaJourneyAccount {
  const slug = projectName.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return {
    username: `e2e-mfa-${variant}-${slug}`,
    email: `e2e-mfa-${variant}-${slug}@healthlog.test`,
    // 16 chars, same shape as the other fixture passwords.
    password: "e2e-Mfa-old-0042",
  };
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

test.describe("second factor due after sign-in", () => {
  test.afterEach(async () => {
    await dropMfaAccount(account(test.info().project.name));
  });

  test("an open session is held to enrolment once the factor is due", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const who = account(test.info().project.name);
    await seedMfaAccount(who);

    await test.step("signs in with no policy covering the account", async () => {
      expect((await signIn(page, who)).status()).toBe(200);
      await page.waitForURL((url) => !url.pathname.startsWith("/auth/"));
    });

    await enforceMfaAfterSignIn(who);

    await test.step("the same session now reaches only the enrolment", async () => {
      const status = await page.evaluate(async () => {
        const data = await fetch("/api/measurements");
        const me = await fetch("/api/auth/me");
        const body = (await data.json()) as { meta?: { errorCode?: string } };
        return {
          data: data.status,
          code: body.meta?.errorCode,
          me: me.status,
        };
      });
      expect(status).toEqual({
        data: 403,
        code: "auth.mfa.enrollment_required",
        me: 200,
      });
      await page.goto("/insights");
      await expect(page).toHaveURL(/\/enroll-mfa$/);
      await expect(page.getByTestId("totp-card")).toBeVisible();
    });
  });
});

/**
 * The same session on the server as it ships (the dashboard prefetch on) and
 * without the hint cookie: the redirect comes from the server render of the
 * page itself. The root layout and the dashboard both wrap the session
 * resolve in a catch, which used to take the redirect for a failure and
 * render the dashboard, every read of it answering 403.
 */
test.describe("second factor due, server render", () => {
  test.use({ baseURL: SSR_PREFETCH_BASE_URL });

  test.afterEach(async () => {
    await dropMfaAccount(account(test.info().project.name, "ssr"));
  });

  test("the page itself redirects to the enrolment", async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000);
    const who = account(test.info().project.name, "ssr");
    await seedMfaAccount(who);
    expect((await signIn(page, who)).status()).toBe(200);
    await page.waitForURL((url) => !url.pathname.startsWith("/auth/"));

    await enforceMfaAfterSignIn(who);

    for (const path of ["/", "/medications"]) {
      // The enrolment page's account read sets the hint again; without it
      // the proxy does not redirect and the render has to.
      await context.clearCookies({ name: "hl_mfa_enroll" });
      await page.goto(path);
      await expect(page).toHaveURL(/\/enroll-mfa$/);
    }
    await expect(page.getByTestId("totp-card")).toBeVisible();
  });
});
