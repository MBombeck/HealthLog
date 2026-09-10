import type { BrowserContext, Page, Response } from "@playwright/test";
import * as OTPAuth from "otpauth";

import { expect, test } from "./setup/test";
import {
  clearAuthRateLimits,
  dropMfaAccount,
  expireStepUp,
  latestChallengeAttempts,
  mfaJourneyAccount,
  seedMfaAccount,
  type MfaJourneyAccount,
} from "./setup/mfa-journey-fixture";

/**
 * The whole second-factor path, end to end, in a real browser: enrol TOTP from
 * the settings surface, sign out, sign back in through the challenge, and step
 * up for an action that demands a recent factor.
 *
 * ## Why one test and not six
 *
 * Every stage here is the previous stage's output. The confirm code is the one
 * that sets the replay floor; the recovery batch the sign-in spends is the one
 * the successful regeneration issued; the expired-step-up refusal is only
 * meaningful against the session the successful one just used. Split across
 * tests, each would have to re-enrol a factor, and enrolment is exactly what
 * the first stage is testing. So it is one journey, with `test.step` marking
 * the stages in the report, and the account is thrown away afterwards.
 *
 * ## Controls
 *
 * Four refusals ride alongside the four positives, because a gate that has
 * never been seen to refuse is not known to be a gate:
 *
 *   - a wrong code at the login challenge — 401, no session cookie, and the
 *     ticket's attempt counter moved (read from the row, since the wire's 401
 *     is deliberately identical for every reason);
 *   - the enrolment code replayed at the login challenge — 401. The server
 *     implements this as a monotonic `User.totpLastStep` floor advanced on
 *     every accept (`src/lib/auth/mfa/verify-factor.ts:57-77`), so a code
 *     already spent is refused even inside its own 30-second life;
 *   - the sensitive action once the step-up stamp has aged out — 401 with
 *     `meta.errorCode = "auth.stepup.required"`, and the card's prompt;
 *   - a recovery code presented a second time — 401. The matched row is burned
 *     on first use.
 *
 * ## Codes without a clock
 *
 * Every code is computed from the enrolment secret with the `otpauth`
 * dependency the server itself verifies against, at an explicit timestamp — so
 * nothing here waits for a step boundary. The sign-in code is generated one
 * step AHEAD of now: the server accepts ±1 step of drift, and a future step is
 * necessarily above the replay floor the enrolment left behind, whichever side
 * of a boundary the request lands on.
 */

const TOTP_PERIOD_SECONDS = 30;
const RECOVERY_CODE_COUNT = 10;
const REGENERATE_ENDPOINT = "/api/auth/me/mfa/recovery-codes/regenerate";

/** A code for `atMs`, built the way `src/lib/auth/mfa/totp.ts` verifies it. */
function totpCodeAt(secretBase32: string, atMs: number): string {
  return new OTPAuth.TOTP({
    issuer: "HealthLog",
    label: "HealthLog",
    algorithm: "SHA1",
    digits: 6,
    period: TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  }).generate({ timestamp: atMs });
}

async function sessionCookie(context: BrowserContext) {
  const cookies = await context.cookies();
  return cookies.find((c) => c.name === "healthlog_session");
}

/**
 * Open the password form and submit the account's credentials.
 *
 * The login page opens in passkey mode; the password form mounts only after
 * the switch. Returns the `/api/auth/login` response so the caller can assert
 * what the SERVER said, not only what the page painted — the two answers this
 * journey cares about (a session, or a challenge) are both HTTP 200 and only
 * the body tells them apart.
 */
async function submitPassword(
  page: Page,
  account: MfaJourneyAccount,
): Promise<Response> {
  await clearAuthRateLimits();
  await page.goto("/auth/login");
  await page.getByTestId("login-use-password").click();
  await page.locator("#email").fill(account.username);
  await page.locator("#password").fill(account.password);
  const answer = page.waitForResponse(
    (res) =>
      res.url().includes("/api/auth/login") &&
      res.request().method() === "POST",
  );
  await page.getByTestId("login-password-submit").click();
  return answer;
}

/** Submit a factor at the login challenge and return the verify response. */
async function submitFactor(page: Page, code: string): Promise<Response> {
  await page.getByTestId("mfa-code-input").fill(code);
  const answer = page.waitForResponse(
    (res) =>
      res.url().includes("/api/auth/mfa/verify") &&
      res.request().method() === "POST",
  );
  await page.getByTestId("mfa-code-submit").click();
  return answer;
}

