/**
 * v1.42 (#615) — `get_environment` for the Coach and MCP.
 *
 *  - the module switch answers `module_disabled` before a row is read;
 *  - no coordinate, no place name and no label leaves in any key, however
 *    the stored row is filled;
 *  - with the air-quality part off (by the account or the operator) every
 *    air-quality field is absent, not null-filled; on, an unfetched day says
 *    null, never zero;
 *  - the window is clamped to the lookback limit, and the summary counts with
 *    the shared day flags.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  moduleOn: true,
  airEnabled: true,
  rows: [] as Array<Record<string, unknown>>,
  findMany: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: vi.fn(async () => state.moduleOn),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({
        environmentAirQualityEnabled: state.airEnabled,
      })),
    },
    environmentContext: {
      findMany: vi.fn(async (args: Record<string, unknown>) => {
        state.findMany.push(args);
        return state.rows;
      }),
      aggregate: vi.fn(async () => ({
        _count: { _all: 0 },
        _min: { date: null },
        _max: { date: null },
      })),
    },
  },
}));

import { prisma } from "@/lib/db";
import { readEnvironmentForTool } from "../environment-read";
import { UNBOUNDED_REACH } from "@/lib/ai/coach/history-reach";

const NOW = new Date("2026-10-08T06:00:00Z");

function storedDay(date: string, extra: Record<string, unknown> = {}) {
  return {
    date,
    source: "HOME",
    // A row as the database might still hold it; none of this may leave.
    lat: 51.5,
    lon: 7.2,
    locationLabel: "Bochum, Germany",
    tempMin: 12,
    tempMax: 21,
    tempMean: 16.44,
    apparentMax: 22,
    precipSum: 0,
    sunshineSec: 7200,
    pressureMean: 1013.27,
    pressureDelta: 2,
    humidityMean: 70.12,
    pm25Mean: 8,
    pm25Max: 15,
    pm10Mean: 12,
    no2Mean: 9,
    o3Max8h: 70,
    eaqiMax: 35,
    uvIndexMax: 4,
    dustMax: 1,
    pollenAlderMax: 0,
    pollenBirchMax: 120,
    pollenGrassMax: null,
    pollenMugwortMax: 0,
    pollenOliveMax: 0,
    pollenRagweedMax: 0,
    aqFetchedAt: new Date("2026-10-07T02:10:00Z"),
    aqHours: 24,
    ...extra,
  };
}

/** Every key anywhere in a value. */
function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

beforeEach(() => {
  state.moduleOn = true;
  state.airEnabled = true;
  state.findMany = [];
  state.rows = [
    storedDay("2026-10-05"),
    storedDay("2026-10-06", {
      source: "TRAVEL",
      tempMin: 21,
      eaqiMax: 82,
      pollenBirchMax: 3,
    }),
    storedDay("2026-10-07", { aqFetchedAt: null, aqHours: null }),
  ];
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());

describe("readEnvironmentForTool", () => {
  it("answers module_disabled without reading a row", async () => {
    state.moduleOn = false;
    const result = await readEnvironmentForTool({
      userId: "u1",
      window: "last30days",
      reach: UNBOUNDED_REACH,
      now: NOW,
    });
    expect(result).toEqual({ present: false, reason: "module_disabled" });
    expect(prisma.environmentContext.findMany).not.toHaveBeenCalled();
  });

  it("never carries a coordinate, a place name or a label", async () => {
    const result = await readEnvironmentForTool({
      userId: "u1",
      window: "last30days",
      reach: UNBOUNDED_REACH,
      now: NOW,
    });
    expect(result.present).toBe(true);
    const keys = keysDeep(result);
    for (const forbidden of [
      "lat",
      "lon",
      "label",
      "locationLabel",
      "locationEncrypted",
      "homeLabel",
    ]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    expect(JSON.stringify(result)).not.toContain("Bochum");
    // The read does not even select the location columns.
    const select = state.findMany[0].select as Record<string, boolean>;
    expect(select.lat).toBeUndefined();
    expect(select.locationEncrypted).toBeUndefined();
  });

  it("counts with the shared flags and says an unfetched day is null", async () => {
    const result = await readEnvironmentForTool({
      userId: "u1",
      window: "last30days",
      reach: UNBOUNDED_REACH,
      now: NOW,
    });
    if (!result.present) throw new Error("expected data");
    expect(result.data.coverage).toEqual({
      firstDate: "2026-10-05",
      lastDate: "2026-10-07",
      days: 3,
      awayDays: 1,
      airQualityDays: 2,
    });
    expect(result.data.summary).toEqual({
      hotNights: 1,
      veryPoorAirDays: 1,
      highPollenDays: 1,
      pollenPeak: 120,
    });
    expect(result.data.daily[2].airQuality).toBeNull();
    expect(result.data.daily[0].airQuality?.pollen.grass).toBeNull();
    expect(result.data.airQuality).toBe("on");
    expect(result.data.attributions).toHaveLength(3);
    expect(result.data.provenance.note).toMatch(
      /not the person's own exposure/,
    );
  });

  it("leaves every air-quality field out when the account turned it off", async () => {
    state.airEnabled = false;
    const result = await readEnvironmentForTool({
      userId: "u1",
      window: "last30days",
      reach: UNBOUNDED_REACH,
      now: NOW,
    });
    if (!result.present) throw new Error("expected data");
    const keys = keysDeep(result.data.daily);
    expect(keys.has("airQuality")).toBe(false);
    expect(keys.has("pm25Mean")).toBe(false);
    expect(result.data.summary).toEqual({ hotNights: 1 });
    expect(result.data.coverage.airQualityDays).toBeUndefined();
    expect(result.data.airQuality).toBe("off_account");
    expect(result.data.attributions).toHaveLength(1);
  });

  it("says when the operator turned it off", async () => {
    vi.stubEnv("ENVIRONMENT_AIR_QUALITY_DISABLED", "1");
    const result = await readEnvironmentForTool({
      userId: "u1",
      window: "last30days",
      reach: UNBOUNDED_REACH,
      now: NOW,
    });
    if (!result.present) throw new Error("expected data");
    expect(result.data.airQuality).toBe("off_operator");
    expect(keysDeep(result.data.daily).has("pm25Mean")).toBe(false);
  });

  it("clamps the window to the lookback limit", async () => {
    const result = await readEnvironmentForTool({
      userId: "u1",
      window: "allTime",
      reach: { window: "last7days", days: 7 },
      now: NOW,
    });
    if (!result.present) throw new Error("expected data");
    expect(result.data.window).toBe("last7days");
    const where = state.findMany[0].where as { date: { gte: string } };
    expect(where.date.gte).toBe("2026-10-02");
  });

  it("answers no_data for an account with nothing stored", async () => {
    state.rows = [];
    const result = await readEnvironmentForTool({
      userId: "u1",
      window: "last30days",
      reach: UNBOUNDED_REACH,
      now: NOW,
    });
    expect(result).toEqual({ present: false, reason: "no_data" });
  });
});
