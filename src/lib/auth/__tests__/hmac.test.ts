import { describe, it, expect, beforeAll } from "vitest";
import { verifyHmacSignature, hashToken } from "../hmac";
import { createHmac } from "node:crypto";

const TEST_HMAC_KEY = "test-hmac-key-for-unit-tests";

beforeAll(() => {
  process.env.API_TOKEN_HMAC_KEY = TEST_HMAC_KEY;
});

describe("verifyHmacSignature", () => {
  const secret = "test-secret-key";
  const body = '{"medication":"Aspirin","takenAt":"2025-01-15T08:00:00Z"}';

  it("returns true for valid signature", () => {
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    const signature = `sha256=${expected}`;
    expect(verifyHmacSignature(body, signature, secret)).toBe(true);
  });

  it("returns false for tampered body", () => {
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    const signature = `sha256=${expected}`;
    const tampered = body.replace("Aspirin", "Malware");
    expect(verifyHmacSignature(tampered, signature, secret)).toBe(false);
  });

  it("returns false for wrong secret", () => {
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    const signature = `sha256=${expected}`;
    expect(verifyHmacSignature(body, signature, "wrong-secret")).toBe(false);
  });

  it("returns false without sha256= prefix", () => {
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyHmacSignature(body, expected, secret)).toBe(false);
  });

  it("returns false for invalid hex", () => {
    expect(verifyHmacSignature(body, "sha256=not-valid-hex", secret)).toBe(
      false,
    );
  });

  it("returns false for empty signature", () => {
    expect(verifyHmacSignature(body, "", secret)).toBe(false);
  });
});

describe("hashToken", () => {
  it("returns consistent hash for same token", () => {
    const token = "my-api-token-123";
    const hash1 = hashToken(token);
    const hash2 = hashToken(token);
    expect(hash1).toBe(hash2);
  });

  it("returns different hashes for different tokens", () => {
    const hash1 = hashToken("token-a");
    const hash2 = hashToken("token-b");
    expect(hash1).not.toBe(hash2);
  });

  it("returns a hex string of length 64", () => {
    const hash = hashToken("test-token");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses API_TOKEN_HMAC_KEY env var as the HMAC key", () => {
    const token = "test-token";
    const expected = createHmac("sha256", TEST_HMAC_KEY)
      .update(token)
      .digest("hex");
    expect(hashToken(token)).toBe(expected);
  });

  it("throws if API_TOKEN_HMAC_KEY is not set", () => {
    const original = process.env.API_TOKEN_HMAC_KEY;
    delete process.env.API_TOKEN_HMAC_KEY;
    expect(() => hashToken("test")).toThrow(
      "API_TOKEN_HMAC_KEY env var must be set",
    );
    process.env.API_TOKEN_HMAC_KEY = original;
  });
});
