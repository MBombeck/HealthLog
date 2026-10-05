import { describe, it, expect, vi, beforeEach } from "vitest";

// Day-mean reads fold per-day aggregates in SQL; the fake folds the mocked
// `measurement.findMany` rows with the same rules.
vi.mock("@/lib/measurements/day-aggregates", async () => ({
  readDayAggregates: (
    await import("@/lib/measurements/__tests__/fake-day-aggregates")
  ).fakeReadDayAggregates,
}));

vi.mock("@/lib/db", () => ({
  prisma: { measurement: { findMany: vi.fn() } },
}));
vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  readBestGranularityRollups: vi.fn().mockResolvedValue(null),
}));
// v1.18.1 P4 — Rest Mode. Default inactive; the reframe test flips it active.
const restModeMock = vi.hoisted(() => ({
  resolveRestMode: vi.fn(async () => ({
    active: false as boolean,
    since: null as string | null,
    episodeCount: 0,
    episodes: [] as unknown[],
  })),
}));
vi.mock("@/lib/illness/rest-mode", () => restModeMock);

import { prisma } from "@/lib/db";
import {
  computeCoincidentDeviation,
  classifyDeviation,
  COINCIDENT_FIRE_THRESHOLD,
} from "../coincident-deviation";

const PROFILE = { ageYears: 40, sex: "MALE" as const };
const NOW = new Date("2026-06-02T08:00:00Z");
const findMany = prisma.measurement.findMany as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  restModeMock.resolveRestMode.mockResolvedValue({
    active: false,
    since: null,
    episodeCount: 0,
    episodes: [],
  });
});

/** RHR + HRV each flat, then a final day that pushes both outside the band. */
function firingRows(args: { where: { type: string } }) {
  const baseline = (base: number, outlier: number) => [
    ...Array.from({ length: 9 }, (_, i) => ({
      value: base,
      measuredAt: new Date(
        `2026-05-${String(15 + i).padStart(2, "0")}T07:00:00Z`,
      ),
    })),
    { value: outlier, measuredAt: new Date("2026-06-02T07:00:00Z") },
  ];
  if (args.where.type === "RESTING_HEART_RATE") return baseline(58, 95);
  if (args.where.type === "HEART_RATE_VARIABILITY") return baseline(60, 10);
  return [];
}

/** RHR + HRV each flat (banded but inside) — the no-fire-but-banded case. */
function quietBandedRows(args: { where: { type: string } }) {
  const flat = (base: number) =>
    Array.from({ length: 10 }, (_, i) => ({
      value: base,
      measuredAt: new Date(
        `2026-05-${String(15 + i).padStart(2, "0")}T07:00:00Z`,
      ),
    }));
  if (args.where.type === "RESTING_HEART_RATE") return flat(58);
  if (args.where.type === "HEART_RATE_VARIABILITY") return flat(60);
  return [];
}

describe("classifyDeviation", () => {
  it("flags above / below / in-band", () => {
    expect(classifyDeviation("PULSE", 90, 60, 80, 70).direction).toBe("above");
    expect(classifyDeviation("PULSE", 50, 60, 80, 70).direction).toBe("below");
    expect(classifyDeviation("PULSE", 70, 60, 80, 70).direction).toBe("in");
    expect(classifyDeviation("PULSE", 70, 60, 80, 70).outside).toBe(false);
  });
});

