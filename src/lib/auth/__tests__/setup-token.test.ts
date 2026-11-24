import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectedSetupToken,
  isSetupProof,
  isSetupToken,
  logSetupTokenAtBoot,
  mintSetupProof,
} from "../setup-token";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

beforeEach(() => {
  vi.stubEnv("API_TOKEN_HMAC_KEY", KEY_A);
  vi.stubEnv("SETUP_TOKEN", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the derived setup token", () => {
  it("is stable for a key, differs between keys, and carries its prefix", () => {
    const first = expectedSetupToken();
    expect(first).toMatch(/^hlu_[0-9a-f]{48}$/);
    expect(expectedSetupToken()).toBe(first);
    vi.stubEnv("API_TOKEN_HMAC_KEY", KEY_B);
    expect(expectedSetupToken()).not.toBe(first);
  });

  it("accepts exactly itself", () => {
    const token = expectedSetupToken()!;
    expect(isSetupToken(token)).toBe(true);
    expect(isSetupToken(` ${token} `)).toBe(true);
    expect(isSetupToken(token.slice(0, -1))).toBe(false);
    expect(isSetupToken("")).toBe(false);
    expect(isSetupToken(undefined)).toBe(false);
    expect(isSetupToken(42)).toBe(false);
  });
});

describe("an operator-chosen SETUP_TOKEN", () => {
  it("replaces the derived one", () => {
    const chosen = "x".repeat(40);
    vi.stubEnv("SETUP_TOKEN", chosen);
    expect(expectedSetupToken()).toBe(chosen);
    expect(isSetupToken(chosen)).toBe(true);
  });

  it("opens nothing when shorter than 32 characters", () => {
    vi.stubEnv("SETUP_TOKEN", "short-token");
    expect(expectedSetupToken()).toBeNull();
    expect(isSetupToken("short-token")).toBe(false);
  });
});

describe("the setup proof", () => {
  it("verifies its own value and refuses a changed or expired one", () => {
    const proof = mintSetupProof();
    expect(isSetupProof(proof)).toBe(true);

    const [expiry, signature] = proof.split(".");
    expect(isSetupProof(`${Number(expiry) + 1000}.${signature}`)).toBe(false);
    expect(isSetupProof(`${expiry}.${"0".repeat(64)}`)).toBe(false);
    expect(isSetupProof(mintSetupProof(Date.now() - 31 * 60 * 1000))).toBe(
      false,
    );
    expect(isSetupProof(undefined)).toBe(false);
    expect(isSetupProof("not-a-proof")).toBe(false);
  });

  it("is bound to the instance's key", () => {
    const proof = mintSetupProof();
    vi.stubEnv("API_TOKEN_HMAC_KEY", KEY_B);
    expect(isSetupProof(proof)).toBe(false);
  });
});

describe("logSetupTokenAtBoot", () => {
  const prisma = (count: number) => ({
    user: { count: vi.fn(async () => count) },
  });

  it("prints the derived token while the instance has no account", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await logSetupTokenAtBoot(prisma(0));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(expectedSetupToken()!),
    );
  });

  it("stays silent once an account exists", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await logSetupTokenAtBoot(prisma(1));
    expect(log).not.toHaveBeenCalled();
  });

  it("never prints an operator-chosen token, and warns about a short one", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("SETUP_TOKEN", "y".repeat(40));
    await logSetupTokenAtBoot(prisma(0));
    expect(log.mock.calls.flat().join(" ")).not.toContain("y".repeat(40));

    vi.stubEnv("SETUP_TOKEN", "short");
    await logSetupTokenAtBoot(prisma(0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("shorter"));
  });
});
