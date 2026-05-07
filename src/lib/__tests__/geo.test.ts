import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.IP_GEO_LOOKUP_URL;
  delete process.env.IP_GEO_LOOKUP_DISABLED;
  vi.resetModules();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

// V3 audit: /api/auth events were leaking IP + timestamp via plaintext
// HTTP to ip-api.com (GDPR Art. 32 + Art. 44). The lookup helper now
// (a) only egresses over HTTPS, (b) supports an opt-out env, and
// (c) accepts both ipwho.is and ip-api.com pro response shapes.
describe("lookupIpLocation IP-geolocation HTTPS guard", () => {
  it("returns null for private addresses without making any request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("10.0.0.5")).toBeNull();
    expect(await lookupIpLocation("127.0.0.1")).toBeNull();
    expect(await lookupIpLocation("::1")).toBeNull();
    expect(await lookupIpLocation(null)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null when IP_GEO_LOOKUP_DISABLED=1", async () => {
    process.env.IP_GEO_LOOKUP_DISABLED = "1";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("8.8.8.8")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses HTTPS by default (ipwho.is)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, city: "Berlin", country_code: "DE" }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("8.8.8.8")).toBe("Berlin, DE");
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url.startsWith("https://")).toBe(true);
  });

  it("refuses to call non-HTTPS configured providers", async () => {
    process.env.IP_GEO_LOOKUP_URL = "http://ip-api.com/json";
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    const result = await lookupIpLocation("8.8.8.8");
    expect(result).toBeNull();
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    // Even when an operator misconfigures HTTP, the helper rewrites the
    // URL to a deliberately invalid HTTPS URL so the egress is HTTPS-only.
    expect(url.startsWith("https://")).toBe(true);
  });

  it("accepts the ip-api pro response shape (status:'success', countryCode)", async () => {
    process.env.IP_GEO_LOOKUP_URL = "https://pro.ip-api.com/json";
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "success",
        city: "Hamburg",
        countryCode: "DE",
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("8.8.8.8")).toBe("Hamburg, DE");
  });
});
