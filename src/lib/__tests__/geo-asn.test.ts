import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * v1.4.27 B3 — ASN + carrier lookup tests.
 *
 * The MaxMind GeoLite2-ASN MMDB is too large for the test fixtures
 * directory (~10 MB) and shipping it would bloat git history. These
 * tests mock `mmdb-lib` directly so the assertion focuses on the
 * resolver contract:
 *
 *   - Private / loopback IPs short-circuit to `null` without touching
 *     the reader.
 *   - A missing MMDB file (no offline DB on the host) yields `null`.
 *   - A row from the DB with both `autonomous_system_number` and
 *     `autonomous_system_organization` is folded into `{ asn, carrier }`.
 *   - Reader throws are swallowed (the helper is called from a
 *     fire-and-forget audit-log path; a thrown error would surface as
 *     an unhandled rejection).
 *   - The offline-first `lookupIpLocation` path picks the German city
 *     name first, English second, with the country ISO code from
 *     `country` or `registered_country`.
 *
 * The MMDB Reader is mocked once at the top of the file; per-test
 * shape control happens through the `setReaderRow` + `setReaderThrows`
 * helpers below. The `fs` stub is also installed module-wide so the
 * lazy loader believes the DB exists.
 */

interface AsnRow {
  autonomous_system_number?: number;
  autonomous_system_organization?: string;
}

interface CityRow {
  city?: { names?: Record<string, string> };
  country?: { iso_code?: string };
  registered_country?: { iso_code?: string };
}

// Test-time spy state — captured by the mocked Reader. The Reader
// constructor inspects the buffer header to decide whether it's
// serving City or ASN rows.
const readerState = {
  city: null as ((ip: string) => CityRow | null) | null,
  asn: null as ((ip: string) => AsnRow | null) | null,
  cityThrows: false,
  asnThrows: false,
  cityExists: false,
  asnExists: false,
};

