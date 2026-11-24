import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mintCardToken } from "../../token";
import {
  openWalletLinkToken,
  sealWalletLinkToken,
  walletAuthToken,
  walletAuthTokenMatches,
} from "../link-token";

const SERIAL = "3b2f8a5e-6c1d-4f7a-9b0e-2d4c6a8e1f35";

beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", "c".repeat(64));
  vi.stubEnv("API_TOKEN_HMAC_KEY", "d".repeat(64));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the sealed link token", () => {
  it("opens to the raw token and holds nothing in the clear", () => {
    const { raw } = mintCardToken();
    const sealed = sealWalletLinkToken(raw);
    expect(sealed).not.toContain(raw.slice(4));
    expect(openWalletLinkToken(sealed)).toBe(raw);
  });

  it("refuses to seal anything but a card token, and opens garbage to null", () => {
    expect(() => sealWalletLinkToken("hlk_not-a-card-token")).toThrow();
    expect(openWalletLinkToken("not ciphertext")).toBeNull();
  });
});

describe("the pass's authentication token", () => {
  it("is 64 hex, fixed for a link and serial, different for another", () => {
    const { raw } = mintCardToken();
    const token = walletAuthToken(raw, SERIAL);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(walletAuthToken(raw, SERIAL)).toBe(token);
    expect(walletAuthToken(raw, SERIAL.replace("3b", "4b"))).not.toBe(token);
    expect(walletAuthToken(mintCardToken().raw, SERIAL)).not.toBe(token);
    expect(token).not.toContain(raw.slice(4, 20));
  });

  it("matches only itself", () => {
    const { raw } = mintCardToken();
    const token = walletAuthToken(raw, SERIAL);
    expect(walletAuthTokenMatches(raw, SERIAL, token)).toBe(true);
    expect(walletAuthTokenMatches(raw, SERIAL, token.slice(1))).toBe(false);
    expect(walletAuthTokenMatches(raw, SERIAL, "0".repeat(64))).toBe(false);
  });
});
