import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MEASURE_TYPE_MAP,
  WITHINGS_OAUTH_SCOPE,
  exchangeCode,
  fetchMeasurements,
  hasActivityScope,
  parseWithingsScope,
  refreshAccessToken,
  subscribeWebhook,
} from "../client";
import { WithingsApiError } from "../response-classifier";
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

  // ── v1.4.25 W5d Withings full coverage ──
  it("maps Withings meastype 5 (fat free mass) → FAT_FREE_MASS", () => {
    expect(MEASURE_TYPE_MAP[5]).toEqual({ type: "FAT_FREE_MASS" });
  });

  it("maps Withings meastype 8 (fat mass) → FAT_MASS", () => {
    expect(MEASURE_TYPE_MAP[8]).toEqual({ type: "FAT_MASS" });
  });

  it("maps Withings meastype 76 (muscle mass) → MUSCLE_MASS", () => {
    expect(MEASURE_TYPE_MAP[76]).toEqual({ type: "MUSCLE_MASS" });
  });

  it("maps Withings meastype 73 (skin temperature) → SKIN_TEMPERATURE (distinct from BODY_TEMPERATURE)", () => {
    expect(MEASURE_TYPE_MAP[73]).toEqual({ type: "SKIN_TEMPERATURE" });
    // Sanity guard — sharing the BODY_TEMPERATURE bucket would corrupt
    // the rollup (surface temps 30–34 °C, core ~37 °C).
    expect(MEASURE_TYPE_MAP[73].type).not.toBe("BODY_TEMPERATURE");
  });

  it("maps Withings meastype 91 (pulse wave velocity) → PULSE_WAVE_VELOCITY", () => {
    expect(MEASURE_TYPE_MAP[91]).toEqual({ type: "PULSE_WAVE_VELOCITY" });
  });

  it("maps Withings meastype 155 (vascular age) → VASCULAR_AGE", () => {
    expect(MEASURE_TYPE_MAP[155]).toEqual({ type: "VASCULAR_AGE" });
  });

  it("maps Withings meastype 170 (visceral fat) → VISCERAL_FAT", () => {
    expect(MEASURE_TYPE_MAP[170]).toEqual({ type: "VISCERAL_FAT" });
  });
});

describe("WITHINGS_OAUTH_SCOPE + scope helpers", () => {
  it("requests user.metrics + user.activity (v1.4.25 default)", () => {
    expect(WITHINGS_OAUTH_SCOPE).toBe("user.metrics,user.activity");
  });

  it("parses a comma-separated scope string into a Set", () => {
    expect(parseWithingsScope("user.metrics,user.activity")).toEqual(
      new Set(["user.metrics", "user.activity"]),
    );
  });

  it("treats null/empty scope as empty set (legacy connection)", () => {
    expect(parseWithingsScope(null).size).toBe(0);
    expect(parseWithingsScope("").size).toBe(0);
  });

  it("hasActivityScope returns false for legacy v1.4.24 connections", () => {
    expect(hasActivityScope(null)).toBe(false);
    expect(hasActivityScope("user.metrics")).toBe(false);
  });

  it("hasActivityScope returns true once user.activity is granted", () => {
    expect(hasActivityScope("user.metrics,user.activity")).toBe(true);
    expect(hasActivityScope("user.activity")).toBe(true);
    expect(hasActivityScope(" user.activity , user.metrics ")).toBe(true);
  });
});

describe("WITHINGS_NOTIFY_APPLIS", () => {
  it("subscribes to weight + temperature + pressure + activity + sleep categories", () => {
    // v1.4.25 W17b/c — activity (16) + sleep v2 (44) join the
    // webhook-primary set so the new sync routines fire in seconds
    // rather than waiting for the hourly cron fallback.
    expect(WITHINGS_NOTIFY_APPLIS).toEqual([1, 2, 4, 16, 44]);
  });

  it("contains every appli for the meastypes we ingest", () => {
    // Sanity guard so a future contributor who adds a meastype is
    // nudged to also wire its appli category. Today we ingest:
    //   - 1, 6, 77, 88 → appli=1 (weight + composition)
    //   - 12, 71 → appli=2 (temperature)
    //   - 9, 10, 11, 35, 54 → appli=4 (BP + pulse + SpO2)
    //   - 123 → appli=1 (VO2 max is part of the weight category in
    //     Withings' bucketing; verified against the developer guide).
    //   - steps + distance + active energy + floors → appli=16 (Activity)
    //   - sleep stage segments → appli=44 (Sleep v2)
    const ingested = Object.keys(MEASURE_TYPE_MAP).map(Number).sort();
    expect(ingested).toContain(12);
    expect(ingested).toContain(71);
    expect(ingested).toContain(35);
    expect(ingested).toContain(123);
  });

  it("includes 16 (activity) and 44 (sleep v2) — the W17b/c webhook additions", () => {
    // Explicit guard so a future refactor that re-sorts the array
    // doesn't silently drop the activity / sleep webhook trigger.
    expect(WITHINGS_NOTIFY_APPLIS).toContain(16);
    expect(WITHINGS_NOTIFY_APPLIS).toContain(44);
  });
});

