/**
 * The registration page, driven by its form.
 *
 * A new account starts from an empty cache, like every other sign-in: the
 * client cache outlives the navigation, and nothing read before the account
 * existed belongs to it.
 */
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { queryKeys } from "@/lib/query-keys";

import { stubFetch } from "../../../../../tests/browser/fetch-stub";
import { renderWithApp } from "../../../../../tests/browser/render";
import RegisterPage from "../page";

async function fill(selector: string, value: string): Promise<void> {
  await page.elementLocator(document.querySelector(selector)!).fill(value);
}

describe("registration page", () => {
  it("starts the new account from an empty cache", async () => {
    const api = stubFetch()
      .on("GET", "/api/auth/me", { status: 401, error: "Unauthorized" })
      .on("POST", "/api/auth/register", { data: { id: "new-account" } });
    window.history.replaceState(null, "", "/auth/register");
    const { screen, queryClient } = await renderWithApp(<RegisterPage />, {
      user: null,
    });
    // Left over from whoever used this browser before.
    queryClient.setQueryData(queryKeys.dashboardSnapshot(), { stale: true });

    await fill("#email", "new@example.com");
    await fill("#username", "newcomer");
    await fill("#password", "a long enough passphrase");
    await screen.getByRole("button", { name: "Sign up" }).click();

    await expect.poll(() => window.location.pathname).toBe("/");
    expect(api.calls("POST", "/api/auth/register")).toHaveLength(1);
    expect(queryClient.getQueryData(queryKeys.dashboardSnapshot())).toBe(
      undefined,
    );
  });
});