vi.mock("mmdb-lib", () => ({
  Reader: class {
    private kind: "city" | "asn";
    constructor(buf: Buffer) {
      const head = buf.toString("utf-8", 0, 4);
      this.kind = head === "city" ? "city" : "asn";
    }
    get(ip: string): AsnRow | CityRow | null {
      if (this.kind === "asn") {
        if (readerState.asnThrows) throw new Error("mmdb-asn boom");
        return readerState.asn ? readerState.asn(ip) : null;
      }
      if (readerState.cityThrows) throw new Error("mmdb-city boom");
      return readerState.city ? readerState.city(ip) : null;
    }
  },
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const existsSync = (p: string) => {
    if (p.endsWith("GeoLite2-City.mmdb")) return readerState.cityExists;
    if (p.endsWith("GeoLite2-ASN.mmdb")) return readerState.asnExists;
    return false;
  };
  const readFileSync = (p: string) => {
    if (p.endsWith("GeoLite2-City.mmdb"))
      return Buffer.from("city-mmdb-stub");
    if (p.endsWith("GeoLite2-ASN.mmdb"))
      return Buffer.from("asn-mmdb-stub");
    throw new Error(`unexpected read ${p}`);
  };
  return {
    ...actual,
    existsSync,
    readFileSync,
    default: { ...actual, existsSync, readFileSync },
  };
});

const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.IP_GEO_LOOKUP_DISABLED;
  delete process.env.GEOLITE2_DIR;
  readerState.city = null;
  readerState.asn = null;
  readerState.cityThrows = false;
  readerState.asnThrows = false;
  readerState.cityExists = false;
  readerState.asnExists = false;
  vi.resetModules();
  // Reset the lazy cache so each test gets a fresh Reader load.
  const mod = await import("../geo");
  mod.__resetGeoLite2CacheForTests();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("lookupIpAsn — offline ASN resolver (v1.4.27 B3)", () => {
  it("returns null for private + loopback addresses without touching the reader", async () => {
    const get = vi.fn();
    readerState.asn = get;
    readerState.asnExists = true;
    const { lookupIpAsn } = await import("../geo");

    expect(lookupIpAsn("10.0.0.5")).toBeNull();
    expect(lookupIpAsn("127.0.0.1")).toBeNull();
    expect(lookupIpAsn("::1")).toBeNull();
    expect(lookupIpAsn(null)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("returns null when the GeoLite2-ASN MMDB is missing", async () => {
    readerState.asnExists = false;
    const { lookupIpAsn } = await import("../geo");

    expect(lookupIpAsn("8.8.8.8")).toBeNull();
  });

  it("returns { asn, carrier } when the reader resolves a public IP", async () => {
    readerState.asnExists = true;
    readerState.asn = () => ({
      autonomous_system_number: 3320,
      autonomous_system_organization: "Deutsche Telekom AG",
    });
    const { lookupIpAsn } = await import("../geo");

    expect(lookupIpAsn("84.131.0.1")).toEqual({
      asn: 3320,
      carrier: "Deutsche Telekom AG",
    });
  });

  it("returns null when the reader has no row for the IP", async () => {
    readerState.asnExists = true;
    readerState.asn = () => null;
    const { lookupIpAsn } = await import("../geo");

    expect(lookupIpAsn("8.8.8.8")).toBeNull();
  });

  it("returns the asn with carrier=null when the org field is missing", async () => {
    readerState.asnExists = true;
    readerState.asn = () => ({ autonomous_system_number: 64500 });
    const { lookupIpAsn } = await import("../geo");

    expect(lookupIpAsn("8.8.8.8")).toEqual({ asn: 64500, carrier: null });
  });

  it("swallows reader throws and returns null (caller is fire-and-forget)", async () => {
    readerState.asnExists = true;
    readerState.asnThrows = true;
    const { lookupIpAsn } = await import("../geo");

    expect(lookupIpAsn("8.8.8.8")).toBeNull();
  });
});

describe("lookupIpLocation — offline-first city resolver (v1.4.27 B3)", () => {
  it("prefers the German exonym from the MMDB Names record", async () => {
    readerState.cityExists = true;
    readerState.city = () => ({
      city: { names: { de: "München", en: "Munich" } },
      country: { iso_code: "DE" },
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("85.214.0.1")).toBe("München, DE");
    // Offline hit — no online fallback was needed.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to the English city name when the German exonym is absent", async () => {
    readerState.cityExists = true;
    readerState.city = () => ({
      city: { names: { en: "Birmingham" } },
      country: { iso_code: "GB" },
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("212.58.224.1")).toBe("Birmingham, GB");
  });

  it("accepts the registered_country ISO when country is absent", async () => {
    readerState.cityExists = true;
    readerState.city = () => ({
      city: { names: { en: "Geneva" } },
      registered_country: { iso_code: "CH" },
    });
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("194.158.0.1")).toBe("Geneva, CH");
  });

  it("falls back to the online provider when the offline DB has no city/country", async () => {
    readerState.cityExists = true;
    readerState.city = () => ({ city: { names: {} } });
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        new TextEncoder().encode(
          JSON.stringify({ success: true, city: "Hamburg", country_code: "DE" }),
        ).buffer as ArrayBuffer,
        {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("8.8.8.8")).toBe("Hamburg, DE");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to the online provider when the offline DB is missing entirely", async () => {
    readerState.cityExists = false;
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        new TextEncoder().encode(
          JSON.stringify({ success: true, city: "Berlin", country_code: "DE" }),
        ).buffer as ArrayBuffer,
        {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("8.8.8.8")).toBe("Berlin, DE");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("skips the online fallback when IP_GEO_LOOKUP_DISABLED=1 and offline misses", async () => {
    process.env.IP_GEO_LOOKUP_DISABLED = "1";
    readerState.cityExists = false;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("8.8.8.8")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