describe("computeCoincidentDeviation", () => {
  it("returns insufficient with fewer than two banded vitals", async () => {
    // Only one vital has a usable band.
    findMany.mockImplementation(async (args: { where: { type: string } }) => {
      if (args.where.type === "RESTING_HEART_RATE") {
        return Array.from({ length: 10 }, (_, i) => ({
          value: 58,
          measuredAt: new Date(
            `2026-05-${String(15 + i).padStart(2, "0")}T07:00:00Z`,
          ),
        }));
      }
      return [];
    });
    const result = await computeCoincidentDeviation("u1", PROFILE, {
      now: NOW,
    });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("too_few_banded_vitals");
    }
  });

  it("fires when ≥ 2 vitals sit outside their band on the latest day", async () => {
    // RHR + HRV each have a flat band, then a final outlier day that
    // pushes both outside the band.
    const baseline = (
      base: number,
      outlier: number,
    ): Array<{ value: number; measuredAt: Date }> => [
      ...Array.from({ length: 9 }, (_, i) => ({
        value: base,
        measuredAt: new Date(
          `2026-05-${String(15 + i).padStart(2, "0")}T07:00:00Z`,
        ),
      })),
      { value: outlier, measuredAt: new Date("2026-06-02T07:00:00Z") },
    ];
    findMany.mockImplementation(async (args: { where: { type: string } }) => {
      if (args.where.type === "RESTING_HEART_RATE") return baseline(58, 95);
      if (args.where.type === "HEART_RATE_VARIABILITY") return baseline(60, 10);
      return [];
    });
    const result = await computeCoincidentDeviation("u1", PROFILE, {
      now: NOW,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.contributing.length).toBeGreaterThanOrEqual(
        COINCIDENT_FIRE_THRESHOLD,
      );
      expect(result.value.fired).toBe(true);
    }
  });

  it("does not fire when vitals stay inside their bands", async () => {
    const flat = (base: number): Array<{ value: number; measuredAt: Date }> =>
      Array.from({ length: 10 }, (_, i) => ({
        value: base,
        measuredAt: new Date(
          `2026-05-${String(15 + i).padStart(2, "0")}T07:00:00Z`,
        ),
      }));
    findMany.mockImplementation(async (args: { where: { type: string } }) => {
      if (args.where.type === "RESTING_HEART_RATE") return flat(58);
      if (args.where.type === "HEART_RATE_VARIABILITY") return flat(60);
      return [];
    });
    const result = await computeCoincidentDeviation("u1", PROFILE, {
      now: NOW,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.fired).toBe(false);
    }
  });

  it("reframes a fired flag as illness-explained during Rest Mode (vitals unchanged)", async () => {
    restModeMock.resolveRestMode.mockResolvedValue({
      active: true,
      since: "2026-05-30T00:00:00.000Z",
      episodeCount: 1,
      episodes: [],
    });
    findMany.mockImplementation(firingRows);
    const result = await computeCoincidentDeviation("u1", PROFILE, {
      now: NOW,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.fired).toBe(true);
      // Reframed — but the measured deviations are untouched.
      expect(result.value.illnessExplained).toBe(true);
      expect(result.value.contributing.length).toBeGreaterThanOrEqual(
        COINCIDENT_FIRE_THRESHOLD,
      );
    }
  });

  it("keys 'today' in the user's timezone, not UTC (D2-8)", async () => {
    // A non-UTC user (UTC+2) logs both vitals at 23:30 UTC on Jun 2 — which is
    // 01:30 LOCAL on Jun 3. Under the old UTC slice the day key would read
    // "2026-06-02"; tz-aware it must read "2026-06-03", the user's real "today".
    const TZ = "Europe/Berlin"; // UTC+2 in summer
    const NOW_LATE = new Date("2026-06-02T23:45:00Z"); // 01:45 local Jun 3
    const baseline = (
      base: number,
      outlier: number,
    ): Array<{ value: number; measuredAt: Date }> => [
      ...Array.from({ length: 9 }, (_, i) => ({
        value: base,
        measuredAt: new Date(
          `2026-05-${String(15 + i).padStart(2, "0")}T07:00:00Z`,
        ),
      })),
      // 23:30 UTC Jun 2 == 01:30 local Jun 3.
      { value: outlier, measuredAt: new Date("2026-06-02T23:30:00Z") },
    ];
    findMany.mockImplementation(async (args: { where: { type: string } }) => {
      if (args.where.type === "RESTING_HEART_RATE") return baseline(58, 95);
      if (args.where.type === "HEART_RATE_VARIABILITY") return baseline(60, 10);
      return [];
    });
    const result = await computeCoincidentDeviation("u1", PROFILE, {
      now: NOW_LATE,
      tz: TZ,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.day).toBe("2026-06-03");
      expect(result.value.fired).toBe(true);
    }
  });

  it("does not resolve Rest Mode (no reframe) when the flag did not fire", async () => {
    // Banded but inside-band: the reframe must not even query Rest Mode.
    findMany.mockImplementation(quietBandedRows);
    const result = await computeCoincidentDeviation("u1", PROFILE, {
      now: NOW,
    });
    expect(result.status === "ok" && result.value.fired).toBe(false);
    expect(result.status === "ok" && result.value.illnessExplained).toBe(false);
    expect(restModeMock.resolveRestMode).not.toHaveBeenCalled();
  });
});

