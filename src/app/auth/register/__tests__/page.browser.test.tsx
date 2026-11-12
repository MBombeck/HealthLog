/**
 * The registration page, driven by its form.
 *
 * A new account starts from an empty cache, like every other sign-in: the
 * client cache outlives the navigation, and nothing read before the account
 * existed belongs to it. The app replaces the page in the history, so Back
 * does not show the form again.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import { queryKeys } from "@/lib/query-keys";

import { stubFetch } from "../../../../../tests/browser/fetch-stub";
import { renderWithApp } from "../../../../../tests/browser/render";
import { recordHistory } from "../../../../../tests/browser/url";
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
    const history = recordHistory();
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
    expect(history.pushes()).toEqual([]);
    expect(queryClient.getQueryData(queryKeys.dashboardSnapshot())).toBe(
      undefined,
    );
  });
});

describe("registration page, already signed in", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("takes this browser's push subscription with it on sign-out", async () => {
    // The button exists so someone else can register on this browser; a
    // subscription left behind would show them the last account's reminders.
    const unsubscribe = vi.fn(async () => true);
    vi.spyOn(navigator.serviceWorker, "getRegistration").mockResolvedValue({
      pushManager: {
        getSubscription: async () => ({
          endpoint: "https://push.example.test/send/abc",
          unsubscribe,
        }),
      },
    } as unknown as ServiceWorkerRegistration);
    const api = stubFetch()
      .on("DELETE", "/api/notifications/web-push", { data: {} })
      .on("POST", "/api/auth/logout", { data: { loggedOut: true } });
    window.history.replaceState(null, "", "/auth/register?invite=hlv_x");
    const { screen } = await renderWithApp(<RegisterPage />, {
      user: { username: "signed-in" },
    });

    await screen.getByTestId("register-sign-out").click();

    await expect.poll(() => unsubscribe.mock.calls.length).toBe(1);
    const order = api.requests
      .map((r) => `${r.method} ${r.path.split("?")[0]}`)
      .filter((call) => !call.startsWith("GET "));
    expect(order).toEqual([
      "DELETE /api/notifications/web-push",
      "POST /api/auth/logout",
    ]);
    expect(api.calls("DELETE", "/api/notifications/web-push")[0].body).toEqual({
      endpoint: "https://push.example.test/send/abc",
    });
  });

  it("keeps the page and says so when the server refuses the sign-out", async () => {
    const api = stubFetch().on("POST", "/api/auth/logout", {
      status: 403,
      error: "Demo mode: modifications are disabled",
      meta: { demo: true, errorCode: "demo.readOnly" },
    });
    window.history.replaceState(null, "", "/auth/register?invite=hlv_x");
    const { screen, queryClient } = await renderWithApp(<RegisterPage />, {
      user: { username: "signed-in" },
    });

    await screen.getByTestId("register-sign-out").click();

    await expect
      .element(screen.getByText("Could not sign out. You are still signed in."))
      .toBeVisible();
    expect(api.calls("POST", "/api/auth/logout")).toHaveLength(1);
    // Nothing was wiped and nobody was sent anywhere: the session is alive.
    expect(queryClient.getQueryData(queryKeys.authMe())).toBeDefined();
    expect(window.location.search).toBe("?invite=hlv_x");
  });
});

describe("registration refusals", () => {
  async function register(
    response: Parameters<ReturnType<typeof stubFetch>["on"]>[2],
  ) {
    stubFetch()
      .on("GET", "/api/auth/me", { status: 401, error: "Unauthorized" })
      .on("POST", "/api/auth/register", response);
    const { screen } = await renderWithApp(<RegisterPage />, { user: null });
    await fill("#email", "new@example.com");
    await fill("#username", "newcomer");
    await fill("#password", "a long enough passphrase");
    await screen.getByRole("button", { name: "Sign up" }).click();
    return screen;
  }

  it("says what to change when the name or address is taken", async () => {
    const screen = await register({
      status: 409,
      error: "Username or email already taken",
      meta: { errorCode: "auth.register.taken" },
    });
    await expect
      .element(
        screen.getByText("That username or email address is already in use."),
      )
      .toBeVisible();
    expect(document.body.textContent).not.toContain("already taken");
  });

  it("tells an invitee their link no longer works", async () => {
    const screen = await register({
      status: 403,
      error: "Invalid or expired invite",
      meta: { errorCode: "auth.register.invite_invalid" },
    });
    await expect
      .element(screen.getByText(/This invitation is no longer valid/))
      .toBeVisible();
  });

  it("says the registration failed for a refusal it has no words for", async () => {
    const screen = await register({
      status: 500,
      error: "Internal error",
      meta: { errorCode: "http.internal" },
    });
    await expect.element(screen.getByText("Registration failed")).toBeVisible();
    expect(document.body.textContent).not.toContain("Internal error");
  });

  it("shows the password feedback, which the server words for the reader", async () => {
    const screen = await register({
      status: 422,
      error: "Füge ein oder zwei Wörter hinzu.",
      meta: { errorCode: "http.invalid" },
    });
    await expect
      .element(screen.getByText("Füge ein oder zwei Wörter hinzu."))
      .toBeVisible();
  });
});
