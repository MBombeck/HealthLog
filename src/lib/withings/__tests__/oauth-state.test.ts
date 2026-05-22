/**
 * Unit coverage for the Withings OAuth state mint helpers.
 *
 * The connect route reads these constants verbatim; pinning the
 * 22-char base64url shape + cookie name + TTL prevents an accidental
 * drift (e.g. someone swapping `randomBytes(16).toString("hex")` back
 * in and silently exposing a 32-char hex nonce, which would still
 * "work" but is twice the entropy footprint and breaks any reader
 * that assumes the v1.4.47 shape).
 */
import { describe, it, expect } from "vitest";
import {
  WITHINGS_OAUTH_STATE_COOKIE,
  WITHINGS_OAUTH_STATE_TTL_MS,
  mintWithingsOAuthStateNonce,
} from "../oauth-state";

describe("Withings OAuth state constants", () => {
  it("uses the historical cookie name so an in-flight handshake survives a deploy", () => {
    expect(WITHINGS_OAUTH_STATE_COOKIE).toBe("withings_state");
  });

  it("sets a 10-minute TTL — long enough for the consent prompt, short enough to bound the cleanup", () => {
    expect(WITHINGS_OAUTH_STATE_TTL_MS).toBe(10 * 60 * 1000);
  });
});

describe("mintWithingsOAuthStateNonce", () => {
  it("returns a 22-char base64url string (16 random bytes, no padding)", () => {
    const nonce = mintWithingsOAuthStateNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("returns a fresh value on every call (no collisions over a small batch)", () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 100; i += 1) nonces.add(mintWithingsOAuthStateNonce());
    expect(nonces.size).toBe(100);
  });
});
