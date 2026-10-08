import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * v1.39.4 — the environment module stores coordinates at 1 decimal (about
 * 11 km), not 2 (about 1 km). The geocoder is where a picked city's
 * coordinates enter, so its results must already be coarse.
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

describe("coarse location", () => {
  it("rounds a coordinate to one decimal", async () => {
    const { roundCoarse } = await import("../open-meteo");
    expect(roundCoarse(52.5163)).toBe(52.5);
    expect(roundCoarse(13.3777)).toBe(13.4);
    expect(roundCoarse(-33.8688)).toBe(-33.9);
    // Already coarse values pass through unchanged.
    expect(roundCoarse(48.1)).toBe(48.1);
  });

  it("hands back geocoding results at one decimal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            results: [
              {
                name: "Berlin",
                latitude: 52.52437,
                longitude: 13.41053,
                country: "Germany",
                timezone: "Europe/Berlin",
              },
            ],
          },
          { status: 200 },
        ),
      ),
    );
    const { geocodeLocation } = await import("../open-meteo");
    const [hit] = await geocodeLocation("Berlin");
    expect(hit).toMatchObject({ lat: 52.5, lon: 13.4 });
  });
});
