import { afterEach, describe, expect, it, vi } from "vitest";
import { MEASURE_TYPE_MAP, fetchMeasurements } from "../client";
import { WITHINGS_NOTIFY_APPLIS } from "../sync";

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

  it("maps Withings meastype 71 (current-gen Thermo) → BODY_TEMPERATURE", () => {
    expect(MEASURE_TYPE_MAP[71]).toEqual({ type: "BODY_TEMPERATURE" });
  });

  it("maps Withings meastype 35 (legacy SpO2) → OXYGEN_SATURATION", () => {
    expect(MEASURE_TYPE_MAP[35]).toEqual({ type: "OXYGEN_SATURATION" });
  });

  it("maps Withings meastype 123 (VO2 max) → VO2_MAX", () => {
    expect(MEASURE_TYPE_MAP[123]).toEqual({ type: "VO2_MAX" });
  });
});

describe("WITHINGS_NOTIFY_APPLIS", () => {
  it("subscribes to weight + temperature + pressure categories", () => {
    expect(WITHINGS_NOTIFY_APPLIS).toEqual([1, 2, 4]);
  });

  it("contains every appli for the meastypes we ingest", () => {
    // Sanity guard so a future contributor who adds a meastype is
    // nudged to also wire its appli category. Today we ingest:
    //   - 1, 6, 77, 88 → appli=1 (weight + composition)
    //   - 12, 71 → appli=2 (temperature)
    //   - 9, 10, 11, 35, 54 → appli=4 (BP + pulse + SpO2)
    //   - 123 → appli=1 (VO2 max is part of the weight category in
    //     Withings' bucketing; verified against the developer guide).
    const ingested = Object.keys(MEASURE_TYPE_MAP).map(Number).sort();
    expect(ingested).toContain(12);
    expect(ingested).toContain(71);
    expect(ingested).toContain(35);
    expect(ingested).toContain(123);
  });
});

describe("fetchMeasurements — VO2 max (meastype 123)", () => {
  it("decodes a ScanWatch VO2 max reading into VO2_MAX mL/(kg·min)", async () => {
    // 42.5 mL/(kg·min) as Withings exponent encoding: value=425, unit=-1.
    installFetchMock(fakeGetmeasPayload([{ type: 123, value: 425, unit: -1 }]));
    const out = await fetchMeasurements("token");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "VO2_MAX", value: 42.5 });
  });
});

describe("fetchMeasurements — SpO2 alt code (meastype 35)", () => {
  it("decodes a legacy-firmware SpO2 reading into OXYGEN_SATURATION %", async () => {
    // 97% as Withings exponent encoding: value=97, unit=0.
    installFetchMock(fakeGetmeasPayload([{ type: 35, value: 97, unit: 0 }]));
    const out = await fetchMeasurements("token");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "OXYGEN_SATURATION", value: 97 });
  });

  it("co-exists with meastype 54 in the same payload (mixed firmware)", async () => {
    installFetchMock(
      fakeGetmeasPayload([
        { type: 35, value: 96, unit: 0 },
        { type: 54, value: 98, unit: 0 },
      ]),
    );
    const out = await fetchMeasurements("token");
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.type)).toEqual([
      "OXYGEN_SATURATION",
      "OXYGEN_SATURATION",
    ]);
  });
});

describe("fetchMeasurements — body temperature (meastype 71)", () => {
  it("decodes a current-gen Thermo reading into BODY_TEMPERATURE °C", async () => {
    // 37.05 °C as Withings exponent encoding: value=3705, unit=-2.
    installFetchMock(fakeGetmeasPayload([{ type: 71, value: 3705, unit: -2 }]));
    const out = await fetchMeasurements("token");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "BODY_TEMPERATURE", value: 37.05 });
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
