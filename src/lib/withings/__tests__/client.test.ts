import { afterEach, describe, expect, it, vi } from "vitest";
import { MEASURE_TYPE_MAP, fetchMeasurements } from "../client";

/**
 * Withings client — meastype mapping + payload-parsing unit tests.
 *
 * Each new meastype gets a dedicated case that drives a synthetic
 * `measure-getmeas` payload through `fetchMeasurements()` and asserts the
 * mapped row shape. Edge cases (unknown type, missing exponent) live at
 * the end so a new mapping commit doesn't bloat the diff.
 */

interface FakeMeasure {
  type: number;
  value: number;
  unit: number;
}

function fakeGetmeasPayload(measures: FakeMeasure[], date = 1730000000) {
  return {
    status: 0,
    body: {
      updatetime: "2024-10-27T00:00:00Z",
      timezone: "Europe/Berlin",
      measuregrps: [
        {
          grpid: 1,
          attrib: 0,
          date,
          created: date,
          modified: date,
          measures,
        },
      ],
      more: false,
      offset: 0,
    },
  };
}

function installFetchMock(payload: unknown) {
  const fetchMock = vi.fn(async () => ({
    status: 200,
    json: async () => payload,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MEASURE_TYPE_MAP", () => {
  it("maps Withings meastype 12 (legacy Thermo) → BODY_TEMPERATURE", () => {
    expect(MEASURE_TYPE_MAP[12]).toEqual({ type: "BODY_TEMPERATURE" });
  });
});

describe("fetchMeasurements — temperature (meastype 12)", () => {
  it("decodes the value × 10^unit exponent and emits a BODY_TEMPERATURE row", async () => {
    // 36.8 °C encoded as Withings exponent shape: value=368, unit=-1.
    installFetchMock(fakeGetmeasPayload([{ type: 12, value: 368, unit: -1 }]));
    const out = await fetchMeasurements("token");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "BODY_TEMPERATURE", value: 36.8 });
  });

  it("skips an unknown meastype without throwing", async () => {
    installFetchMock(
      fakeGetmeasPayload([
        { type: 12, value: 368, unit: -1 },
        // 9999 is not in MEASURE_TYPE_MAP → must be ignored.
        { type: 9999, value: 1, unit: 0 },
      ]),
    );
    const out = await fetchMeasurements("token");
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("BODY_TEMPERATURE");
  });

  it("rounds to two decimals (Withings sometimes ships fractional exponents)", async () => {
    // 36.825 → stored as 36.83 once `parseFloat(value.toFixed(2))` runs.
    installFetchMock(fakeGetmeasPayload([{ type: 12, value: 36825, unit: -3 }]));
    const out = await fetchMeasurements("token");
    expect(out[0].value).toBe(36.83);
  });
});
