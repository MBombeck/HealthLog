import { describe, it, expect, vi } from "vitest";

// --- Mocks must be hoisted before importing the module under test. ---

vi.mock("@/lib/db", () => ({
  prisma: {},
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/auth/hmac", () => ({
  hashToken: vi.fn(),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { __testables } from "@/lib/api-handler";

const { safeRequestProp, isPrivateFieldAccessError } = __testables;

describe("isPrivateFieldAccessError — narrow-catch classifier", () => {
  it("returns true for the V8 private-field TypeError", () => {
    const err = new TypeError(
      "Cannot read private member #state from an object whose class did not declare it",
    );
    expect(isPrivateFieldAccessError(err)).toBe(true);
  });

  it("returns true for the alternative 'private field' wording", () => {
    const err = new TypeError(
      "Cannot read private field #foo from object that was not created from its class",
    );
    expect(isPrivateFieldAccessError(err)).toBe(true);
  });

  it("returns true for the Bun / older-V8 'private name' wording", () => {
    const err = new TypeError("Cannot read private name #bar from object");
    expect(isPrivateFieldAccessError(err)).toBe(true);
  });

  it("returns false for any other TypeError (real bug, must surface)", () => {
    expect(
      isPrivateFieldAccessError(new TypeError("undefined is not a function")),
    ).toBe(false);
    expect(
      isPrivateFieldAccessError(new TypeError("Cannot read properties of null")),
    ).toBe(false);
  });

  it("returns false for non-TypeError exceptions", () => {
    expect(isPrivateFieldAccessError(new Error("private member #x"))).toBe(
      false,
    );
    expect(isPrivateFieldAccessError(new RangeError("private member"))).toBe(
      false,
    );
    expect(isPrivateFieldAccessError("private member string")).toBe(false);
    expect(isPrivateFieldAccessError(null)).toBe(false);
    expect(isPrivateFieldAccessError(undefined)).toBe(false);
  });
});

describe("safeRequestProp — narrow-catch behaviour", () => {
  it("returns the read result when the request is a real NextRequest-shape", () => {
    const req = { method: "POST" };
    const result = safeRequestProp(req, (r) => r.method, "GET");
    expect(result).toBe("POST");
  });

  it("returns the fallback when the read raises the private-field TypeError", () => {
    const result = safeRequestProp(
      {},
      () => {
        throw new TypeError(
          "Cannot read private member #state from an object whose class did not declare it",
        );
      },
      "FALLBACK",
    );
    expect(result).toBe("FALLBACK");
  });

  it("re-throws any other error so real bugs surface", () => {
    expect(() =>
      safeRequestProp(
        {},
        () => {
          throw new Error("downstream parser exploded");
        },
        "FALLBACK",
      ),
    ).toThrow("downstream parser exploded");

    expect(() =>
      safeRequestProp(
        {},
        () => {
          throw new TypeError("undefined is not a function");
        },
        "FALLBACK",
      ),
    ).toThrow("undefined is not a function");

    expect(() =>
      safeRequestProp(
        {},
        () => {
          throw new RangeError("out of range");
        },
        "FALLBACK",
      ),
    ).toThrow("out of range");
  });

  it("supports null fallbacks (header lookups return string | null)", () => {
    const result = safeRequestProp<string | null>(
      {},
      () => {
        throw new TypeError("Cannot read private member #headers from object");
      },
      null,
    );
    expect(result).toBeNull();
  });
});
