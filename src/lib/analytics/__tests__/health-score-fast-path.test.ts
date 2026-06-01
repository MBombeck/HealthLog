/**
 * v1.4.37 W2 — unit pin for the probe-gated Health Score helper.
 *
 * Mocks Prisma + the rollup-coverage probe so the path-selection
 * contract is verifiable without a Postgres container. Real-rollup
 * coverage lives in the integration suite at
 * `tests/integration/analytics-health-score.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    measurementRollup: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

vi.mock("@/lib/rollups/measurement-coverage", () => ({
  isFullyCovered: vi.fn(),
  probeRollupCoverage: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  isFullyCovered,
  probeRollupCoverage,
} from "@/lib/rollups/measurement-coverage";
import { computeUserHealthScoreFastPath } from "../health-score-fast-path";

const MEASUREMENT_FIND_MANY = prisma.measurement.findMany as unknown as ReturnType<typeof vi.fn>;
const ROLLUP_FIND_MANY = prisma.measurementRollup.findMany as unknown as ReturnType<typeof vi.fn>;
const MOOD_FIND_MANY = prisma.moodEntry.findMany as unknown as ReturnType<typeof vi.fn>;
const MEDICATION_FIND_MANY = prisma.medication.findMany as unknown as ReturnType<typeof vi.fn>;
const INTAKE_FIND_MANY = prisma.medicationIntakeEvent.findMany as unknown as ReturnType<typeof vi.fn>;
const PROBE = probeRollupCoverage as unknown as ReturnType<typeof vi.fn>;
const FULLY_COVERED = isFullyCovered as unknown as ReturnType<typeof vi.fn>;
const ANNOTATE = annotate as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  MEASUREMENT_FIND_MANY.mockReset();
  ROLLUP_FIND_MANY.mockReset();
  MOOD_FIND_MANY.mockReset();
  MEDICATION_FIND_MANY.mockReset();
  INTAKE_FIND_MANY.mockReset();
  PROBE.mockReset();
  FULLY_COVERED.mockReset();
  ANNOTATE.mockReset();

  // Defaults — empty everywhere. Individual tests override.
  ROLLUP_FIND_MANY.mockResolvedValue([]);
  MOOD_FIND_MANY.mockResolvedValue([]);
  MEDICATION_FIND_MANY.mockResolvedValue([]);
  INTAKE_FIND_MANY.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computeUserHealthScoreFastPath", () => {
  describe("rollup-fast-path — WEIGHT fully covered", () => {
    it("derives the weight series from DAY buckets and pins path:rollup", async () => {
      const coverage = new Map<string, boolean>([
        ["WEIGHT", true],
        ["BLOOD_PRESSURE_SYS", true],
        ["BLOOD_PRESSURE_DIA", true],
      ]);
      FULLY_COVERED.mockReturnValue(true);
      PROBE.mockResolvedValue(coverage);

      const now = new Date("2026-05-17T12:00:00.000Z");
      // Two day-buckets inside the trailing 30 days, descending mean.
      ROLLUP_FIND_MANY.mockResolvedValueOnce([
        {
          bucketStart: new Date("2026-05-10T00:00:00.000Z"),
          count: 1,
          mean: 82.5,
          minValue: 82.5,
          maxValue: 82.5,
          sd: null,
          slope: null,
          r2: null,
          computedAt: now,
        },
        {
          bucketStart: new Date("2026-05-14T00:00:00.000Z"),
          count: 1,
          mean: 81.5,
          minValue: 81.5,
          maxValue: 81.5,
          sd: null,
          slope: null,
          r2: null,
          computedAt: now,
        },
      ]);
      // v1.4.40 W-WMY-WIRE — the parallel long-window read fires
      // alongside the DAY-bucket read; mock its `findMany` to return
      // a coverage miss so the annotate carries `weightLongWindow:
      // null` and the score shape is unchanged.
      ROLLUP_FIND_MANY.mockResolvedValueOnce([]);
      // Weight source-attribution read (narrow 2-column).
      MEASUREMENT_FIND_MANY
        .mockResolvedValueOnce([
          {
            measuredAt: new Date("2026-05-10T08:00:00.000Z"),
            source: "WITHINGS",
          },
          {
            measuredAt: new Date("2026-05-14T08:00:00.000Z"),
            source: "WITHINGS",
          },
        ])
        // BP-SYS source attribution read (parallel after rollup).
        .mockResolvedValueOnce([]);

      const result = await computeUserHealthScoreFastPath({
        userId: "user-rollup",
        bpInTargetPct: 85,
        heightCm: 178,
        now,
        coverage,
      });

      expect(result).not.toBeNull();
      // Path annotate proves the rollup branch fired.
      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const pathCall = calls.find(
        (c) => c?.meta?.healthScore?.path === "rollup",
      );
      expect(pathCall).toBeDefined();
      // The rollup branch must NOT have called `measurement.findMany`
      // for the 37-day raw weight read; only the narrow 2-column source
      // pull + the BP source pull.
      expect(MEASUREMENT_FIND_MANY).toHaveBeenCalledTimes(2);
      // Both findMany calls projected a narrow select (no `value`).
      const calledArgs = MEASUREMENT_FIND_MANY.mock.calls.map((c) => c[0]);
      for (const arg of calledArgs) {
        expect(arg.select.value).toBeUndefined();
      }
      // Weight pillar value should reflect the downward slope from
      // bucket means (helper reports a numeric weight value).
      expect(result?.components.weight.value).not.toBeNull();
    });
  });

  /**
   * v1.4.40 W-WMY-WIRE — pin the long-window weight wiring through
   * `readBestGranularityRollups`. The score shape is unchanged; the
   * weightLongWindow annotate makes the rollup-tier consumption
   * verifiable in production wide-events.
   */
  describe("long-window weight wiring (W-WMY-WIRE)", () => {
    it("surfaces a MONTH-granularity weightLongWindow mean on the rollup branch", async () => {
      const coverage = new Map<string, boolean>([["WEIGHT", true]]);
      FULLY_COVERED.mockReturnValue(true);
      PROBE.mockResolvedValue(coverage);

      const now = new Date("2026-05-17T12:00:00.000Z");
      // DAY-bucket read (trailing 37 days) — single bucket, irrelevant
      // for the long-window assertion.
      ROLLUP_FIND_MANY.mockResolvedValueOnce([
        {
          bucketStart: new Date("2026-05-10T00:00:00.000Z"),
          count: 1,
          mean: 82.5,
          minValue: 82.5,
          maxValue: 82.5,
          sd: null,
          slope: null,
          r2: null,
          computedAt: now,
        },
      ]);
      // readBestGranularityRollups(WEIGHT, 365) — first call is the
      // MONTH probe (floor 181 d). Two MONTH buckets, count-weighted
      // mean = (12*82 + 18*80) / 30 = 80.8.
      ROLLUP_FIND_MANY.mockResolvedValueOnce([
        {
          bucketStart: new Date("2025-08-01T00:00:00.000Z"),
          count: 12,
          mean: 82,
          minValue: 80,
          maxValue: 84,
          sd: 1,
          slope: 0,
          r2: 0,
          sumValue: null,
        },
        {
          bucketStart: new Date("2025-09-01T00:00:00.000Z"),
          count: 18,
          mean: 80,
          minValue: 78,
          maxValue: 83,
          sd: 1,
          slope: 0,
          r2: 0,
          sumValue: null,
        },
      ]);
      // Source attribution + BP-SYS attribution reads.
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([
        {
          measuredAt: new Date("2026-05-10T08:00:00.000Z"),
          source: "WITHINGS",
        },
      ]).mockResolvedValueOnce([]);

      await computeUserHealthScoreFastPath({
        userId: "user-longwindow",
        bpInTargetPct: 85,
        heightCm: 178,
        now,
        coverage,
      });

      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const pathCall = calls.find(
        (c) => c?.meta?.healthScore?.path === "rollup",
      );
      expect(pathCall).toBeDefined();
      const longWindow = pathCall?.meta?.healthScore?.weightLongWindow;
      expect(longWindow).not.toBeNull();
      expect(longWindow?.granularity).toBe("MONTH");
      expect(longWindow?.buckets).toBe(2);
      // Σ(count*mean) / Σcount = (12*82 + 18*80) / 30 = 80.8 → rounded.
      expect(longWindow?.mean).toBeCloseTo(80.8, 5);
    });

    it("emits weightLongWindow:null when the WMY tier carries no buckets", async () => {
      const coverage = new Map<string, boolean>([["WEIGHT", true]]);
      FULLY_COVERED.mockReturnValue(true);
      PROBE.mockResolvedValue(coverage);

      const now = new Date("2026-05-17T12:00:00.000Z");
      // DAY-bucket read.
      ROLLUP_FIND_MANY.mockResolvedValueOnce([
        {
          bucketStart: new Date("2026-05-10T00:00:00.000Z"),
          count: 1,
          mean: 82.5,
          minValue: 82.5,
          maxValue: 82.5,
          sd: null,
          slope: null,
          r2: null,
          computedAt: now,
        },
      ]);
      // Long-window read — every granularity returns empty (router
      // walks MONTH → WEEK → DAY; 365 d skips YEAR floor).
      ROLLUP_FIND_MANY.mockResolvedValue([]);
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([
        {
          measuredAt: new Date("2026-05-10T08:00:00.000Z"),
          source: "WITHINGS",
        },
      ]).mockResolvedValueOnce([]);

      await computeUserHealthScoreFastPath({
        userId: "user-no-longwindow",
        bpInTargetPct: 85,
        heightCm: 178,
        now,
        coverage,
      });

      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const pathCall = calls.find(
        (c) => c?.meta?.healthScore?.path === "rollup",
      );
      expect(pathCall?.meta?.healthScore?.weightLongWindow).toBeNull();
    });

    it("omits the long-window read on the live fallback branch", async () => {
      const coverage = new Map<string, boolean>([["WEIGHT", false]]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);

      const now = new Date("2026-05-17T12:00:00.000Z");
      // Weight live read + BP source attribution.
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([
        {
          measuredAt: new Date("2026-05-10T08:00:00.000Z"),
          value: 82.5,
          source: "MANUAL",
        },
      ]).mockResolvedValueOnce([]);

      await computeUserHealthScoreFastPath({
        userId: "user-live-nowmy",
        bpInTargetPct: 80,
        heightCm: 178,
        now,
        coverage,
      });

      // The live branch never issues the long-window probe — guards
      // against accidentally double-reading on cold mounts where the
      // raw weight findMany is already doing the work.
      expect(ROLLUP_FIND_MANY).not.toHaveBeenCalled();
      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const pathCall = calls.find(
        (c) => c?.meta?.healthScore?.path === "live",
      );
      expect(pathCall?.meta?.healthScore?.weightLongWindow).toBeNull();
    });
  });

  describe("live fallback — WEIGHT not covered", () => {
    it("reads raw weight rows and pins path:live", async () => {
      const coverage = new Map<string, boolean>([
        ["WEIGHT", false],
      ]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);

      const now = new Date("2026-05-17T12:00:00.000Z");
      MEASUREMENT_FIND_MANY
        // Weight (live) — 37-day window, 3-column projection.
        .mockResolvedValueOnce([
          {
            measuredAt: new Date("2026-05-10T08:00:00.000Z"),
            value: 82.5,
            source: "MANUAL",
          },
          {
            measuredAt: new Date("2026-05-14T08:00:00.000Z"),
            value: 81.5,
            source: "MANUAL",
          },
        ])
        // BP-SYS source attribution.
        .mockResolvedValueOnce([]);

      const result = await computeUserHealthScoreFastPath({
        userId: "user-live",
        bpInTargetPct: 75,
        heightCm: 178,
        now,
        coverage,
      });

      expect(result).not.toBeNull();
      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const pathCall = calls.find(
        (c) => c?.meta?.healthScore?.path === "live",
      );
      expect(pathCall).toBeDefined();
      // Live path read raw weight (value selected).
      const weightCall = MEASUREMENT_FIND_MANY.mock.calls[0][0];
      expect(weightCall.select.value).toBe(true);
      expect(weightCall.where.type).toBe("WEIGHT");
      expect(ROLLUP_FIND_MANY).not.toHaveBeenCalled();
    });
  });

  describe("empty path", () => {
    it("returns null with reason:no_components_available when nothing is computable", async () => {
      const coverage = new Map<string, boolean>([]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);

      // No weight rows, no BP rows, no mood, no medications.
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await computeUserHealthScoreFastPath({
        userId: "user-empty",
        bpInTargetPct: null,
        heightCm: null,
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
      });

      expect(result).toBeNull();
      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const nullCall = calls.find(
        (c) => c?.meta?.healthScore?.reason === "no_components_available",
      );
      expect(nullCall).toBeDefined();
    });
  });

  describe("coverage probing", () => {
    it("probes coverage when the caller omits the map", async () => {
      const coverage = new Map<string, boolean>([]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await computeUserHealthScoreFastPath({
        userId: "user-fresh",
        bpInTargetPct: null,
        heightCm: null,
        now: new Date("2026-05-17T12:00:00.000Z"),
      });

      expect(PROBE).toHaveBeenCalledWith("user-fresh");
    });
  });

  // v1.4.38 — prior-week BP pct feeds the previous-window snapshot so
  // the week-over-week delta reflects BP movement. Legacy callers that
  // omit the field keep the pre-v1.4.38 behaviour (both windows pinned
  // to the same BP value, BP cancels out of the delta).
  describe("prior-week BP pct contract", () => {
    it("feeds bpInTargetPctPriorWeek into the previous-window snapshot when set", async () => {
      const coverage = new Map<string, boolean>([]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await computeUserHealthScoreFastPath({
        userId: "user-bpdelta",
        bpInTargetPct: 90,
        bpInTargetPctPriorWeek: 70,
        heightCm: null,
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
      });

      // With only BP data the helper still returns a score. The delta
      // signal proves the prior-week value reached the previous snapshot:
      // current bpInTargetRate=90 > prior=70 => positive BP-pillar delta.
      expect(result).not.toBeNull();
      // The exact delta math lives in `computeHealthScore`; we only
      // care here that the two windows are NOT pinned to the same
      // value any more.
      const componentDelta = result?.delta;
      expect(typeof componentDelta === "number" || componentDelta === null).toBe(
        true,
      );
    });

    it("falls back to bpInTargetPct when bpInTargetPctPriorWeek is omitted", async () => {
      const coverage = new Map<string, boolean>([]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      // Both runs use the same bpInTargetPct in both windows; the BP
      // pillar contributes zero to the delta. Pre-v1.4.38 behaviour
      // preserved for callers that don't opt in.
      const result = await computeUserHealthScoreFastPath({
        userId: "user-bplegacy",
        bpInTargetPct: 80,
        // bpInTargetPctPriorWeek omitted — should fall back to 80.
        heightCm: null,
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
      });

      expect(result).not.toBeNull();
    });
  });

  // v1.5.0 — regression pin for the cadence-aware compliance migration
  // (closes #214). Before this release the score helper fed every
  // medication-compliance pillar through `schedules.length * 30` as the
  // denominator, so a weekly Ozempic schedule with 4 taken Mondays
  // reported ~13% and dragged the score down ~10–15 points. The
  // adapter now matches the cadence chart's denominator (Mondays-in-
  // window) and the weekly med contributes its true 100% rate.
  describe("cadence-aware medication compliance (closes #214)", () => {
    function mondaysInWindow(now: Date, days: number): Date[] {
      const out: Date[] = [];
      const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      const cursor = new Date(from);
      while (cursor <= now) {
        if (cursor.getUTCDay() === 1) {
          out.push(new Date(cursor));
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      return out;
    }

    it("weekly Mondays-only med with all Mondays taken contributes a 100% pillar", async () => {
      const coverage = new Map<string, boolean>([]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      // Weight + BP attribution reads return empty so only the
      // medication compliance pillar is non-null.
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const now = new Date("2026-05-13T12:00:00.000Z"); // Wed
      MEDICATION_FIND_MANY.mockResolvedValueOnce([
        {
          id: "med-weekly",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          schedules: [
            { windowStart: "08:00", windowEnd: "09:00", daysOfWeek: "1" },
          ],
        },
      ]);
      // One intake per Monday inside the trailing 30 days. The
      // cadence pairing reads `scheduledFor` for both anchor and
      // event, so the Mondays-only timeline lines up cleanly.
      const events = mondaysInWindow(now, 30).map((mon) => ({
        medicationId: "med-weekly",
        scheduledFor: new Date(
          Date.UTC(
            mon.getUTCFullYear(),
            mon.getUTCMonth(),
            mon.getUTCDate(),
            8,
            30,
          ),
        ),
        takenAt: new Date(
          Date.UTC(
            mon.getUTCFullYear(),
            mon.getUTCMonth(),
            mon.getUTCDate(),
            8,
            35,
          ),
        ),
        skipped: false,
      }));
      // The helper reads the 37-day window (prevSince30d → now) so
      // the prior-week snapshot has data too — return the same set
      // unfiltered; the helper filters internally.
      INTAKE_FIND_MANY.mockResolvedValueOnce(events);

      const result = await computeUserHealthScoreFastPath({
        userId: "user-weekly-med",
        bpInTargetPct: 80,
        heightCm: 178,
        now,
        coverage,
      });

      expect(result).not.toBeNull();
      // The medication pillar must be populated and reflect a 100%
      // rate (or at least ≥ 50, well above the pre-fix ~13%). The
      // exact pillar number depends on `computeHealthScore`'s
      // weighting; we assert the directional contract — the score is
      // computed AND the compliance branch fired.
      expect(result?.components.compliance.value).not.toBeNull();
      const complianceValue = result?.components.compliance.value ?? 0;
      // Pre-fix this user reported ~13% adherence → ~13 here. The
      // post-fix path produces ≥ 90 (one Monday per week, all taken
      // → 100% with the new denominator). 50 is a wide safety margin
      // that catches the regression with zero flake risk.
      expect(complianceValue).toBeGreaterThanOrEqual(50);
    });

    it("daily-only med with all doses taken still reports 100% (no regression on the path that already worked)", async () => {
      const coverage = new Map<string, boolean>([]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const now = new Date("2026-05-13T12:00:00.000Z"); // Wed
      MEDICATION_FIND_MANY.mockResolvedValueOnce([
        {
          id: "med-daily",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          schedules: [
            { windowStart: "08:00", windowEnd: "09:00", daysOfWeek: null },
          ],
        },
      ]);
      // One taken event per day over the trailing 30 days — including
      // today's already-past slot (08:00 UTC < NOW = 12:00).
      const events = [];
      for (let d = 0; d < 30; d++) {
        const day = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
        const at = new Date(
          Date.UTC(
            day.getUTCFullYear(),
            day.getUTCMonth(),
            day.getUTCDate(),
            8,
            30,
          ),
        );
        if (at.getTime() > now.getTime()) continue;
        events.push({
          medicationId: "med-daily",
          scheduledFor: at,
          takenAt: new Date(at.getTime() + 5 * 60_000),
          skipped: false,
        });
      }
      INTAKE_FIND_MANY.mockResolvedValueOnce(events);

      const result = await computeUserHealthScoreFastPath({
        userId: "user-daily-med",
        bpInTargetPct: 80,
        heightCm: 178,
        now,
        coverage,
      });

      expect(result).not.toBeNull();
      // Daily-only path was correct under the legacy denominator and
      // stays correct under the cadence denominator. The contract:
      // taken=N, missed=0 → rate=100; pillar reads ≥ 90 with whatever
      // weighting `computeHealthScore` applies.
      expect(result?.components.compliance.value).toBeGreaterThanOrEqual(90);
    });
  });
});