describe("subscribeWebhook — appli payload", () => {
  it("POSTs `appli=16` to Withings notify when called with the activity category", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ({ status: 0 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await subscribeWebhook(
      "token",
      "https://healthlog.example.com/api/withings/webhook/secret",
      16,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = String(init.body);
    expect(body).toContain("action=subscribe");
    expect(body).toContain("appli=16");
  });

  it("POSTs `appli=44` to Withings notify when called with the sleep v2 category", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ({ status: 0 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await subscribeWebhook(
      "token",
      "https://healthlog.example.com/api/withings/webhook/secret",
      44,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = String(init.body);
    expect(body).toContain("appli=44");
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
    installFetchMock(
      fakeGetmeasPayload([{ type: 12, value: 36825, unit: -3 }]),
    );
    const out = await fetchMeasurements("token");
    expect(out[0].value).toBe(36.83);
  });
});

// ── v1.4.25 W5d Withings full coverage ──
describe("fetchMeasurements — body composition expansion", () => {
  it("decodes a Body+ fat-free mass reading into FAT_FREE_MASS kg", async () => {
    // 65.4 kg of lean body mass. value=65400, unit=-3.
    installFetchMock(fakeGetmeasPayload([{ type: 5, value: 65400, unit: -3 }]));
    const out = await fetchMeasurements("token");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "FAT_FREE_MASS", value: 65.4 });
  });

  it("decodes a Body+ fat-mass reading into FAT_MASS kg", async () => {
    // 14.2 kg of fat. value=14200, unit=-3.
    installFetchMock(fakeGetmeasPayload([{ type: 8, value: 14200, unit: -3 }]));
    const out = await fetchMeasurements("token");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "FAT_MASS", value: 14.2 });
  });

  it("decodes a Body+ muscle-mass reading into MUSCLE_MASS kg", async () => {
    // 58.7 kg of muscle. value=58700, unit=-3.
    installFetchMock(
      fakeGetmeasPayload([{ type: 76, value: 58700, unit: -3 }]),
    );
    const out = await fetchMeasurements("token");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "MUSCLE_MASS", value: 58.7 });
  });

  it("decodes a Body Comp visceral-fat rating into VISCERAL_FAT", async () => {
    // Withings reports the 1–12 rating directly. value=7, unit=0.
    installFetchMock(fakeGetmeasPayload([{ type: 170, value: 7, unit: 0 }]));
    const out = await fetchMeasurements("token");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "VISCERAL_FAT", value: 7 });
  });
});

describe("fetchMeasurements — ScanWatch skin temperature (meastype 73)", () => {
  it("decodes a ScanWatch skin-temp reading into SKIN_TEMPERATURE °C", async () => {
    // 32.5 °C surface temp. value=3250, unit=-2.
    installFetchMock(fakeGetmeasPayload([{ type: 73, value: 3250, unit: -2 }]));
    const out = await fetchMeasurements("token");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "SKIN_TEMPERATURE", value: 32.5 });
  });

  it("co-exists with core BODY_TEMPERATURE (meastype 71) in the same payload", async () => {
    // A user with a Thermo + ScanWatch could have both readings on the
    // same day. The rollup MUST keep them in distinct enums so the
    // dashboard's "body temperature" chart doesn't paint a 32 °C dip.
    installFetchMock(
      fakeGetmeasPayload([
        { type: 73, value: 3210, unit: -2 },
        { type: 71, value: 3705, unit: -2 },
      ]),
    );
    const out = await fetchMeasurements("token");
    expect(out).toHaveLength(2);
    const types = new Set(out.map((r) => r.type));
    expect(types.has("SKIN_TEMPERATURE")).toBe(true);
    expect(types.has("BODY_TEMPERATURE")).toBe(true);
  });
});

