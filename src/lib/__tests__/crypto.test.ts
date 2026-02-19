import { describe, it, expect, beforeEach, vi } from "vitest";
import { encrypt, decrypt } from "../crypto";

describe("crypto (AES-256-GCM)", () => {
  beforeEach(() => {
    // Set a deterministic encryption key for tests (64 hex chars = 32 bytes)
    vi.stubEnv(
      "ENCRYPTION_KEY",
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
  });

  it("encrypts and decrypts back to original", () => {
    const plaintext = "my-secret-access-token-12345";
    const encrypted = encrypt(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it("produces different ciphertext each time (random IV)", () => {
    const plaintext = "same-input";
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    expect(a).not.toBe(b);
    // But both decrypt to the same value
    expect(decrypt(a)).toBe(plaintext);
    expect(decrypt(b)).toBe(plaintext);
  });

  it("handles empty strings", () => {
    const encrypted = encrypt("");
    expect(decrypt(encrypted)).toBe("");
  });

  it("handles unicode characters", () => {
    const plaintext = "Zugangsdaten: 🔐 Schlüssel € ñ";
    const encrypted = encrypt(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it("handles long strings", () => {
    const plaintext = "x".repeat(10000);
    const encrypted = encrypt(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it("fails to decrypt with wrong key", () => {
    const encrypted = encrypt("secret");
    // Change the env key
    vi.stubEnv(
      "ENCRYPTION_KEY",
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    );
    expect(() => decrypt(encrypted)).toThrow();
  });

  it("fails to decrypt tampered ciphertext", () => {
    const encrypted = encrypt("secret");
    const buf = Buffer.from(encrypted, "base64");
    // Flip a bit in the ciphertext portion
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString("base64");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("throws if ENCRYPTION_KEY is missing", () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    expect(() => encrypt("test")).toThrow("ENCRYPTION_KEY");
  });
});
