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

vi.mock("@/lib/measurements/rollup-coverage", () => ({
  isFullyCovered: vi.fn(),
  probeRollupCoverage: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  isFullyCovered,
  probeRollupCoverage,
} from "@/lib/measurements/rollup-coverage";
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
});
