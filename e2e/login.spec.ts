import { expect, test } from "@playwright/test";

/**
 * Smoke checks on the login surface — must render, must wire the
 * password-manager autofill hints (autoComplete="username" /
 * "current-password"), must let the user submit.
 *
 * These do NOT log in (no DB seed required); the password-flow
 * roundtrip is exercised by the integration test in
 * tests/integration/auth-flow.test.ts.
 */
test.describe("login page", () => {
  test("renders username + password inputs with the right autoComplete", async ({
    page,
  }) => {
    await page.goto("/auth/login");

    const username = page.getByLabel(/username|benutzername/i).first();
    await expect(username).toBeVisible();
    await expect(username).toHaveAttribute("autoComplete", /username|email/);

    const password = page.locator('input[type="password"]').first();
    await expect(password).toBeVisible();
    await expect(password).toHaveAttribute("autoComplete", "current-password");
  });

  test("rejects an obviously-wrong credential pair", async ({ page }) => {
    await page.goto("/auth/login");

    await page
      .getByLabel(/username|benutzername/i)
      .first()
      .fill("nobody-here");
    await page.locator('input[type="password"]').first().fill("not-the-pw");

    // Intercept the API call so the test does not depend on a real
    // backend rejecting the credentials. The login form's error
    // surfacing is what we actually want to prove here.
    await page.route("**/api/auth/login", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Invalid credentials" }),
      }),
    );

    await page.getByRole("button", { name: /login|anmelden|sign in/i }).click();

    await expect(
      page.getByText(/invalid credentials|ungültig|falsch/i),
    ).toBeVisible({ timeout: 5_000 });
  });
});
