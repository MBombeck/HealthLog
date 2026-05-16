import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getClientIp,
  getClientIpOrTrustWarning,
  _resetTrustViolationWarningForTests,
} from "../api-response";

const ORIGINAL_ENV = process.env.TRUST_PROXY_HOPS;

beforeEach(() => {
  delete process.env.TRUST_PROXY_HOPS;
  _resetTrustViolationWarningForTests();
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.TRUST_PROXY_HOPS;
  else process.env.TRUST_PROXY_HOPS = ORIGINAL_ENV;
});

function makeRequest(headers: Record<string, string>): Request {
  return new Request("https://example.com/", { headers });
}

// V3 audit: client-supplied X-Forwarded-For was being trusted blindly,
// allowing a per-request `XFF: 1.2.3.<rand>` to rotate the bucket of any
// per-IP rate-limit. The new contract reads XFF right-to-left with a
// configurable number of trusted hops (Express semantics).
describe("getClientIp trusted-proxy semantics (V3 audit)", () => {
  it("defaults to 1 trusted hop — returns the rightmost XFF entry", () => {
    const ip = getClientIp(
      makeRequest({ "x-forwarded-for": "9.9.9.9, 1.2.3.4, 5.6.7.8" }),
    );
    expect(ip).toBe("5.6.7.8");
  });

  it("with TRUST_PROXY_HOPS=2 returns the second-from-rightmost", () => {
    process.env.TRUST_PROXY_HOPS = "2";
    const ip = getClientIp(
      makeRequest({ "x-forwarded-for": "9.9.9.9, 1.2.3.4, 5.6.7.8" }),
    );
    expect(ip).toBe("1.2.3.4");
  });

  it("with TRUST_PROXY_HOPS=2 and a chain shorter than 2 returns null (fixes review M-3)", () => {
    process.env.TRUST_PROXY_HOPS = "2";
    // Misconfigured deployment: claims 2 trusted hops but only 1 proxy is
    // in the chain. Falling back to the leftmost (attacker-controlled)
    // entry would re-introduce XFF rotation. Refuse the chain entirely.
    const ip = getClientIp(makeRequest({ "x-forwarded-for": "5.6.7.8" }));
    expect(ip).toBeNull();
  });

  it("throws at boot when TRUST_PROXY_HOPS is unparseable (fixes review L-1)", () => {
    process.env.TRUST_PROXY_HOPS = "garbage";
    expect(() =>
      getClientIp(makeRequest({ "x-forwarded-for": "5.6.7.8" })),
    ).toThrow(/TRUST_PROXY_HOPS/);
  });

  it("with TRUST_PROXY_HOPS=0 ignores XFF entirely", () => {
    process.env.TRUST_PROXY_HOPS = "0";
    const ip = getClientIp(
      makeRequest({
        "x-forwarded-for": "9.9.9.9, 1.2.3.4",
        "x-real-ip": "8.8.8.8",
      }),
    );
    expect(ip).toBe("8.8.8.8");
  });

  it("with TRUST_PROXY_HOPS=0 and no x-real-ip returns null", () => {
    process.env.TRUST_PROXY_HOPS = "0";
    const ip = getClientIp(
      makeRequest({ "x-forwarded-for": "9.9.9.9, 1.2.3.4" }),
    );
    expect(ip).toBeNull();
  });

  it("XFF rotation attack — caller cannot bypass per-IP rate-limit by changing leftmost entry", () => {
    // Attacker sends successive requests with rotating leftmost XFF; the
    // proxy still appends the real client IP at the end, so the helper
    // returns the same IP regardless of attacker chosen XFF.
    const a = getClientIp(
      makeRequest({ "x-forwarded-for": "1.1.1.1, 203.0.113.5" }),
    );
    const b = getClientIp(
      makeRequest({ "x-forwarded-for": "8.8.8.8, 203.0.113.5" }),
    );
    expect(a).toBe("203.0.113.5");
    expect(b).toBe("203.0.113.5");
  });

  it("rejects malformed entries in the chain", () => {
    const ip = getClientIp(
      makeRequest({ "x-forwarded-for": "garbage,, 5.6.7.8" }),
    );
    expect(ip).toBe("5.6.7.8");
  });

  it("falls back to x-real-ip if XFF missing", () => {
    const ip = getClientIp(makeRequest({ "x-real-ip": "5.6.7.8" }));
    expect(ip).toBe("5.6.7.8");
  });
});

/**
 * F-6 (mobile security audit, 2026-05-16): when `TRUST_PROXY_HOPS` and
 * the actual proxy chain don't agree, getClientIp returns null and every
 * caller falls back to a literal `"unknown"` rate-limit bucket. The
 * operator needs a single warning per process so the dashboards reflect
 * the misconfiguration, and a new `getClientIpOrTrustWarning` helper
 * lets future callers route the request to a tighter universal bucket.
 */
describe("getClientIp trust-violation warning (F-6, 2026-05-16)", () => {
  it("emits a console.warn once when the chain is shorter than configured hops", () => {
    process.env.TRUST_PROXY_HOPS = "2";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      getClientIp(makeRequest({ "x-forwarded-for": "5.6.7.8" }));
      getClientIp(makeRequest({ "x-forwarded-for": "5.6.7.8" }));
      getClientIp(makeRequest({ "x-forwarded-for": "5.6.7.8" }));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/TRUST_PROXY_HOPS=2/);
      expect(warn.mock.calls[0][0]).toMatch(/1 entry/);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn when the chain length matches", () => {
    process.env.TRUST_PROXY_HOPS = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      getClientIp(makeRequest({ "x-forwarded-for": "5.6.7.8" }));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("getClientIpOrTrustWarning shape (F-6, 2026-05-16)", () => {
  it("returns trustViolation=false on a well-formed chain", () => {
    const result = getClientIpOrTrustWarning(
      makeRequest({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }),
    );
    expect(result).toEqual({ ip: "5.6.7.8", trustViolation: false });
  });

  it("returns trustViolation=true when the chain is shorter than hops", () => {
    process.env.TRUST_PROXY_HOPS = "2";
    const result = getClientIpOrTrustWarning(
      makeRequest({ "x-forwarded-for": "5.6.7.8" }),
    );
    expect(result.trustViolation).toBe(true);
    // ip falls back to x-real-ip (absent here) so it's null
    expect(result.ip).toBeNull();
  });

  it("returns trustViolation=true and x-real-ip when chain is short but x-real-ip is set", () => {
    process.env.TRUST_PROXY_HOPS = "2";
    const result = getClientIpOrTrustWarning(
      makeRequest({
        "x-forwarded-for": "5.6.7.8",
        "x-real-ip": "9.9.9.9",
      }),
    );
    expect(result).toEqual({ ip: "9.9.9.9", trustViolation: true });
  });

  it("returns trustViolation=false when XFF is absent (no chain to validate)", () => {
    const result = getClientIpOrTrustWarning(
      makeRequest({ "x-real-ip": "9.9.9.9" }),
    );
    expect(result).toEqual({ ip: "9.9.9.9", trustViolation: false });
  });

  it("emits the same once-per-process warning when triggered via the tagged helper", () => {
    process.env.TRUST_PROXY_HOPS = "2";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      getClientIpOrTrustWarning(
        makeRequest({ "x-forwarded-for": "5.6.7.8" }),
      );
      getClientIpOrTrustWarning(
        makeRequest({ "x-forwarded-for": "5.6.7.8" }),
      );
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
