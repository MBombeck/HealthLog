import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  onTestFinished,
  vi,
} from "vitest";
import {
  getClientIp,
  getClientIpOrTrustWarning,
  _resetTrustViolationWarningForTests,
  _resetUnreadProxyHeadersWarningForTests,
} from "../api-response";

const ORIGINAL_HOPS = process.env.TRUST_PROXY_HOPS;
const ORIGINAL_CF_FLAG = process.env.TRUST_CF_CONNECTING_IP;

beforeEach(() => {
  delete process.env.TRUST_PROXY_HOPS;
  delete process.env.TRUST_CF_CONNECTING_IP;
  _resetTrustViolationWarningForTests();
  _resetUnreadProxyHeadersWarningForTests();
});

afterEach(() => {
  if (ORIGINAL_HOPS === undefined) delete process.env.TRUST_PROXY_HOPS;
  else process.env.TRUST_PROXY_HOPS = ORIGINAL_HOPS;
  if (ORIGINAL_CF_FLAG === undefined) delete process.env.TRUST_CF_CONNECTING_IP;
  else process.env.TRUST_CF_CONNECTING_IP = ORIGINAL_CF_FLAG;
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

  it.each(["", "   "])(
    "treats an empty TRUST_PROXY_HOPS (%j) as unset — the default compose file passes one",
    (value) => {
      process.env.TRUST_PROXY_HOPS = value;
      const ip = getClientIp(
        makeRequest({ "x-forwarded-for": "9.9.9.9, 1.2.3.4, 5.6.7.8" }),
      );
      expect(ip).toBe("5.6.7.8");
    },
  );

  it("with TRUST_PROXY_HOPS=0 trusts no forwarding header, x-real-ip included", () => {
    process.env.TRUST_PROXY_HOPS = "0";
    const ip = getClientIp(
      makeRequest({
        "x-forwarded-for": "9.9.9.9, 1.2.3.4",
        "x-real-ip": "8.8.8.8",
      }),
    );
    expect(ip).toBeNull();
  });

  it("x-real-ip rotation — with no declared proxy a caller cannot mint a fresh bucket per request", () => {
    process.env.TRUST_PROXY_HOPS = "0";
    const seen = new Set(
      ["1.1.1.1", "2.2.2.2", "3.3.3.3"].map((ip) =>
        getClientIp(makeRequest({ "x-real-ip": ip })),
      ),
    );
    expect(seen).toEqual(new Set([null]));
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

  // v1.4.38 — looksLikeIp now defers to node:net's `isIP` instead of
  // a hex/dot character-class regex. Structurally invalid candidates
  // (`:::`, `1.2`, `gg:hh::1`) used to slip through the regex and
  // pollute the rate-limit / audit log with non-IP strings; they are
  // now rejected at the helper.
  it("rejects structurally invalid IPv4 candidates (1.2)", () => {
    const ip = getClientIp(makeRequest({ "x-forwarded-for": "1.2, 5.6.7.8" }));
    expect(ip).toBe("5.6.7.8");
  });

  it("rejects structurally invalid IPv6 candidates (:::)", () => {
    const ip = getClientIp(makeRequest({ "x-forwarded-for": ":::, 5.6.7.8" }));
    expect(ip).toBe("5.6.7.8");
  });

  it("rejects hex-but-not-IPv6 chains", () => {
    const ip = getClientIp(
      makeRequest({ "x-forwarded-for": "gg:hh::1, 5.6.7.8" }),
    );
    expect(ip).toBe("5.6.7.8");
  });

  it("accepts well-formed IPv6 addresses", () => {
    process.env.TRUST_PROXY_HOPS = "1";
    const ip = getClientIp(makeRequest({ "x-forwarded-for": "2001:db8::1" }));
    expect(ip).toBe("2001:db8::1");
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

/**
 * v1.4.37 — Cloudflare's `cf-connecting-ip` carries the visitor IP
 * for every request that lands on its edge. The Coolify-fronted
 * HealthLog stack sits behind Cloudflare; without consulting this
 * header, the admin sign-in geo lookup had no signal to resolve from
 * because XFF stops at the Caddy loopback. The header is honoured
 * only under `TRUST_CF_CONNECTING_IP=1` so a self-hosted deployment
 * without Cloudflare in front cannot be tricked by an attacker
 * setting the header directly.
 */
describe("X-Real-IP with two or more hops, and headers the trust cannot read", () => {
  it("does not read X-Real-IP when two hops are declared and XFF is missing", () => {
    process.env.TRUST_PROXY_HOPS = "2";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A caller behind the outer proxy could have written it.
      expect(getClientIp(makeRequest({ "x-real-ip": "9.9.9.9" }))).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/X-Real-IP/);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns once when TRUST_PROXY_HOPS=0 and a proxy sends only X-Real-IP", () => {
    process.env.TRUST_PROXY_HOPS = "0";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i++) {
        expect(
          getClientIp(makeRequest({ "x-real-ip": `10.0.0.${i}` })),
        ).toBeNull();
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/TRUST_PROXY_HOPS=0/);
      expect(warn.mock.calls[0][0]).toMatch(/TRUST_PROXY_HOPS=1/);
    } finally {
      warn.mockRestore();
    }
  });

  it("stays quiet with TRUST_PROXY_HOPS=0 and no forwarding header", () => {
    process.env.TRUST_PROXY_HOPS = "0";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(getClientIp(makeRequest({}))).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("getClientIp Cloudflare cf-connecting-ip branch (v1.4.37)", () => {
  it("returns cf-connecting-ip when the env flag is on and the header is present", () => {
    process.env.TRUST_CF_CONNECTING_IP = "1";
    const ip = getClientIp(
      makeRequest({
        "cf-connecting-ip": "203.0.113.42",
        "x-forwarded-for": "1.1.1.1, 192.0.2.7",
      }),
    );
    expect(ip).toBe("203.0.113.42");
  });

  it("ignores cf-connecting-ip when the env flag is off (default)", () => {
    // Default — header set by an attacker on a deployment without
    // Cloudflare in front must NOT be trusted; the helper falls
    // through to the XFF / x-real-ip chain.
    const ip = getClientIp(
      makeRequest({
        "cf-connecting-ip": "203.0.113.42",
        "x-forwarded-for": "9.9.9.9, 5.6.7.8",
      }),
    );
    expect(ip).toBe("5.6.7.8");
  });

  it("ignores cf-connecting-ip when the env flag is any value other than '1'", () => {
    process.env.TRUST_CF_CONNECTING_IP = "true";
    const ip = getClientIp(
      makeRequest({
        "cf-connecting-ip": "203.0.113.42",
        "x-forwarded-for": "9.9.9.9, 5.6.7.8",
      }),
    );
    expect(ip).toBe("5.6.7.8");
  });

  it("falls back to the XFF chain when the env flag is on but cf-connecting-ip is missing", () => {
    process.env.TRUST_CF_CONNECTING_IP = "1";
    const ip = getClientIp(
      makeRequest({ "x-forwarded-for": "1.1.1.1, 5.6.7.8" }),
    );
    expect(ip).toBe("5.6.7.8");
  });

  it("rejects a malformed cf-connecting-ip when the env flag is on", () => {
    process.env.TRUST_CF_CONNECTING_IP = "1";
    const ip = getClientIp(
      makeRequest({
        "cf-connecting-ip": "<<not-an-ip>>",
        "x-forwarded-for": "1.1.1.1, 5.6.7.8",
      }),
    );
    expect(ip).toBe("5.6.7.8");
  });

  it("getClientIpOrTrustWarning also prefers cf-connecting-ip when the flag is on", () => {
    process.env.TRUST_CF_CONNECTING_IP = "1";
    const result = getClientIpOrTrustWarning(
      makeRequest({
        "cf-connecting-ip": "203.0.113.42",
        "x-forwarded-for": "1.1.1.1",
      }),
    );
    expect(result).toEqual({ ip: "203.0.113.42", trustViolation: false });
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

  it("returns trustViolation=true and ignores x-real-ip when the chain is short", () => {
    // The declared proxies were bypassed, so x-real-ip came from the caller.
    process.env.TRUST_PROXY_HOPS = "2";
    const result = getClientIpOrTrustWarning(
      makeRequest({
        "x-forwarded-for": "5.6.7.8",
        "x-real-ip": "9.9.9.9",
      }),
    );
    expect(result).toEqual({ ip: null, trustViolation: true });
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
      getClientIpOrTrustWarning(makeRequest({ "x-forwarded-for": "5.6.7.8" }));
      getClientIpOrTrustWarning(makeRequest({ "x-forwarded-for": "5.6.7.8" }));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * A caller that reaches the server directly used to choose its own address:
 * one trusted hop is the default, and the rightmost X-Forwarded-For entry is
 * whatever the caller wrote when no proxy appended to it. Every per-IP limit
 * became per-request. The server now stamps each request with its
 * connection's peer (`@/lib/http/peer-address`), and forwarding headers are
 * read only from a peer that could be a proxy.
 */
describe("getClientIp against the connection's own peer", () => {
  const stamped = (peer: string, headers: Record<string, string> = {}) =>
    makeRequest({ ...headers, "x-healthlog-peer-address": peer });

  it("ignores forwarding headers from a public peer, however they rotate", () => {
    const ips = ["203.0.113.1", "203.0.113.2", "203.0.113.3"].map((forged) =>
      getClientIp(
        stamped("198.51.100.7", {
          "x-forwarded-for": forged,
          "x-real-ip": forged,
        }),
      ),
    );
    expect(ips).toEqual(["198.51.100.7", "198.51.100.7", "198.51.100.7"]);
  });

  it("reads forwarding headers from a proxy on a private network or loopback", () => {
    for (const proxy of ["172.18.0.2", "127.0.0.1", "::1", "100.101.102.103"]) {
      expect(
        getClientIp(stamped(proxy, { "x-forwarded-for": "203.0.113.5" })),
      ).toBe("203.0.113.5");
    }
    expect(
      getClientIp(stamped("10.0.0.2", { "x-real-ip": "203.0.113.6" })),
    ).toBe("203.0.113.6");
  });

  it("reads an IPv4 peer that the socket reports in IPv6 form", () => {
    expect(
      getClientIp(
        stamped("::ffff:198.51.100.7", { "x-forwarded-for": "203.0.113.1" }),
      ),
    ).toBe("198.51.100.7");
  });

  it("uses the peer itself with no proxy declared, instead of nothing", () => {
    process.env.TRUST_PROXY_HOPS = "0";
    expect(
      getClientIp(
        stamped("198.51.100.7", { "x-forwarded-for": "203.0.113.1" }),
      ),
    ).toBe("198.51.100.7");
  });

  it("trusts no forwarding header on a request the server did not stamp, once it stamps", async () => {
    const { installPeerAddressStamp, __uninstallPeerAddressStampForTests } =
      await import("../http/peer-address");
    installPeerAddressStamp();
    onTestFinished(__uninstallPeerAddressStampForTests);
    expect(
      getClientIp(makeRequest({ "x-forwarded-for": "203.0.113.1" })),
    ).toBeNull();
    // A stamp that is not an address (the socket was already gone).
    expect(
      getClientIp(stamped("", { "x-forwarded-for": "203.0.113.1" })),
    ).toBeNull();
  });
});