/**
 * Open the regeneration dialog, confirm it, and return the route's answer.
 *
 * The confirming click calls `preventDefault()`, which is what keeps the
 * dialog up while the request is in flight — and nothing takes it down again.
 * On SUCCESS that goes unnoticed, because the fresh-codes panel replaces the
 * whole branch the dialog lives in and it unmounts with it. On a REFUSAL the
 * branch stays, so the dialog is still open (`data-state="open"`, measured)
 * over a card that is now showing the step-up message underneath it. So the
 * journey dismisses it before reading anything on the card.
 */
async function regenerateRecoveryCodes(page: Page): Promise<Response> {
  await page.getByTestId("recovery-regenerate").click();
  const answer = page.waitForResponse(
    (res) =>
      res.url().includes(REGENERATE_ENDPOINT) &&
      res.request().method() === "POST",
  );
  await page.getByTestId("recovery-regenerate-confirm").click();
  const settled = await answer;
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-slot="alert-dialog-content"]')).toBeHidden();
  return settled;
}

/** The codes currently on screen, gated on the panel being painted. */
async function visibleRecoveryCodes(page: Page): Promise<string[]> {
  const panel = page.getByTestId("recovery-codes");
  await expect(panel).toBeVisible();
  const items = panel.locator("li");
  await expect(items).toHaveCount(RECOVERY_CODE_COUNT);
  return items.allInnerTexts();
}

