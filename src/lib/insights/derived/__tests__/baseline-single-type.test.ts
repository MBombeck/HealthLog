/**
 * The usual-range band is built from one measurement type and never pools
 * another into it. Swept over every type, paired components (systolic and
 * diastolic) included: whichever read path the band takes (the DAY rollups or
 * the live day fold), every read names exactly the type asked for.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// The day reads pick each day's ladder-winning source; the user's ladder
// blob is read once per call. No account here has one, so the default ladders apply.
vi.mock("@/lib/rollups/measurement-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rollups/measurement-read")>()),
  loadUserSourcePriority: async () => null,
}));

const readDayAggregates = vi.fn();
const readBestGranularityRollups = vi.fn();
vi.mock("@/lib/measurements/day-aggregates", () => ({
  readDayAggregates: (a: unknown) => readDayAggregates(a),
}));
vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  readBestGranularityRollups: (...a: unknown[]) =>
    readBestGranularityRollups(...a),
}));

import { measurementTypeEnum } from "@/lib/validations/measurement";
import { PAIRED_METRICS } from "@/lib/measurements/paired-metrics";
import { computeVitalsBaseline } from "@/lib/insights/derived/baseline";
import type { MeasurementType } from "@/generated/prisma/client";

const NOW = new Date("2026-06-02T10:00:00Z");
const PROFILE = { ageYears: 40, sex: "MALE" as const };

beforeEach(() => {
  readDayAggregates.mockReset().mockResolvedValue([]);
  readBestGranularityRollups.mockReset().mockResolvedValue(null);
});

describe("usual-range band: one type per band", () => {
  it("covers every paired component", () => {
    const all = new Set<string>(measurementTypeEnum.options);
    for (const pair of PAIRED_METRICS) {
      for (const type of pair.components) expect(all.has(type)).toBe(true);
    }
  });

  it.each(measurementTypeEnum.options)(
    "%s reads only its own type on both paths",
    async (type) => {
      for (const covered of [true, false]) {
        readDayAggregates.mockClear();
        readBestGranularityRollups.mockClear();
        await computeVitalsBaseline("u1", PROFILE, {
          type: type as MeasurementType,
          now: NOW,
          coverage: new Map([[type as MeasurementType, covered]]),
        });
        const asked = [
          ...readDayAggregates.mock.calls.map(
            (c) => (c[0] as { type: string }).type,
          ),
          ...readBestGranularityRollups.mock.calls.map((c) => c[1] as string),
        ];
        expect(asked.length).toBeGreaterThan(0);
        expect(new Set(asked)).toEqual(new Set([type]));
      }
    },
  );
});
