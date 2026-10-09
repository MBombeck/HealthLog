import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * v1.17.0 — invite universal-link landing (iOS #16).
 *
 * `/invite/<hlv_token>` is a thin, server-side redirect: it validates the
 * `hlv_` shape, then bounces a browser onto the existing
 * `/auth/register?invite=<token>` flow. These tests pin the security
 * contract — the token shape gate, the carry-through to register, and the
 * non-oracle behaviour where a malformed segment is indistinguishable
 * from "no invite". The route never touches the database.
 */
const redirectMock = vi.fn((href: string) => {
  // next/navigation `redirect()` throws a sentinel inside the
  // server-component renderer to short-circuit rendering. Mimic it by
  // throwing an error tagged with the href so each test can assert the
  // exact redirect target.
  const err = new Error(`__redirect__:${href}`);
  (err as Error & { __redirect__: string }).__redirect__ = href;
  throw err;
});

vi.mock("next/navigation", () => ({
  redirect: (href: string) => redirectMock(href),
}));

vi.mock("@/lib/i18n/server-locale", () => ({
  resolveServerLocale: async () => "en",
}));

import { renderToStaticMarkup } from "react-dom/server";
import InviteLandingPage from "../page";

beforeEach(() => {
  redirectMock.mockClear();
});

const VALID_TOKEN = `hlv_${"a".repeat(64)}`;

async function runRedirect(token: string): Promise<string> {
  try {
    await InviteLandingPage({ params: Promise.resolve({ token }) });
  } catch (e) {
    const tagged = e as Error & { __redirect__?: string };
    if (tagged.__redirect__) return tagged.__redirect__;
    throw e;
  }
  throw new Error("expected redirect, none thrown");
}

describe("<InviteLandingPage> universal-link landing", () => {
  it("carries a well-formed token through to the register flow", async () => {
    const href = await runRedirect(VALID_TOKEN);
    expect(href).toBe(`/auth/register?invite=${VALID_TOKEN}`);
  });

  it("encodes the token segment into the register query string", async () => {
    const href = await runRedirect(VALID_TOKEN);
    const url = new URL(href, "https://h.example.com");
    expect(url.pathname).toBe("/auth/register");
    expect(url.searchParams.get("invite")).toBe(VALID_TOKEN);
  });

  it("names a malformed link as invalid instead of opening registration", async () => {
    // Wrong prefix, wrong length, and outright garbage all render the same
    // invalid-invite state. The shape is public, so this reveals nothing
    // about which well-formed tokens exist; those still go on to register.
    for (const bad of [
      "not-a-token",
      `hlk_${"a".repeat(64)}`,
      `hlv_${"a".repeat(63)}`,
      `hlv_${"G".repeat(64)}`,
    ]) {
      redirectMock.mockClear();
      const node = await InviteLandingPage({
        params: Promise.resolve({ token: bad }),
      });
      expect(redirectMock).not.toHaveBeenCalled();
      const html = renderToStaticMarkup(node);
      expect(html).toContain('data-slot="invite-invalid"');
      expect(html).toContain("Invitation invalid");
      expect(html).not.toContain("/auth/register");
    }
  });
});
