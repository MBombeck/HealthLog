/**
 * v1.4.37 W2 — unit pin for the probe-gated correlation runner.
 *
 * Mocks Prisma + the rollup-coverage probe so the path-selection
 * contract is verifiable without a Postgres container. Real-data
 * coverage of the actual Pearson + ANOVA math lives in
 * `correlations.test.ts`; this file only checks WHICH read path the
 * runner takes and that the sentinel annotate carries the window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    measurementRollup: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
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
import {
  CORRELATION_WINDOW_DAYS,
  computeCorrelationHypothesesFastPath,
} from "../correlations-fast-path";

const MEASUREMENT_FIND_MANY = prisma.measurement.findMany as unknown as ReturnType<typeof vi.fn>;
const ROLLUP_FIND_MANY = prisma.measurementRollup.findMany as unknown as ReturnType<typeof vi.fn>;
const MOOD_FIND_MANY = prisma.moodEntry.findMany as unknown as ReturnType<typeof vi.fn>;
const INTAKE_FIND_MANY = prisma.medicationIntakeEvent.findMany as unknown as ReturnType<typeof vi.fn>;
const PROBE = probeRollupCoverage as unknown as ReturnType<typeof vi.fn>;
const FULLY_COVERED = isFullyCovered as unknown as ReturnType<typeof vi.fn>;
const ANNOTATE = annotate as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  MEASUREMENT_FIND_MANY.mockReset();
  ROLLUP_FIND_MANY.mockReset();
  MOOD_FIND_MANY.mockReset();
  INTAKE_FIND_MANY.mockReset();
  PROBE.mockReset();
  FULLY_COVERED.mockReset();
  ANNOTATE.mockReset();

  MOOD_FIND_MANY.mockResolvedValue([]);
  INTAKE_FIND_MANY.mockResolvedValue([]);
  ROLLUP_FIND_MANY.mockResolvedValue([]);
  MEASUREMENT_FIND_MANY.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computeCorrelationHypothesesFastPath", () => {
  it("scans the trailing 28 days (CORRELATION_WINDOW_DAYS)", () => {
    expect(CORRELATION_WINDOW_DAYS).toBe(28);
  });

  describe("rollup-fast-path — SYS / PULSE / WEIGHT covered", () => {
    it("reads per-day means from measurement_rollups, never from measurements", async () => {
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", true],
        ["PULSE", true],
        ["WEIGHT", true],
      ]);
      FULLY_COVERED.mockReturnValue(true);
      PROBE.mockResolvedValue(coverage);

      ROLLUP_FIND_MANY
        .mockResolvedValueOnce([]) // SYS buckets
        .mockResolvedValueOnce([]) // PULSE buckets
        .mockResolvedValueOnce([]); // WEIGHT buckets

      const result = await computeCorrelationHypothesesFastPath({
        userId: "user-rollup",
        userTz: "Europe/Berlin",
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
      });

      expect(result.path).toBe("rollup");
      expect(result.windowDays).toBe(28);
      expect(result.degraded).toBe(false);
      // No raw measurement reads when on rollup-fast-path.
      expect(MEASUREMENT_FIND_MANY).not.toHaveBeenCalled();
      expect(ROLLUP_FIND_MANY).toHaveBeenCalledTimes(3);
      // Mood + intake reads always live.
      expect(MOOD_FIND_MANY).toHaveBeenCalledTimes(1);
      expect(INTAKE_FIND_MANY).toHaveBeenCalledTimes(1);
    });

    it("pins path:rollup + window_days:28 on the annotate", async () => {
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", true],
        ["PULSE", true],
        ["WEIGHT", true],
      ]);
      FULLY_COVERED.mockReturnValue(true);
      PROBE.mockResolvedValue(coverage);
      ROLLUP_FIND_MANY.mockResolvedValue([]);

      await computeCorrelationHypothesesFastPath({
        userId: "user-rollup",
        userTz: "Europe/Berlin",
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
      });

      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const corrCall = calls.find((c) => c?.meta?.correlations !== undefined);
      expect(corrCall).toBeDefined();
      expect(corrCall.meta.correlations.path).toBe("rollup");
      expect(corrCall.meta.correlations.window_days).toBe(28);
      expect(corrCall.meta.correlations.degraded).toBe(false);
    });
  });

  describe("live fallback", () => {
    it("falls back when SYS coverage is missing", async () => {
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", false],
        ["PULSE", true],
        ["WEIGHT", true],
      ]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);

      MEASUREMENT_FIND_MANY
        .mockResolvedValueOnce([]) // SYS rows
        .mockResolvedValueOnce([]) // PULSE rows
        .mockResolvedValueOnce([]); // WEIGHT rows

      const result = await computeCorrelationHypothesesFastPath({
        userId: "user-partial",
        userTz: "Europe/Berlin",
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
      });

      expect(result.path).toBe("live");
      expect(MEASUREMENT_FIND_MANY).toHaveBeenCalledTimes(3);
      expect(ROLLUP_FIND_MANY).not.toHaveBeenCalled();
    });

    it("pins path:live on the annotate", async () => {
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", false],
      ]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      MEASUREMENT_FIND_MANY.mockResolvedValue([]);

      await computeCorrelationHypothesesFastPath({
        userId: "user-partial",
        userTz: "Europe/Berlin",
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
      });

      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const corrCall = calls.find((c) => c?.meta?.correlations !== undefined);
      expect(corrCall).toBeDefined();
      expect(corrCall.meta.correlations.path).toBe("live");
    });
  });

  describe("coverage probing", () => {
    it("probes coverage when the caller omits the map", async () => {
      const coverage = new Map<string, boolean>([]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      MEASUREMENT_FIND_MANY.mockResolvedValue([]);

      await computeCorrelationHypothesesFastPath({
        userId: "user-fresh",
        userTz: "Europe/Berlin",
        now: new Date("2026-05-17T12:00:00.000Z"),
      });

      expect(PROBE).toHaveBeenCalledWith("user-fresh");
    });
  });

  describe("cross-tz runtime guard (v1.4.38 W-A)", () => {
    it("takes the rollup path for a Berlin user (near-UTC)", async () => {
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", true],
        ["PULSE", true],
        ["WEIGHT", true],
      ]);
      FULLY_COVERED.mockReturnValue(true);
      PROBE.mockResolvedValue(coverage);
      ROLLUP_FIND_MANY.mockResolvedValue([]);

      const result = await computeCorrelationHypothesesFastPath({
        userId: "user-berlin",
        userTz: "Europe/Berlin",
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
      });

      expect(result.path).toBe("rollup");
      expect(ROLLUP_FIND_MANY).toHaveBeenCalledTimes(3);
      expect(MEASUREMENT_FIND_MANY).not.toHaveBeenCalled();

      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const corrCall = calls.find((c) => c?.meta?.correlations !== undefined);
      expect(corrCall?.meta.correlations.tz_guard).toBe("near-utc");
    });

    it("falls back to live for Honolulu (-10h) even with full coverage", async () => {
      // Coverage map says rollup-eligible, but the user's tz forces
      // the live path because the rollup bucketStart (UTC midnight)
      // would slip a calendar day relative to userDayKey(..., Honolulu).
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", true],
        ["PULSE", true],
        ["WEIGHT", true],
      ]);
      FULLY_COVERED.mockReturnValue(true);
      PROBE.mockResolvedValue(coverage);
      MEASUREMENT_FIND_MANY.mockResolvedValue([]);

      const result = await computeCorrelationHypothesesFastPath({
        userId: "user-honolulu",
        userTz: "Pacific/Honolulu",
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
      });

      expect(result.path).toBe("live");
      expect(MEASUREMENT_FIND_MANY).toHaveBeenCalledTimes(3);
      expect(ROLLUP_FIND_MANY).not.toHaveBeenCalled();

      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const corrCall = calls.find((c) => c?.meta?.correlations !== undefined);
      expect(corrCall?.meta.correlations.tz_guard).toBe("non-utc-live-fallback");
      expect(corrCall?.meta.correlations.path).toBe("live");
    });

    it("falls back to live for Tokyo (+9h) even with full coverage", async () => {
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", true],
        ["PULSE", true],
        ["WEIGHT", true],
      ]);
      FULLY_COVERED.mockReturnValue(true);
      PROBE.mockResolvedValue(coverage);
      MEASUREMENT_FIND_MANY.mockResolvedValue([]);

      const result = await computeCorrelationHypothesesFastPath({
        userId: "user-tokyo",
        userTz: "Asia/Tokyo",
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
      });

      expect(result.path).toBe("live");
      expect(ROLLUP_FIND_MANY).not.toHaveBeenCalled();
    });
  });
});
