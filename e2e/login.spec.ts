import type { BrowserContext, Page } from "@playwright/test";

import { expect, test } from "./setup/test";

import {
  clearLoginBuckets,
  criticalAccount,
  resetCriticalAccount,
  type CriticalAccount,
} from "./setup/critical-fixture";

/**
 * Signing in and out, against the real server.
 *
 * Every test starts without a session and signs in through the form, so what
 * it reads is what the login route, the session table and the shell did, not
 * a payload typed into the test. The account is the sign-in journey's own
 * (one per project, see `critical-fixture.ts`): it gets no jar from global
 * setup, because the tests here end the sessions they open and a jar captured
 * once would be dead for a retry.
 *
 * The passkey half runs through Chromium's virtual authenticator, attached
 * over CDP. It is a real authenticator as far as the page and the server are
 * concerned: the registration and the assertion are signed, and the server
 * verifies both against the origin and RP id the suite runs under.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const SESSION_COOKIE = "healthlog_session";

async function openPasswordForm(page: Page): Promise<void> {
  await page.goto("/auth/login");
  // The login page opens in passkey mode; the password form mounts after
  // this button. The button is server-rendered, so the click is retried
  // until the form it mounts is there.
  const usePassword = page.getByTestId("login-use-password");
  const email = page.getByTestId("login-email");
  await expect(async () => {
    await usePassword.click({ timeout: 2_000 });
    await expect(email).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

async function signInWithPassword(
  page: Page,
  account: CriticalAccount,
): Promise<void> {
  await openPasswordForm(page);
  await page.getByTestId("login-email").fill(account.username);
  await page.getByTestId("login-password").fill(account.password);
  // The login route allows five attempts per IP per quarter hour and the
  // whole suite is one IP; see `clearLoginBuckets`.
  await clearLoginBuckets();
  await page.getByTestId("login-password-submit").click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
}

async function sessionCookie(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies()).find(
    (c) => c.name === SESSION_COOKIE,
  );
  expect(cookie, "the login answered without a session cookie").toBeTruthy();
  return cookie!.value;
}

/** The username `/api/auth/me` answers for this context's session. */
async function signedInAs(page: Page): Promise<string | null> {
  const res = await page.request.get("/api/auth/me");
  if (res.status() !== 200) return null;
  return ((await res.json()) as { data: { username: string } }).data.username;
}