describe("glucose — a day in progress is compared with the same hours", () => {
  /** Fourteen whole days: fasting 85 at 07:00, then 160 and 150 after meals. */
  function glucoseDays(times: string[], values: number[]) {
    return Array.from({ length: 14 }, (_, i) =>
      times.map((time, j) => ({
        value: values[j],
        measuredAt: new Date(
          `2026-05-${String(18 + i).padStart(2, "0")}T${time}:00Z`,
        ),
      })),
    ).flat();
  }
  const rhrFlat = Array.from({ length: 10 }, (_, i) => ({
    value: 58,
    measuredAt: new Date(
      `2026-05-${String(20 + i).padStart(2, "0")}T06:00:00Z`,
    ),
  }));

  it("does not call a fasting morning 'below your range' against whole days", async () => {
    // 08:00 today: only the fasting reading is in. Against whole-day means
    // (~132) it read as below the range; against the same hours (85) it is
    // an ordinary morning.
    findMany.mockImplementation(async (args: { where: { type: string } }) => {
      if (args.where.type === "BLOOD_GLUCOSE") {
        return [
          ...glucoseDays(["07:00", "13:00", "19:00"], [85, 160, 150]),
          { value: 86, measuredAt: new Date("2026-06-02T07:00:00Z") },
        ];
      }
      if (args.where.type === "RESTING_HEART_RATE") return rhrFlat;
      return [];
    });
    const result = await computeCoincidentDeviation("u1", PROFILE, {
      now: NOW,
      tz: "UTC",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const glucose = result.value.vitals.find((v) => v.type === "BLOOD_GLUCOSE");
    expect(glucose).toBeDefined();
    expect(glucose!.daysAgo).toBe(0);
    expect(glucose!.value).toBe(86);
    expect(glucose!.direction).toBe("in");
    expect(glucose!.center).toBe(85);
  });

  it("still flags a morning that is low against earlier mornings", async () => {
    findMany.mockImplementation(async (args: { where: { type: string } }) => {
      if (args.where.type === "BLOOD_GLUCOSE") {
        return [
          ...glucoseDays(["07:00", "13:00", "19:00"], [85, 160, 150]),
          { value: 62, measuredAt: new Date("2026-06-02T07:00:00Z") },
        ];
      }
      if (args.where.type === "RESTING_HEART_RATE") return rhrFlat;
      return [];
    });
    const result = await computeCoincidentDeviation("u1", PROFILE, {
      now: NOW,
      tz: "UTC",
    });
    if (result.status !== "ok") throw new Error("expected ok");
    const glucose = result.value.vitals.find((v) => v.type === "BLOOD_GLUCOSE");
    expect(glucose!.direction).toBe("below");
  });

  it("says nothing about today when earlier days have no readings at this hour", async () => {
    findMany.mockImplementation(async (args: { where: { type: string } }) => {
      if (args.where.type === "BLOOD_GLUCOSE") {
        return [
          ...glucoseDays(["19:00"], [150]),
          { value: 86, measuredAt: new Date("2026-06-02T07:00:00Z") },
        ];
      }
      if (args.where.type === "RESTING_HEART_RATE") return rhrFlat;
      if (args.where.type === "HEART_RATE_VARIABILITY") {
        return rhrFlat.map((r) => ({ ...r, value: 60 }));
      }
      return [];
    });
    const result = await computeCoincidentDeviation("u1", PROFILE, {
      now: NOW,
      tz: "UTC",
    });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(
      result.value.vitals.find((v) => v.type === "BLOOD_GLUCOSE"),
    ).toBeUndefined();
  });
});
