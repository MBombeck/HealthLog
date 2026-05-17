/**
 * v1.4.37 W2 — unit pin for the probe-gated bp_in_target helper.
 *
 * Mocks Prisma + the rollup-coverage probe so the path-selection
 * contract is verifiable without a Postgres container. Real-rollup
 * coverage with byte-shape parity lives in the integration suite at
 * `tests/integration/bp-in-target.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    measurementRollup: { findMany: vi.fn() },
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
import { computeBpInTargetFastPath } from "../bp-in-target-fast-path";

const MEASUREMENT_FIND_MANY = prisma.measurement.findMany as unknown as ReturnType<typeof vi.fn>;
const ROLLUP_FIND_MANY = prisma.measurementRollup.findMany as unknown as ReturnType<typeof vi.fn>;
const PROBE = probeRollupCoverage as unknown as ReturnType<typeof vi.fn>;
const FULLY_COVERED = isFullyCovered as unknown as ReturnType<typeof vi.fn>;
const ANNOTATE = annotate as unknown as ReturnType<typeof vi.fn>;

const TARGETS_UNDER_65 = {
  sysLow: 120,
  sysHigh: 129,
  diaLow: 70,
  diaHigh: 79,
};

beforeEach(() => {
  MEASUREMENT_FIND_MANY.mockReset();
  ROLLUP_FIND_MANY.mockReset();
  PROBE.mockReset();
  FULLY_COVERED.mockReset();
  ANNOTATE.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computeBpInTargetFastPath", () => {
  describe("rollup-fast-path — both BP types covered", () => {
    it("composes in-target % from DAY buckets without reading raw measurements", async () => {
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", true],
        ["BLOOD_PRESSURE_DIA", true],
      ]);
      FULLY_COVERED.mockReturnValue(true);
      PROBE.mockResolvedValue(coverage);

      const now = new Date("2026-05-17T12:00:00.000Z");
      const today = new Date("2026-05-17T00:00:00.000Z");
      const yesterday = new Date("2026-05-16T00:00:00.000Z");
      const twoDaysAgo = new Date("2026-05-15T00:00:00.000Z");

      ROLLUP_FIND_MANY
        // SYS day buckets
        .mockResolvedValueOnce([
          {
            bucketStart: today,
            count: 2,
            mean: 125, // in-target
            minValue: 120,
            maxValue: 130,
            sd: null,
            slope: null,
            r2: null,
            computedAt: now,
          },
          {
            bucketStart: yesterday,
            count: 1,
            mean: 145, // out-of-target (sys too high)
            minValue: 145,
            maxValue: 145,
            sd: null,
            slope: null,
            r2: null,
            computedAt: now,
          },
          {
            bucketStart: twoDaysAgo,
            count: 3,
            mean: 122, // in-target
            minValue: 118,
            maxValue: 127,
            sd: null,
            slope: null,
            r2: null,
            computedAt: now,
          },
        ])
        // DIA day buckets
        .mockResolvedValueOnce([
          {
            bucketStart: today,
            count: 2,
            mean: 75,
            minValue: 72,
            maxValue: 78,
            sd: null,
            slope: null,
            r2: null,
            computedAt: now,
          },
          {
            bucketStart: yesterday,
            count: 1,
            mean: 85,
            minValue: 85,
            maxValue: 85,
            sd: null,
            slope: null,
            r2: null,
            computedAt: now,
          },
          {
            bucketStart: twoDaysAgo,
            count: 3,
            mean: 78,
            minValue: 70,
            maxValue: 79,
            sd: null,
            slope: null,
            r2: null,
            computedAt: now,
          },
        ]);

      const result = await computeBpInTargetFastPath({
        userId: "user-rollup",
        targets: TARGETS_UNDER_65,
        now,
        coverage,
      });

      expect(result.path).toBe("rollup");
      // 2 in-target days (today + 2-days-ago) out of 3 → 5 in-target
      // pair-counts out of 6 total. round(5/6 * 100) = 83.
      expect(result.last7Days).toEqual({ pct: 83, pairs: 6 });
      expect(result.last30Days).toEqual({ pct: 83, pairs: 6 });
      expect(result.allTime).toEqual({ pct: 83, pairs: 6 });
      expect(MEASUREMENT_FIND_MANY).not.toHaveBeenCalled();
      expect(ROLLUP_FIND_MANY).toHaveBeenCalledTimes(2);
    });

    it("pins the path:rollup annotate so prod logs can prove the branch", async () => {
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", true],
        ["BLOOD_PRESSURE_DIA", true],
      ]);
      FULLY_COVERED.mockReturnValue(true);
      PROBE.mockResolvedValue(coverage);
      ROLLUP_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await computeBpInTargetFastPath({
        userId: "user-rollup",
        targets: TARGETS_UNDER_65,
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
      });

      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const bpCall = calls.find(
        (c) => c?.meta?.analytics?.bp_in_target?.path === "rollup",
      );
      expect(bpCall).toBeDefined();
    });

    it("returns null for windows with no paired days", async () => {
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", true],
        ["BLOOD_PRESSURE_DIA", true],
      ]);
      FULLY_COVERED.mockReturnValue(true);
      PROBE.mockResolvedValue(coverage);
      ROLLUP_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await computeBpInTargetFastPath({
        userId: "user-fresh",
        targets: TARGETS_UNDER_65,
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
      });

      expect(result.last7Days).toBeNull();
      expect(result.last30Days).toBeNull();
      expect(result.allTime).toBeNull();
      expect(result.path).toBe("rollup");
    });
  });

  describe("live fallback — partial or no coverage", () => {
    it("falls back to the chunked findMany when SYS bucket coverage is missing", async () => {
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", false],
        ["BLOOD_PRESSURE_DIA", true],
      ]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);

      // First findMany = SYS rows, second = DIA rows.
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([
        { id: "1", measuredAt: new Date("2026-05-15T08:00:00.000Z"), value: 122 },
      ])
        .mockResolvedValueOnce([
          { id: "2", measuredAt: new Date("2026-05-15T08:00:00.000Z"), value: 76 },
        ]);

      const result = await computeBpInTargetFastPath({
        userId: "user-partial",
        targets: TARGETS_UNDER_65,
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
      });

      expect(result.path).toBe("live");
      // One paired in-target reading.
      expect(result.last30Days).toEqual({ pct: 100, pairs: 1 });
      expect(ROLLUP_FIND_MANY).not.toHaveBeenCalled();
      expect(MEASUREMENT_FIND_MANY).toHaveBeenCalledTimes(2);
    });

    it("pins the path:live annotate", async () => {
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", true],
        ["BLOOD_PRESSURE_DIA", false],
      ]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await computeBpInTargetFastPath({
        userId: "user-partial",
        targets: TARGETS_UNDER_65,
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
      });

      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const bpCall = calls.find(
        (c) => c?.meta?.analytics?.bp_in_target?.path === "live",
      );
      expect(bpCall).toBeDefined();
    });

    it("probes coverage when the caller omits the map", async () => {
      const coverage = new Map<string, boolean>([]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      MEASUREMENT_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await computeBpInTargetFastPath({
        userId: "user-fresh",
        targets: TARGETS_UNDER_65,
        now: new Date("2026-05-17T12:00:00.000Z"),
      });

      expect(PROBE).toHaveBeenCalledWith("user-fresh");
      expect(result.path).toBe("live");
    });
  });
});
