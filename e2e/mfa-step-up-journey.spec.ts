import type {
  APIResponse,
  BrowserContext,
  Page,
  Response,
} from "@playwright/test";
import * as OTPAuth from "otpauth";

import { expect, test } from "./setup/test";
import {
  clearAuthRateLimits,
  dropMfaAccount,
  expireStepUp,
  latestChallengeAttempts,
  latestMfaFailure,
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
 * Every stage here is the previous stage's output. The code the sign-in spends
 * is the code the next stage replays; the recovery batch that sign-in spends is
 * the one the successful regeneration issued; the expired-step-up refusal is
 * only meaningful against the session the successful one just used. Split
 * across tests, each would have to re-enrol a factor, and enrolment is exactly
 * what the first stage is testing. So it is one journey, with `test.step`
 * marking the stages in the report, and the account is thrown away afterwards.
 *
 * ## Controls
 *
 * Five refusals ride alongside the four positives, because a gate that has
 * never been seen to refuse is not known to be a gate:
 *
 *   - a wrong code at the login challenge — 401, no session cookie, and the
 *     ticket's attempt counter moved (read from the row, since the wire's 401
 *     is deliberately identical for every reason);
 *   - the code the previous sign-in just spent, replayed at the next challenge
 *     — 401. The server implements this as a monotonic `User.totpLastStep`
 *     floor advanced on every accept (`src/lib/auth/mfa/verify-factor.ts`), so
 *     a code already spent is refused even inside its own 30-second life;
 *   - the sensitive action once the step-up stamp has aged out — 401 with
 *     `meta.errorCode = "auth.stepup.required"`, and the card's prompt;
 *   - a recovery code presented a second time — 401. The matched row is burned
 *     on first use;
 *   - one login past the documented per-IP cap — 429, with the bucket's own
 *     headers. Measured in one project, for the reason written at that step.
 *
 * ## Reading the replay refusal, not guessing it
 *
 * Both TOTP refusals answer with the same generic 401, so the status code
 * cannot say WHY. A code that has drifted out of its ±1-step window is refused
 * before the replay floor is ever consulted, which means a status-only control
 * would stay green with the floor deleted. The route records the distinction —
 * `auth.mfa.failed` with `details.replay`, awaited before it answers — so both
 * refusals assert that verdict as a pair: false for the wrong code, true for
 * the replay.
 *
 * ## Codes without a clock
 *
 * Every code is computed from the enrolment secret with the `otpauth`
 * dependency the server itself verifies against, at an explicit timestamp. The
 * sign-in code is generated one step AHEAD of now: the server accepts ±1 step
 * of drift, and a future step is necessarily above the replay floor the
 * enrolment left behind, whichever side of a boundary the request lands on.
 *
 * The one place the boundary matters is that code's second life as the replay:
 * it stays in-window for two steps past the one it names, and the sign-out and
 * sign-in between the two submissions eat into that. So the journey parks for
 * the next step boundary — bounded by a single period, and only when the
 * current step has too little left — instead of hoping the wall clock is kind.
 */

const TOTP_PERIOD_SECONDS = 30;
const RECOVERY_CODE_COUNT = 10;
const REGENERATE_ENDPOINT = "/api/auth/me/mfa/recovery-codes/regenerate";
/** `/api/auth/login`, per IP per 15 minutes (`src/lib/rate-limit.ts`). */
const LOGIN_ATTEMPT_LIMIT = 5;
/** The project that measures that cap — see the closing step for why one. */
const THROTTLE_PROBE_PROJECT = "chromium-desktop";
/**
 * The margin the accept→replay pair needs. A code named for step N verifies
 * until the end of step N+1 (drift −1), so generating it one step ahead leaves
 * at least two periods; below this the journey waits for the next boundary.
 */
const REPLAY_MARGIN_MS = 75_000;

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

/**
 * Park until the next TOTP step starts, when the current one has too little
 * left for the code about to be minted to survive its replay.
 *
 * Bounded by a single period and usually a no-op: it waits only for the last
 * seconds of a step, and a step is 30 of them.
 */