test.describe("second factor", () => {
  test.afterEach(async () => {
    await dropMfaAccount(mfaJourneyAccount(test.info().project.name));
  });

  test("enrols TOTP, signs in with it, and steps up for a sensitive action", async ({
    page,
    context,
  }) => {
    // Four sign-ins, an Argon2id verify on each, an enrolment and two
    // regenerations. Comfortably outside the suite's 30 s default.
    test.setTimeout(180_000);

    // One account per project: both browser projects run this file, and the
    // journey moves the account's factor state, its replay floor and its
    // recovery batch. See the fixture's header.
    const account: MfaJourneyAccount = mfaJourneyAccount(
      test.info().project.name,
    );
    await seedMfaAccount(account);

    let secret = "";
    let enrolmentCode = "";
    let liveRecoveryCodes: string[] = [];

    await test.step("signs in with a password alone while no factor exists", async () => {
      const answer = await submitPassword(page, account);
      expect(answer.status()).toBe(200);
      const body = (await answer.json()) as {
        meta?: { mfaRequired?: boolean };
      };
      expect(body.meta?.mfaRequired).toBeUndefined();
      await page.waitForURL("/");
      expect(await sessionCookie(context)).toBeDefined();
    });

    await test.step("enrols an authenticator from the settings surface", async () => {
      await page.goto("/settings/security");
      await expect(page.getByTestId("totp-card")).toBeVisible();

      const setup = page.waitForResponse(
        (res) =>
          res.url().includes("/api/auth/me/mfa/totp/setup") &&
          res.request().method() === "POST",
      );
      await page.getByTestId("totp-setup-start").click();
      const setupAnswer = await setup;
      expect(setupAnswer.status()).toBe(200);
      const setupBody = (await setupAnswer.json()) as {
        data: { otpauthUri: string; totpSecret: string };
      };
      secret = setupBody.data.totpSecret;
      // The QR the page renders and the manual secret beside it must describe
      // the same authenticator, or a user who scans and a user who types end
      // up enrolled against different secrets.
      expect(setupBody.data.otpauthUri).toContain(secret);

      enrolmentCode = totpCodeAt(secret, Date.now());
      await page.getByTestId("totp-confirm-code").fill(enrolmentCode);
      const confirm = page.waitForResponse(
        (res) =>
          res.url().includes("/api/auth/me/mfa/totp/confirm") &&
          res.request().method() === "POST",
      );
      await page.getByTestId("totp-confirm-submit").click();
      expect((await confirm).status()).toBe(200);

      liveRecoveryCodes = await visibleRecoveryCodes(page);
      await expect(page.getByTestId("totp-error")).toBeHidden();
    });

    await test.step("rotates the recovery codes while the step-up is fresh", async () => {
      // The confirming session is stamped `mfaVerifiedAt` by the confirm route,
      // so the freshest possible step-up is the one right after enrolment.
      await page.getByTestId("recovery-codes-dismiss").click();
      const answer = await regenerateRecoveryCodes(page);
      expect(answer.status()).toBe(200);

      const rotated = await visibleRecoveryCodes(page);
      expect(rotated).not.toEqual(liveRecoveryCodes);
      await expect(page.getByTestId("totp-error")).toBeHidden();
      liveRecoveryCodes = rotated;
    });

    await test.step("refuses the same rotation once the step-up has aged out", async () => {
      await page.getByTestId("recovery-codes-dismiss").click();
      await expireStepUp(account);

      const answer = await regenerateRecoveryCodes(page);
      expect(answer.status()).toBe(401);
      const body = (await answer.json()) as {
        data: null;
        meta?: { errorCode?: string };
      };
      expect(body.data).toBeNull();
      expect(body.meta?.errorCode).toBe("auth.stepup.required");
      // And the card says so rather than failing silently.
      await expect(page.getByTestId("totp-error")).toBeVisible();
    });

    await test.step("asks for the second factor on the next sign-in", async () => {
      expect((await page.request.post("/api/auth/logout")).status()).toBe(200);

      const answer = await submitPassword(page, account);
      expect(answer.status()).toBe(200);
      const body = (await answer.json()) as {
        data: null;
        meta?: { mfaRequired?: boolean; methods?: string[] };
      };
      // A correct password is not a session here: the partial state lives in
      // the ticket and nothing is minted until the factor passes.
      expect(body.data).toBeNull();
      expect(body.meta?.mfaRequired).toBe(true);
      expect(body.meta?.methods).toEqual(
        expect.arrayContaining(["totp", "recovery"]),
      );
      await expect(page.getByTestId("mfa-login-step")).toBeVisible();
      expect(await sessionCookie(context)).toBeUndefined();
    });

    await test.step("refuses a wrong code and counts the attempt", async () => {
      const answer = await submitFactor(page, "000000");
      expect(answer.status()).toBe(401);
      await expect(page.getByTestId("mfa-error")).toBeVisible();
      await expect(page.getByTestId("mfa-login-step")).toBeVisible();
      expect(await sessionCookie(context)).toBeUndefined();
      expect(await latestChallengeAttempts(account)).toBe(1);
    });

    await test.step("refuses the enrolment code replayed", async () => {
      const answer = await submitFactor(page, enrolmentCode);
      expect(answer.status()).toBe(401);
      await expect(page.getByTestId("mfa-error")).toBeVisible();
      expect(await sessionCookie(context)).toBeUndefined();
      expect(await latestChallengeAttempts(account)).toBe(2);
    });

    await test.step("accepts a current code and lands on the dashboard", async () => {
      // One step ahead of now — inside the ±1 drift window and necessarily
      // above the floor the enrolment code left. See the file header.
      const answer = await submitFactor(
        page,
        totpCodeAt(secret, Date.now() + TOTP_PERIOD_SECONDS * 1000),
      );
      expect(answer.status()).toBe(200);
      await page.waitForURL("/");
      expect(await sessionCookie(context)).toBeDefined();
    });

    await test.step("spends a recovery code once", async () => {
      expect((await page.request.post("/api/auth/logout")).status()).toBe(200);
      await submitPassword(page, account);
      await expect(page.getByTestId("mfa-login-step")).toBeVisible();

      await page.getByTestId("mfa-toggle-recovery").click();
      const answer = await submitFactor(page, liveRecoveryCodes[0]);
      expect(answer.status()).toBe(200);
      await page.waitForURL("/");
      expect(await sessionCookie(context)).toBeDefined();
    });

    await test.step("refuses the same recovery code a second time", async () => {
      expect((await page.request.post("/api/auth/logout")).status()).toBe(200);
      await submitPassword(page, account);
      await expect(page.getByTestId("mfa-login-step")).toBeVisible();

      await page.getByTestId("mfa-toggle-recovery").click();
      const answer = await submitFactor(page, liveRecoveryCodes[0]);
      expect(answer.status()).toBe(401);
      await expect(page.getByTestId("mfa-error")).toBeVisible();
      expect(await sessionCookie(context)).toBeUndefined();
      expect(await latestChallengeAttempts(account)).toBe(1);
    });
  });
});
