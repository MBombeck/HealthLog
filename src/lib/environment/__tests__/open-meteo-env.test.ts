import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Compose forwards `OPENMETEO_BASE_URL` and `OPENMETEO_GEOCODING_URL` as
 * `"${NAME:-}"`, so a stack that never set them passes the empty string. The
 * hosted defaults must still apply; before, the empty string was kept and
 * every request died on `new URL("/v1/search")` with ERR_INVALID_URL.
 */
// The instance-wide request budget lives in Postgres; these tests are about
// the request itself, so the budget admits every call.
vi.mock("@/lib/environment/request-budget", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/environment/request-budget")
  >()),
  reserveOpenMeteoCalls: vi.fn(async () => true),
}));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Open-Meteo base URLs under compose-style empty values", () => {
  it("uses the hosted geocoding endpoint when the variable is empty", async () => {
    vi.stubEnv("OPENMETEO_GEOCODING_URL", "");
    vi.stubEnv("OPENMETEO_BASE_URL", "");
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(Response.json({ results: [] }, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { geocodeLocation } = await import("../open-meteo");

    await expect(geocodeLocation("Bochum")).resolves.toEqual([]);
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(
      url.startsWith("https://geocoding-api.open-meteo.com/v1/search?"),
    ).toBe(true);
  });

  it("still honours a configured self-hosted endpoint", async () => {
    vi.stubEnv("OPENMETEO_GEOCODING_URL", "https://meteo.example.test/");
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(Response.json({ results: [] }, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { geocodeLocation } = await import("../open-meteo");

    await geocodeLocation("Bochum");
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url.startsWith("https://meteo.example.test/v1/search?")).toBe(true);
  });
});