async function alignToStepBoundary(page: Page): Promise<void> {
  const periodMs = TOTP_PERIOD_SECONDS * 1000;
  const now = Date.now();
  const nextBoundary = (Math.floor(now / periodMs) + 1) * periodMs;
  // A code minted now names the next step and verifies until two periods
  // after that step begins.
  if (nextBoundary + 2 * periodMs - now >= REPLAY_MARGIN_MS) return;
  await page.waitForTimeout(nextBoundary - now);
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
 * The confirming click calls `preventDefault()` so the dialog survives the
 * request in flight; the mutation takes it down again when the request
 * settles, whatever the answer was. That matters on a REFUSAL, where the card
 * behind the dialog is the only thing that says why — on a success the
 * fresh-codes panel replaces the whole branch the dialog lives in and it would
 * unmount either way. So the dialog being gone here is a product assertion,
 * not housekeeping: nothing in this helper dismisses it.
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
  await expect(page.getByTestId("recovery-regenerate-dialog")).toBeHidden();
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

/**
 * Spend the login bucket from empty and hand back the answer that went over.
 *
 * The bucket is per-IP, and the sibling browser project running this same file
 * shares it: its sign-ins clear the bucket, and its own attempts fill it. Both
 * directions disturb a round rather than fake one — a disturbed round is
 * retried, and a round only counts when the whole documented shape holds, the
 * cap's worth of attempts answered normally and the next one refused. Returns
 * null when no round came out clean, which fails loudly at the call site.
 */
async function reachLoginCap(
  page: Page,
  account: MfaJourneyAccount,
): Promise<APIResponse | null> {
  const attempt = () =>
    page.request.post("/api/auth/login", {
      data: { email: account.username, password: "not-this-account-password" },
    });

  for (let round = 0; round < 3; round += 1) {
    await clearAuthRateLimits();
    let clean = true;
    for (let i = 0; i < LOGIN_ATTEMPT_LIMIT && clean; i += 1) {
      clean = (await attempt()).status() === 401;
    }
    if (!clean) continue;
    const capped = await attempt();
    if (capped.status() === 429) return capped;
  }
  return null;
}

test.describe("second factor", () => {
  test.afterEach(async () => {
    await dropMfaAccount(mfaJourneyAccount(test.info().project.name));
  });

  test("enrols TOTP, signs in with it, and steps up for a sensitive action", async ({
    page,
    context,
  }) => {
    // Five sign-ins, an Argon2id verify on each, an enrolment, two
    // regenerations and a bounded park on a step boundary. Comfortably
    // outside the suite's 30 s default.
    test.setTimeout(240_000);

    // One account per project: both browser projects run this file, and the
    // journey moves the account's factor state, its replay floor and its
    // recovery batch. See the fixture's header.
    const account: MfaJourneyAccount = mfaJourneyAccount(
      test.info().project.name,
    );
    await seedMfaAccount(account);

    let secret = "";
    let spentCode = "";
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

      await page
        .getByTestId("totp-confirm-code")
        .fill(totpCodeAt(secret, Date.now()));
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
      // And the card says so, on a card the closed dialog no longer covers.
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

    await test.step("refuses wrong codes and counts each attempt", async () => {
      const answer = await submitFactor(page, "000000");
      expect(answer.status()).toBe(401);
      await expect(page.getByTestId("mfa-error")).toBeVisible();
      await expect(page.getByTestId("mfa-login-step")).toBeVisible();
      expect(await sessionCookie(context)).toBeUndefined();
      expect(await latestChallengeAttempts(account)).toBe(1);
      // The negative half of the replay pair: a code that never matched the
      // secret is not a replay, and the server says so.
      expect((await latestMfaFailure(account)).replay).toBe(false);

      // A second refusal moves the counter again rather than resetting it.
      expect((await submitFactor(page, "000001")).status()).toBe(401);
      expect(await latestChallengeAttempts(account)).toBe(2);
    });

    await test.step("accepts a current code and lands on the dashboard", async () => {
      await alignToStepBoundary(page);
      // One step ahead of now — inside the ±1 drift window and necessarily
      // above the floor the enrolment code left. See the file header.
      spentCode = totpCodeAt(secret, Date.now() + TOTP_PERIOD_SECONDS * 1000);
      const answer = await submitFactor(page, spentCode);
      expect(answer.status()).toBe(200);
      await page.waitForURL("/");
      expect(await sessionCookie(context)).toBeDefined();
    });

    await test.step("refuses the code the last sign-in spent", async () => {
      expect((await page.request.post("/api/auth/logout")).status()).toBe(200);
      await submitPassword(page, account);
      await expect(page.getByTestId("mfa-login-step")).toBeVisible();

      const answer = await submitFactor(page, spentCode);
      expect(answer.status()).toBe(401);
      await expect(page.getByTestId("mfa-error")).toBeVisible();
      expect(await sessionCookie(context)).toBeUndefined();
      expect(await latestChallengeAttempts(account)).toBe(1);
      // The code is still inside its own life — the floor is what refused it,
      // and this is the assertion that fails if the floor is removed.
      expect((await latestMfaFailure(account)).replay).toBe(true);
    });

    await test.step("spends a recovery code once", async () => {
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

    // Every sign-in above clears this bucket, which makes the throttle the one
    // auth control the journey rides on and never sees. It costs one step to
    // see it: the account is about to be dropped and nothing else signs in
    // from here.
    //
    // Measured in ONE project. The bucket is keyed per IP and every spec on
    // the machine is that one IP, the sibling browser project running this
    // same file included — two probes emptying and filling one bucket beside
    // each other measure their own interference, not the limiter, and were
    // seen to. The limit is server behaviour with no viewport in it, so the
    // second project would only re-measure the first.
    if (test.info().project.name === THROTTLE_PROBE_PROJECT) {
      await test.step("refuses the login past the per-IP cap", async () => {
        const capped = await reachLoginCap(page, account);
        expect(
          capped,
          "no round of login attempts reached the cap",
        ).not.toBeNull();
        expect(capped?.status()).toBe(429);
        expect(capped?.headers()["x-ratelimit-remaining"]).toBe("0");
        expect(capped?.headers()["x-ratelimit-reset"]).toBeTruthy();
        // Hand the bucket back to the machine — it is shared per IP.
        await clearAuthRateLimits();
      });
    }
  });
});
