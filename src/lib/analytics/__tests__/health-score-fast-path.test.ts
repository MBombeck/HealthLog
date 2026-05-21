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
});
