/**
 * The journey that would have caught the invite defect.
 *
 * Every layer of the invite chain had unit coverage and the chain was broken
 * anyway: the proxy test proved the edge admits `/invite/<token>`, the landing
 * page test proved it redirects onto `/auth/register?invite=…`, and neither
 * could see that in the real runtime the redirect arrives in an RSC flight
 * payload AFTER the shell has flushed — so the shell mounted on `/invite/…`,
 * read it as a protected route and raced its own `router.replace(
 * "/auth/login")` against it. The operator scanned his own QR in a private
 * window and landed on the sign-in page holding a one-time invitation the
 * sign-in page cannot use.
 *
 * So this spec is deliberately end to end and deliberately about the SEAM:
 * mint a real invitation in the admin UI, open the real URL in a genuinely
 * cookie-less context, and assert both where the visitor ends up and where
 * they never went.
 *
 * The second case is the other half of the same defect: the same link opened
 * in the admin's own window used to render the bare form, and submitting it
 * replaced his session cookie with the new account's — signing him out of his
 * admin account and into a stranger's onboarding.
 *
 * Neither case completes a signup: that would add a user to the shared e2e
 * database and spend the 5-per-15-minutes registration bucket every other
 * spec shares. What the signup does with the token is pinned in
 * `src/app/api/auth/register/__tests__/route.test.ts`.
 */
import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { expect, test } from "./setup/test";

/** Mint an invitation in the admin UI and return its `/invite/<token>` path. */
async function mintInvite(page: import("@playwright/test").Page) {
  await page.goto("/admin/invites");
  await page.getByTestId("admin-invites-open-create").click();
  await page.getByTestId("admin-invites-submit-create").click();
  const minted = page.getByTestId("admin-invites-minted");
  await expect(minted).toBeVisible();
  const url = await page.getByTestId("admin-invites-minted-url").textContent();
  expect(url).toMatch(/\/invite\/hlv_[0-9a-f]{64}$/);
  // The minted URL carries whatever origin the instance is configured with
  // (`APP_URL` / `NEXT_PUBLIC_APP_URL`), which is not necessarily the one
  // Playwright is driving. The path is the part under test.
  return new URL(url!.trim()).pathname;
}

test.describe("invitation links", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("opens registration in a cookie-less window and never passes login", async ({
    page,
    browser,
  }) => {
    const invitePath = await mintInvite(page);

    // The operator's private window: a context with no cookies at all, not a
    // page that merely has not logged in.
    const fresh = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const guest = await fresh.newPage();
    const visited: string[] = [];
    guest.on("framenavigated", (frame) => {
      if (frame === guest.mainFrame()) visited.push(frame.url());
    });

    try {
      await guest.goto(invitePath);
      await expect(guest).toHaveURL(
        /\/auth\/register\?invite=hlv_[0-9a-f]{64}/,
      );
      await expect(guest.getByTestId("register-invite-banner")).toBeVisible();
      // The form is reachable, not just the URL.
      await expect(guest.locator("#username")).toBeVisible();
      // The defect, named: the visitor must never have been bounced through
      // the sign-in page on the way.
      expect(visited.filter((u) => u.includes("/auth/login"))).toEqual([]);
    } finally {
      // Contexts a spec creates itself are invisible to the route-cleanup
      // fixture — see the header of `e2e/setup/test.ts`.
      await fresh.close();
    }
  });

  test("shows the signed-in panel in the admin's own window and keeps the session", async ({
    page,
  }) => {
    const invitePath = await mintInvite(page);

    await page.goto(invitePath);
    await expect(page).toHaveURL(/\/auth\/register\?invite=hlv_[0-9a-f]{64}/);
    await expect(page.getByTestId("register-already-signed-in")).toBeVisible();
    // No form to submit, so no way to register over the live session.
    await expect(page.locator("#username")).toHaveCount(0);
    await expect(page.getByTestId("register-sign-out")).toBeVisible();

    // The admin is still the admin.
    const me = await page.request.get("/api/auth/me");
    expect(me.status()).toBe(200);
  });

  test("refuses a registration POST carried on a live session", async ({
    page,
  }) => {
    // The server half of the same rule, asserted through the wire rather than
    // through the UI: the panel above is an explanation, not the enforcement.
    const res = await page.request.post("/api/auth/register", {
      data: {
        email: "invite-over-session@healthlog.test",
        username: "invite-over-session",
        password: "ZJ4hN8x!Pq3vMr2C",
      },
    });
    expect(res.status()).toBe(409);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("already_authenticated");
  });
});