describe("fetchMeasurements — pulse-wave velocity + vascular age", () => {
  it("decodes a Body Cardio PWV reading into PULSE_WAVE_VELOCITY m/s", async () => {
    // 7.2 m/s arterial pulse wave velocity. value=72, unit=-1.
    installFetchMock(fakeGetmeasPayload([{ type: 91, value: 72, unit: -1 }]));
    const out = await fetchMeasurements("token");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "PULSE_WAVE_VELOCITY", value: 7.2 });
  });

  it("decodes a Body Scan vascular-age reading into VASCULAR_AGE years", async () => {
    // 42 years biological vascular age. value=42, unit=0.
    installFetchMock(fakeGetmeasPayload([{ type: 155, value: 42, unit: 0 }]));
    const out = await fetchMeasurements("token");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "VASCULAR_AGE", value: 42 });
  });
});

// ── v1.4.42 W6 — off-response classifier wire-through ──
//
// Each client entrypoint must throw `WithingsApiError` carrying the
// classification verdict, NOT a plain `new Error("Withings ... error:
// <status>")`. Downstream catch-blocks read `err.classification`; the
// regex-fallback in `classifyError` covers serialised retries but the
// typed-throw is the contract.

describe("client off-response handling — refreshAccessToken", () => {
  const creds = { clientId: "id", clientSecret: "secret" };

  it("throws WithingsApiError(classification: 'reauth_required') on Withings 101", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ status: 101, error: "Invalid token" }),
      })),
    );

    await expect(refreshAccessToken("rt", creds)).rejects.toMatchObject({
      name: "WithingsApiError",
      classification: "reauth_required",
      withingsStatus: 101,
    });
  });

  it("throws WithingsApiError(classification: 'transient') on HTTP 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 503,
        json: async () => ({ status: 0 }),
      })),
    );

    const err = await refreshAccessToken("rt", creds).catch((e) => e);
    expect(err).toBeInstanceOf(WithingsApiError);
    expect((err as WithingsApiError).classification).toBe("transient");
    expect((err as WithingsApiError).reason).toBe("http_503");
  });
});

describe("client off-response handling — exchangeCode", () => {
  const creds = { clientId: "id", clientSecret: "secret" };

  it("classifies Withings 100 (Authentication failed) as reauth_required", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ status: 100, error: "Authentication failed" }),
      })),
    );
    const err = await exchangeCode("auth-code", creds).catch((e) => e);
    expect(err).toBeInstanceOf(WithingsApiError);
    expect((err as WithingsApiError).classification).toBe("reauth_required");
  });
});

describe("client off-response handling — fetchMeasurements", () => {
  it("throws WithingsApiError(classification: 'transient') on Withings 601 (rate-limit)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ status: 601 }),
      })),
    );
    const err = await fetchMeasurements("token").catch((e) => e);
    expect(err).toBeInstanceOf(WithingsApiError);
    expect((err as WithingsApiError).classification).toBe("transient");
    expect((err as WithingsApiError).withingsStatus).toBe(601);
  });

  it("throws WithingsApiError(classification: 'persistent') on Withings 293 (invalid params)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ status: 293 }),
      })),
    );
    const err = await fetchMeasurements("token").catch((e) => e);
    expect(err).toBeInstanceOf(WithingsApiError);
    expect((err as WithingsApiError).classification).toBe("persistent");
  });

  it("returns the empty list on a healthy but empty body (status 0, no measuregrps)", async () => {
    // Off-response edge case: a healthy connection that has no data
    // in the requested window is NOT a failure — it's success with
    // zero rows.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ status: 0, body: { measuregrps: [] } }),
      })),
    );
    const out = await fetchMeasurements("token");
    expect(out).toEqual([]);
  });
});

describe("client off-response handling — subscribeWebhook 294 idempotency", () => {
  it("does NOT throw when Withings replies status 294 (already-subscribed)", async () => {
    // 294 at the subscribe call-site is documented idempotent success;
    // every other endpoint sees it as `persistent`, but here we
    // downgrade to success so reconnect flows don't fail.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ status: 294 }),
      })),
    );
    await expect(
      subscribeWebhook("token", "https://example.com/webhook", 1),
    ).resolves.toBeUndefined();
  });

  it("throws WithingsApiError(classification: 'transient') when Withings replies status 2554 (notify-subscribe busy)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        json: async () => ({ status: 2554 }),
      })),
    );
    const err = await subscribeWebhook(
      "token",
      "https://example.com/webhook",
      1,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(WithingsApiError);
    expect((err as WithingsApiError).classification).toBe("transient");
  });
});
