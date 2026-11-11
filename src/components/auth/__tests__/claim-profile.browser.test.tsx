/**
 * Taking over a managed profile, driven by the claim page's buttons.
 *
 * Both ways in start a session for a different account than whatever this
 * browser held before: the password claim stays in the single-page app,
 * starts from an empty cache and replaces the claim page in the history; the
 * single-sign-on claim leaves for the identity provider and clears the
 * offline copies before it goes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import { queryKeys } from "@/lib/query-keys";

import {
  stubFetch,
  type FetchStub,
} from "../../../../tests/browser/fetch-stub";
import { renderWithApp } from "../../../../tests/browser/render";
import { recordHistory } from "../../../../tests/browser/url";

const clearOffline = vi.hoisted(() => vi.fn(async () => {}));
const loadDocument = vi.hoisted(() => vi.fn());

vi.mock("@/lib/pwa/query-persister", () => ({
  clearOfflineCachesForSessionEnd: clearOffline,
}));
vi.mock("@/lib/navigation/load-document", () => ({ loadDocument }));

import { ClaimProfile } from "../claim-profile";

const TOKEN = `hlp_${"c".repeat(64)}`;

let api: FetchStub;

beforeEach(() => {
  window.history.replaceState(null, "", "/auth/claim");
  api = stubFetch()
    .on("GET", "/api/auth/me", { status: 401, error: "Unauthorized" })
    .on("POST", "/api/auth/claim/preview", {
      data: {
        displayName: "Robin",
        expiresAt: "2030-01-01T00:00:00.000Z",
        guardians: [],
        methods: ["password", "sso"],
        ssoProviderName: "Example ID",
      },
    })
    .on("POST", "/api/auth/claim", {
      data: { userId: "claimed", username: "robin" },
    })
    .on("POST", "/api/auth/claim/sso", {
      data: { redirectTo: "/api/auth/oidc/login?claim=1" },
    });
});

afterEach(() => {
  clearOffline.mockClear();
  loadDocument.mockClear();
});

async function fill(selector: string, value: string): Promise<void> {
  await expect.poll(() => document.querySelector(selector)).toBeTruthy();
  await page.elementLocator(document.querySelector(selector)!).fill(value);
}

async function click(slot: string): Promise<void> {
  await page
    .elementLocator(document.querySelector(`[data-slot="${slot}"]`)!)
    .click();
}

describe("ClaimProfile", () => {
  it("starts the claimed account from an empty cache", async () => {
    const history = recordHistory();
    const { queryClient } = await renderWithApp(
      <ClaimProfile token={TOKEN} />,
      {
        user: null,
      },
    );
    queryClient.setQueryData(queryKeys.dashboardSnapshot(), { stale: true });

    await fill("#claim-username", "robin");
    await fill("#claim-email", "robin@example.com");
    await fill("#claim-password", "a long enough passphrase");
    await click("claim-submit");

    await expect
      .poll(() => window.location.pathname)
      .toBe("/onboarding/handover");
    expect(api.calls("POST", "/api/auth/claim")).toHaveLength(1);
    expect(history.pushes()).toEqual([]);
    expect(queryClient.getQueryData(queryKeys.dashboardSnapshot())).toBe(
      undefined,
    );
  });

  it("clears the offline copies before leaving for the identity provider", async () => {
    await renderWithApp(<ClaimProfile token={TOKEN} />, { user: null });

    await fill("#claim-username", "robin");
    await click("claim-sso-continue");

    await expect.poll(() => loadDocument.mock.calls.length).toBe(1);
    expect(loadDocument.mock.calls[0][0]).toMatch(
      /^\/api\/auth\/oidc\/login\?claim=1/,
    );
    expect(clearOffline).toHaveBeenCalledTimes(1);
    expect(clearOffline.mock.invocationCallOrder[0]).toBeLessThan(
      loadDocument.mock.invocationCallOrder[0],
    );
  });
});
