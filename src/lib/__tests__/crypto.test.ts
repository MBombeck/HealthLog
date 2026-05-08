import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  encrypt,
  decrypt,
  reencryptToActive,
  extractKeyId,
  getActiveKeyId,
  _resetCryptoCacheForTests,
} from "../crypto";

const KEY_V1 =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY_V2 =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

describe("crypto (AES-256-GCM, key versioning)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("ENCRYPTION_KEYS", "");
    vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
    vi.stubEnv("ENCRYPTION_KEY", KEY_V1);
    _resetCryptoCacheForTests();
  });

  it("encrypts and decrypts back to original (legacy single-key path)", () => {
    const plaintext = "my-secret-access-token-12345";
    const encrypted = encrypt(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it("uses the synthetic 'v1' id when only ENCRYPTION_KEY is set", () => {
    expect(getActiveKeyId()).toBe("v1");
    const encrypted = encrypt("hello");
    expect(encrypted.startsWith("v1.")).toBe(true);
    expect(extractKeyId(encrypted)).toBe("v1");
  });

  it("produces different ciphertext each time (random IV)", () => {
    const a = encrypt("same-input");
    const b = encrypt("same-input");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe("same-input");
    expect(decrypt(b)).toBe("same-input");
  });

  it("handles empty strings, unicode, long input", () => {
    expect(decrypt(encrypt(""))).toBe("");
    expect(decrypt(encrypt("Zugangsdaten: 🔐 € ñ"))).toBe(
      "Zugangsdaten: 🔐 € ñ",
    );
    expect(decrypt(encrypt("x".repeat(10000)))).toBe("x".repeat(10000));
  });

  it("decrypts legacy unversioned ciphertext (bare base64)", () => {
    // Manually craft a legacy bare-base64 encryption with KEY_V1 by stripping
    // the v1. prefix the new encoder adds.
    const versioned = encrypt("legacy-row");
    const legacy = versioned.slice("v1.".length);
    // legacy should still decrypt because v1 key is in the keymap
    expect(decrypt(legacy)).toBe("legacy-row");
  });

  it("supports ENCRYPTION_KEYS + ENCRYPTION_ACTIVE_KEY_ID multi-key mode", () => {
    vi.stubEnv("ENCRYPTION_KEYS", JSON.stringify({ v1: KEY_V1, v2: KEY_V2 }));
    vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "v2");
    vi.stubEnv("ENCRYPTION_KEY", "");
    _resetCryptoCacheForTests();

    expect(getActiveKeyId()).toBe("v2");
    const ct = encrypt("multi-key-secret");
    expect(ct.startsWith("v2.")).toBe(true);
    expect(decrypt(ct)).toBe("multi-key-secret");
  });

  it("rotation: rows encrypted under old key still decrypt after switching active id", () => {
    // Phase 1 — write under v1
    vi.stubEnv("ENCRYPTION_KEYS", JSON.stringify({ v1: KEY_V1 }));
    vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "v1");
    vi.stubEnv("ENCRYPTION_KEY", "");
    _resetCryptoCacheForTests();
    const oldRow = encrypt("rotate-me");
    expect(oldRow.startsWith("v1.")).toBe(true);

    // Phase 2 — add v2 and rotate active to v2; old row still decrypts
    vi.stubEnv("ENCRYPTION_KEYS", JSON.stringify({ v1: KEY_V1, v2: KEY_V2 }));
    vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "v2");
    _resetCryptoCacheForTests();
    expect(decrypt(oldRow)).toBe("rotate-me");

    const newRow = reencryptToActive(oldRow);
    expect(newRow.startsWith("v2.")).toBe(true);
    expect(decrypt(newRow)).toBe("rotate-me");
  });

  it("fails to decrypt with wrong key", () => {
    const encrypted = encrypt("secret");
    vi.stubEnv("ENCRYPTION_KEY", "f".repeat(64));
    _resetCryptoCacheForTests();
    expect(() => decrypt(encrypted)).toThrow();
  });

  it("fails to decrypt tampered ciphertext", () => {
    const encrypted = encrypt("secret");
    // Versioned: "v1.<base64>"
    const dot = encrypted.indexOf(".");
    const buf = Buffer.from(encrypted.slice(dot + 1), "base64");
    buf[buf.length - 1] ^= 0xff;
    const tampered = `v1.${buf.toString("base64")}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it("throws if no encryption configuration is present", () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    vi.stubEnv("ENCRYPTION_KEYS", "");
    _resetCryptoCacheForTests();
    expect(() => encrypt("test")).toThrow(/Encryption is not configured/);
  });

  it("rejects malformed ENCRYPTION_KEYS JSON", () => {
    vi.stubEnv("ENCRYPTION_KEYS", "not-json");
    vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "v1");
    vi.stubEnv("ENCRYPTION_KEY", "");
    _resetCryptoCacheForTests();
    expect(() => encrypt("test")).toThrow(/valid JSON/);
  });

  it("rejects an active key id that doesn't exist in the map", () => {
    vi.stubEnv("ENCRYPTION_KEYS", JSON.stringify({ v1: KEY_V1 }));
    vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "v9");
    vi.stubEnv("ENCRYPTION_KEY", "");
    _resetCryptoCacheForTests();
    expect(() => encrypt("test")).toThrow(/no matching entry/);
  });
});
