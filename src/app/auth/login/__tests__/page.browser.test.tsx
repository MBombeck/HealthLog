/**
 * The sign-in page, driven by its buttons.
 *
 * Single sign-on leaves the page for the identity provider and the session
 * starts on the way back, so the previous account's offline copies have to
 * be gone before the page is left. A sign-in that stays in the app replaces
 * the sign-in page in the history, so Back does not show the form again.
 * A refusal is said in the reader's language, never in the server's words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { page } from "vitest/browser";

import {
  stubFetch,
  type FetchStub,
} from "../../../../../tests/browser/fetch-stub";
import { renderWithApp } from "../../../../../tests/browser/render";
import { recordHistory } from "../../../../../tests/browser/url";

const clearOffline = vi.hoisted(() => vi.fn(async () => {}));
const loadDocument = vi.hoisted(() => vi.fn());

vi.mock("@/lib/pwa/query-persister", () => ({
  clearOfflineCachesForSessionEnd: clearOffline,
}));
vi.mock("@/lib/navigation/load-document", () => ({ loadDocument }));

import { MfaLoginStep } from "@/components/auth/mfa-login-step";

import LoginPage from "../page";

let api: FetchStub;

beforeEach(() => {
  api = stubFetch()
    .on("GET", "/api/auth/registration-status", {
      data: { registrationEnabled: false, sessionCookieSecure: false },
    })
    .on("GET", "/api/auth/oidc/status", {
      data: { enabled: true, buttonLabel: "Example ID", only: false },
    });
});

afterEach(() => {
  clearOffline.mockClear();
  loadDocument.mockClear();
});

describe("sign-in page, single sign-on", () => {
  it("clears the offline copies before leaving for the identity provider", async () => {
    const { screen } = await renderWithApp(<LoginPage />, { user: null });
    await screen.getByRole("button", { name: "Example ID" }).click();

    await expect.poll(() => loadDocument.mock.calls.length).toBe(1);
    expect(loadDocument.mock.calls[0][0]).toMatch(
      /^\/api\/auth\/oidc\/login\?/,
    );
    expect(clearOffline).toHaveBeenCalledTimes(1);
    expect(clearOffline.mock.invocationCallOrder[0]).toBeLessThan(
      loadDocument.mock.invocationCallOrder[0],
    );
  });
});

describe("sign-in page, password", () => {
  it("replaces itself with the page asked for", async () => {
    api.on("POST", "/api/auth/login", { data: { id: "signed-in" } });
    window.history.replaceState(null, "", "/auth/login?next=%2Fmood%3Fadd%3D1");
    const history = recordHistory();
    const { screen } = await renderWithApp(<LoginPage />, { user: null });

    await screen.getByTestId("login-use-password").click();
    await screen.getByTestId("login-email").fill("someone");
    await page
      .elementLocator(document.querySelector("#password")!)
      .fill("a long enough passphrase");
    await screen.getByTestId("login-password-submit").click();

    await expect.poll(() => window.location.pathname).toBe("/mood");
    expect(window.location.search).toBe("?add=1");
    expect(history.pushes()).toEqual([]);
  });
});

describe("sign-in refusals", () => {
  async function signInWithPassword() {
    const { screen } = await renderWithApp(<LoginPage />, { user: null });
    await screen.getByTestId("login-use-password").click();
    await screen.getByTestId("login-email").fill("someone");
    await page
      .elementLocator(document.querySelector("#password")!)
      .fill("a long enough passphrase");
    await screen.getByTestId("login-password-submit").click();
    return screen;
  }

  it("says the sign-in failed instead of the server's words", async () => {
    api.on("POST", "/api/auth/login", {
      status: 401,
      error: "Invalid credentials",
      meta: { errorCode: "http.unauthenticated" },
    });
    const screen = await signInWithPassword();
    await expect.element(screen.getByText("Login failed")).toBeVisible();
    expect(document.body.textContent).not.toContain("Invalid credentials");
  });

  it("says to wait when the limit is reached", async () => {
    api.on("POST", "/api/auth/login", {
      status: 429,
      error: "Too many login attempts. Please try again later.",
      meta: { errorCode: "http.rate_limited" },
    });
    const screen = await signInWithPassword();
    await expect
      .element(
        screen.getByText(
          "Too many attempts. Wait a few minutes and try again.",
        ),
      )
      .toBeVisible();
  });

  it("does the same for the second factor", async () => {
    api.on("POST", "/api/auth/mfa/verify", {
      status: 401,
      error: "Invalid code",
      meta: { errorCode: "http.unauthenticated" },
    });
    const { screen } = await renderWithApp(
      <MfaLoginStep
        mfaTicket="ticket"
        methods={["totp"]}
        onSuccess={() => {}}
        onCancel={() => {}}
      />,
      { user: null },
    );
    await screen.getByTestId("mfa-code-input").fill("123456");
    await screen.getByTestId("mfa-code-submit").click();
    await expect
      .element(screen.getByText("Verification failed. Please try again."))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("Invalid code");
  });
});
