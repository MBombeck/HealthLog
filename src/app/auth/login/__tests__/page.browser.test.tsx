/**
 * The sign-in page, driven by its buttons.
 *
 * Single sign-on leaves the page for the identity provider and the session
 * starts on the way back, so the previous account's offline copies have to
 * be gone before the page is left.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stubFetch } from "../../../../../tests/browser/fetch-stub";
import { renderWithApp } from "../../../../../tests/browser/render";

const clearOffline = vi.hoisted(() => vi.fn(async () => {}));
const loadDocument = vi.hoisted(() => vi.fn());

vi.mock("@/lib/pwa/query-persister", () => ({
  clearOfflineCachesForSessionEnd: clearOffline,
}));
vi.mock("@/lib/navigation/load-document", () => ({ loadDocument }));

import LoginPage from "../page";

beforeEach(() => {
  stubFetch()
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