async function signOutThroughTheMenu(page: Page): Promise<void> {
  // The desktop sidebar and the phone top bar each carry a user menu; only
  // one of them is on screen at a given width.
  const trigger = page
    .getByRole("button", { name: "User menu" })
    .filter({ visible: true })
    .first();
  const signOut = page.getByRole("menuitem", { name: "Sign out" });
  await expect(async () => {
    await trigger.click({ timeout: 2_000 });
    await expect(signOut).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await signOut.click();
  await page.waitForURL((url) => url.pathname === "/auth/login");
}

test.describe("login page", () => {
  test("renders username + password inputs with the right autoComplete", async ({
    page,
  }) => {
    await openPasswordForm(page);

    const username = page.getByTestId("login-email");
    await expect(username).toBeVisible();
    await expect(username).toHaveAttribute("autoComplete", /username|email/);

    const password = page.getByTestId("login-password");
    await expect(password).toBeVisible();
    await expect(password).toHaveAttribute("autoComplete", "current-password");
  });

  test("refuses a wrong password and opens no session", async ({
    page,
    context,
  }, testInfo) => {
    const account = criticalAccount("auth", testInfo);
    await openPasswordForm(page);
    await page.getByTestId("login-email").fill(account.username);
    await page.getByTestId("login-password").fill("not-this-account-password");
    await clearLoginBuckets();
    const answer = page.waitForResponse(
      (res) =>
        res.url().endsWith("/api/auth/login") &&
        res.request().method() === "POST",
    );
    await page.getByTestId("login-password-submit").click();

    expect((await answer).status()).toBe(401);
    await expect(page.getByText("Invalid credentials")).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/login/);
    expect(
      (await context.cookies()).some((c) => c.name === SESSION_COOKIE),
    ).toBe(false);
  });
});

test.describe("signing in and out", () => {
  test("a password sign-in lands on the dashboard as that account @critical", async ({
    page,
  }, testInfo) => {
    const account = criticalAccount("auth", testInfo);
    await signInWithPassword(page, account);

    await expect(page.locator("main")).toBeVisible();
    expect(await signedInAs(page)).toBe(account.username);
  });

  test("signing out ends the session on the server, not only in the browser @critical", async ({
    page,
    context,
    playwright,
    baseURL,
  }, testInfo) => {
    const account = criticalAccount("auth", testInfo);
    await signInWithPassword(page, account);
    const cookie = await sessionCookie(context);
    // A second client holding the same cookie, the way a copied jar or a
    // stolen cookie would.
    const replay = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { cookie: `${SESSION_COOKIE}=${cookie}` },
    });
    try {
      // Positive control: the replayed cookie is a working session before
      // the sign-out, so the 401 below is about the sign-out.
      expect((await replay.get("/api/auth/me")).status()).toBe(200);

      await signOutThroughTheMenu(page);

      // The browser dropped its cookie; that alone would pass with a server
      // that kept the row. The proof is the old cookie being refused.
      expect(await signedInAs(page)).toBeNull();
      expect((await replay.get("/api/auth/me")).status()).toBe(401);
      expect((await replay.get("/api/measurements?limit=1")).status()).toBe(
        401,
      );
    } finally {
      await replay.dispose();
    }

    // And the protected shell sends the browser back to the form.
    await page.goto("/");
    await page.waitForURL((url) => url.pathname === "/auth/login");
  });

  test("a passkey registered in settings signs the account back in @critical", async ({
    page,
    context,
  }, testInfo) => {
    const account = criticalAccount("auth", testInfo);
    // A retry, or the last run, may have left a credential on the account;
    // the list below has to count only the one this test registers.
    await resetCriticalAccount(account, [
      "DELETE FROM passkeys WHERE user_id = $1",
    ]);

    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send(
      "WebAuthn.addVirtualAuthenticator",
      {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      },
    );

    try {
      await signInWithPassword(page, account);

      await test.step("register a passkey under the current password", async () => {
        await page.goto("/settings/security");
        await page.getByRole("button", { name: "Add passkey" }).click();
        const dialog = page.getByRole("alertdialog");
        await expect(dialog).toBeVisible();
        await dialog.locator('input[type="password"]').fill(account.password);
        await dialog.getByRole("button", { name: "Verify and add" }).click();

        await expect(dialog).toBeHidden();
        await expect(
          page.getByTestId("passkeys-list").locator("li"),
        ).toHaveCount(1);
        const stored = await cdp.send("WebAuthn.getCredentials", {
          authenticatorId,
        });
        expect(stored.credentials).toHaveLength(1);
        expect(stored.credentials[0].isResidentCredential).toBe(true);
      });

      await signOutThroughTheMenu(page);
      expect(await signedInAs(page)).toBeNull();

      await test.step("sign in with it", async () => {
        await clearLoginBuckets();
        await page
          .getByRole("button", { name: "Sign in with Passkey" })
          .click();
        await page.waitForURL((url) => url.pathname === "/", {
          timeout: 30_000,
        });
        expect(await signedInAs(page)).toBe(account.username);

        // The server recorded the use against the stored credential.
        const res = await page.request.get("/api/auth/passkeys");
        expect(res.status()).toBe(200);
        const passkeys = (
          (await res.json()) as {
            data: Array<{ lastUsedAt: string | null }>;
          }
        ).data;
        expect(passkeys).toHaveLength(1);
        expect(passkeys[0].lastUsedAt).not.toBeNull();
      });
    } finally {
      await cdp
        .send("WebAuthn.removeVirtualAuthenticator", { authenticatorId })
        .catch(() => undefined);
    }
  });
});
