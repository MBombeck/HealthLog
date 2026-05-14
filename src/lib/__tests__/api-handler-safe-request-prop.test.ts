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

const { safeRequestProp, isTolerableRequestProbeError } = __testables;

describe("isTolerableRequestProbeError — narrow-catch classifier", () => {
  it("returns true for the V8 private-field TypeError", () => {
    const err = new TypeError(
      "Cannot read private member #state from an object whose class did not declare it",
    );
    expect(isTolerableRequestProbeError(err)).toBe(true);
  });

  it("returns true for the alternative 'private field' wording", () => {
    const err = new TypeError(
      "Cannot read private field #foo from object that was not created from its class",
    );
    expect(isTolerableRequestProbeError(err)).toBe(true);
  });

  it("returns true for the Bun / older-V8 'private name' wording", () => {
    const err = new TypeError("Cannot read private name #bar from object");
    expect(isTolerableRequestProbeError(err)).toBe(true);
  });

  it("returns true when the request handed in is undefined or null", () => {
    expect(
      isTolerableRequestProbeError(
        new TypeError("Cannot read properties of undefined (reading 'url')"),
      ),
    ).toBe(true);
    expect(
      isTolerableRequestProbeError(
        new TypeError("Cannot read properties of null (reading 'method')"),
      ),
    ).toBe(true);
    expect(
      isTolerableRequestProbeError(
        new TypeError("Cannot read property 'headers' of undefined"),
      ),
    ).toBe(true);
  });

  it("returns false for any other TypeError (real bug, must surface)", () => {
    expect(
      isTolerableRequestProbeError(
        new TypeError("undefined is not a function"),
      ),
    ).toBe(false);
    expect(
      isTolerableRequestProbeError(
        new TypeError("Cannot read properties of {} (reading 'parse')"),
      ),
    ).toBe(false);
  });

  it("returns false for non-TypeError exceptions", () => {
    expect(isTolerableRequestProbeError(new Error("private member #x"))).toBe(
      false,
    );
    expect(
      isTolerableRequestProbeError(new RangeError("private member")),
    ).toBe(false);
    expect(isTolerableRequestProbeError("private member string")).toBe(false);
    expect(isTolerableRequestProbeError(null)).toBe(false);
    expect(isTolerableRequestProbeError(undefined)).toBe(false);
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
