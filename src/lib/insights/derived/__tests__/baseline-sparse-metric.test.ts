/**
 * A metric logged on a few days a month still gets a usual range. Blood
 * pressure from a cuff is the common case: years of readings, five reading
 * days in the last month. The band used to read only the trailing 30 days,
 * so it stayed "still learning" for good. Swept over every measurement type,
 * because the rule belongs to the band engine, not to blood pressure.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/rollups/measurement-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rollups/measurement-read")>()),
  loadUserSourcePriority: async () => null,
}));

/** Reading days, as offsets in days before NOW (one reading each). */
let readingDayOffsets: number[] = [];
const NOW = new Date("2026-11-27T10:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

vi.mock("@/lib/measurements/day-aggregates", () => ({
  readDayAggregates: async (opts: { since: Date }) =>
    readingDayOffsets
      .map((o) => new Date(NOW.getTime() - o * DAY))
      .filter((at) => at.getTime() >= opts.since.getTime())
      .sort((a, b) => a.getTime() - b.getTime())
      .map((at, i) => ({
        day: at.toISOString().slice(0, 10),
        n: 1,
        sum: VALUE_FOR(i),
        dayMean: null,
      })),
}));
vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  readBestGranularityRollups: async () => null,
}));

import { measurementTypeEnum } from "@/lib/validations/measurement";
import {
  BASELINE_MIN_HISTORY_DAYS,
  computeVitalsBaseline,
} from "@/lib/insights/derived/baseline";
import { plausibleMetricRange } from "@/lib/measurements/value-domain";
import type { MeasurementType } from "@/generated/prisma/client";

const PROFILE = { ageYears: 40, sex: "MALE" as const };
let VALUE_FOR: (i: number) => number = () => 1;

function plausibleValue(type: MeasurementType, i: number): number {
  const r = plausibleMetricRange(type);
  const lo = r?.min ?? 0;
  const hi = r?.max ?? lo + 100;
  return lo + ((hi - lo) / 2) * (1 + (i % 3) * 0.01);
}

// Five reading days in the last 30, two to four a month before that: the
// shape of a blood-pressure cuff used now and then.
const SPARSE = [
  2, 6, 11, 19, 27, 34, 41, 48, 55, 63, 70, 80, 95, 110, 130, 150, 200, 300,
];

beforeEach(() => {
  readingDayOffsets = [...SPARSE];
});

describe("usual range of a metric logged on a few days a month", () => {
  it.each(measurementTypeEnum.options)(
    "%s is banded from its newest reading days",
    async (t) => {
      const type = t as MeasurementType;
      VALUE_FOR = (i) => plausibleValue(type, i);
      const result = await computeVitalsBaseline("u1", PROFILE, {
        type,
        now: NOW,
        coverage: new Map(),
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.value.sampleDays).toBe(SPARSE.length);
      expect(result.value.sampleDays).toBeGreaterThanOrEqual(
        BASELINE_MIN_HISTORY_DAYS,
      );
    },
  );

  it("takes at most the newest 30 reading days", async () => {
    readingDayOffsets = [
      ...SPARSE.slice(0, 5),
      ...Array.from({ length: 60 }, (_, i) => 31 + i * 5),
    ];
    VALUE_FOR = (i) => 120 + (i % 3);
    const result = await computeVitalsBaseline("u1", PROFILE, {
      type: "BLOOD_PRESSURE_SYS",
      now: NOW,
      coverage: new Map(),
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.value.sampleDays).toBe(30);
  });

  it("a metric with nothing in the last 30 days stays without a band", async () => {
    readingDayOffsets = SPARSE.filter((o) => o > 30);
    VALUE_FOR = (i) => 120 + (i % 3);
    const result = await computeVitalsBaseline("u1", PROFILE, {
      type: "BLOOD_PRESSURE_SYS",
      now: NOW,
      coverage: new Map(),
    });
    expect(result.status).toBe("insufficient");
  });

  it("a caller that pins its window gets exactly that window", async () => {
    VALUE_FOR = (i) => 120 + (i % 3);
    const result = await computeVitalsBaseline("u1", PROFILE, {
      type: "BLOOD_PRESSURE_SYS",
      now: NOW,
      windowDays: 30,
      coverage: new Map(),
    });
    expect(result.status).toBe("insufficient");
  });
});
