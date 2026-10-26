/**
 * v1.4.37 — unit pin for the probe-gated bp_in_target helper.
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
    // v1.11.1 — readRollupBuckets lazy-loads the source-priority blob; null
    // (default findUnique) falls back to the default ladders.
    user: { findUnique: vi.fn() },
    // v1.18.10 — the live BP fallback now reads source-collapsed rows via
    // `$queryRawUnsafe` (`canonicalMeasurementsFrom`) instead of a chunked
    // `findMany`, so cold == warm. Mock it to feed the SYS / DIA series.
    $queryRawUnsafe: vi.fn(),
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
import { computeBpInTargetFastPath } from "../bp-in-target-fast-path";

const MEASUREMENT_FIND_MANY = prisma.measurement
  .findMany as unknown as ReturnType<typeof vi.fn>;
const ROLLUP_FIND_MANY = prisma.measurementRollup
  .findMany as unknown as ReturnType<typeof vi.fn>;
const QUERY_RAW = prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>;
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
  QUERY_RAW.mockReset();
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
    it("falls back to the source-collapsed live read when SYS bucket coverage is missing", async () => {
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", false],
        ["BLOOD_PRESSURE_DIA", true],
      ]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);

      // First raw query = SYS rows, second = DIA rows. Rows arrive in the raw
      // SQL snake_case shape (`measured_at` + `value`).
      QUERY_RAW.mockResolvedValueOnce([
        {
          measured_at: new Date("2026-05-15T08:00:00.000Z"),
          value: 122,
        },
      ]).mockResolvedValueOnce([
        {
          measured_at: new Date("2026-05-15T08:00:00.000Z"),
          value: 76,
        },
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
      expect(MEASUREMENT_FIND_MANY).not.toHaveBeenCalled();
      expect(QUERY_RAW).toHaveBeenCalledTimes(2);
    });

    it("pins the path:live annotate", async () => {
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", true],
        ["BLOOD_PRESSURE_DIA", false],
      ]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      QUERY_RAW.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

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

    it("collapses overlapping sources on the live path (v1.18.10 I-1 — cold == warm)", async () => {
      // Two sources mirror the SAME reading on the same day (Withings + its
      // Apple-Health mirror). The source-collapse picks one canonical source
      // per (type, day) BEFORE pairing, so the in-target denominator counts the
      // shared reading once — matching the rollup path. The collapse runs in
      // SQL (`canonicalMeasurementsFrom`), so the mock just confirms the live
      // query routes through it and the result reflects ONE pair, not two.
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", false],
        ["BLOOD_PRESSURE_DIA", false],
      ]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      // The canonical subquery has already collapsed the duplicate source — it
      // returns ONE SYS row and ONE DIA row for the day.
      QUERY_RAW.mockResolvedValueOnce([
        { measured_at: new Date("2026-05-15T08:00:00.000Z"), value: 122 },
      ]).mockResolvedValueOnce([
        { measured_at: new Date("2026-05-15T08:00:00.000Z"), value: 76 },
      ]);

      const result = await computeBpInTargetFastPath({
        userId: "user-dual-source",
        targets: TARGETS_UNDER_65,
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
      });

      expect(result.path).toBe("live");
      expect(result.last30Days).toEqual({ pct: 100, pairs: 1 });
      // Both live reads must route through the canonical-source subquery so the
      // collapse fires in SQL — pin the marker so a regression that reverts to
      // a raw `findMany` (double-counting) fails here.
      for (const call of QUERY_RAW.mock.calls) {
        const sql = String(call[0]);
        expect(sql).toContain("canonical_source");
        expect(sql).toContain("date_trunc('day'");
      }
    });

    it("probes coverage when the caller omits the map", async () => {
      const coverage = new Map<string, boolean>([]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);
      QUERY_RAW.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await computeBpInTargetFastPath({
        userId: "user-fresh",
        targets: TARGETS_UNDER_65,
        now: new Date("2026-05-17T12:00:00.000Z"),
      });

      expect(PROBE).toHaveBeenCalledWith("user-fresh");
      expect(result.path).toBe("live");
    });
  });

  describe("cross-tz runtime guard (v1.4.38 W-A)", () => {
    it("takes the rollup path for a Berlin user (near-UTC)", async () => {
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", true],
        ["BLOOD_PRESSURE_DIA", true],
      ]);
      FULLY_COVERED.mockReturnValue(true);
      PROBE.mockResolvedValue(coverage);
      ROLLUP_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await computeBpInTargetFastPath({
        userId: "user-berlin",
        targets: TARGETS_UNDER_65,
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
        userTz: "Europe/Berlin",
      });

      expect(result.path).toBe("rollup");
      expect(MEASUREMENT_FIND_MANY).not.toHaveBeenCalled();

      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const bpCall = calls.find(
        (c) => c?.meta?.analytics?.bp_in_target !== undefined,
      );
      expect(bpCall?.meta.analytics.bp_in_target.tz_guard).toBe("near-utc");
      expect(bpCall?.meta.analytics.bp_in_target.path).toBe("rollup");
    });

    it("falls back to live for Honolulu (-10h) even with full coverage", async () => {
      // Coverage map says rollup-eligible, but the user's tz forces
      // the live path because the rollup UTC-midnight day-key would
      // slip a calendar day relative to the local window boundaries.
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", true],
        ["BLOOD_PRESSURE_DIA", true],
      ]);
      FULLY_COVERED.mockReturnValue(true);
      PROBE.mockResolvedValue(coverage);
      QUERY_RAW.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await computeBpInTargetFastPath({
        userId: "user-honolulu",
        targets: TARGETS_UNDER_65,
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
        userTz: "Pacific/Honolulu",
      });

      expect(result.path).toBe("live");
      expect(ROLLUP_FIND_MANY).not.toHaveBeenCalled();
      expect(QUERY_RAW).toHaveBeenCalledTimes(2);

      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const bpCall = calls.find(
        (c) => c?.meta?.analytics?.bp_in_target !== undefined,
      );
      expect(bpCall?.meta.analytics.bp_in_target.tz_guard).toBe(
        "non-utc-live-fallback",
      );
      expect(bpCall?.meta.analytics.bp_in_target.path).toBe("live");
    });

    it("falls back to live for Tokyo (+9h) even with full coverage", async () => {
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", true],
        ["BLOOD_PRESSURE_DIA", true],
      ]);
      FULLY_COVERED.mockReturnValue(true);
      PROBE.mockResolvedValue(coverage);
      QUERY_RAW.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await computeBpInTargetFastPath({
        userId: "user-tokyo",
        targets: TARGETS_UNDER_65,
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
        userTz: "Asia/Tokyo",
      });

      expect(result.path).toBe("live");
      expect(ROLLUP_FIND_MANY).not.toHaveBeenCalled();
    });

    // v1.30.3 — the guard force-routes a non-near-UTC user to the
    // live path specifically so their pairing is computed correctly; before
    // this fix the live path's same-day fallback still hardcoded the Berlin
    // day, undoing exactly the protection the guard exists to provide.
    it("pairs on the user's OWN tz on the live path it was force-routed to (Tokyo)", async () => {
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", true],
        ["BLOOD_PRESSURE_DIA", true],
      ]);
      FULLY_COVERED.mockReturnValue(true);
      PROBE.mockResolvedValue(coverage);

      // 2026-05-14T21:50Z = 23:50 Berlin (05-14) / 06:50 Tokyo (05-15).
      // 2026-05-14T22:10Z = 00:10 Berlin (05-15, the NEXT Berlin day) /
      // 07:10 Tokyo (05-15, the SAME Tokyo day). >5-min gap, so only the
      // same-calendar-day fallback can pair them — and only Tokyo agrees.
      QUERY_RAW.mockResolvedValueOnce([
        { measured_at: new Date("2026-05-14T21:50:00.000Z"), value: 125 },
      ]).mockResolvedValueOnce([
        { measured_at: new Date("2026-05-14T22:10:00.000Z"), value: 75 },
      ]);

      const result = await computeBpInTargetFastPath({
        userId: "user-tokyo-pair",
        targets: TARGETS_UNDER_65,
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
        userTz: "Asia/Tokyo",
      });

      expect(result.path).toBe("live");
      // A Berlin-day pairing would reject this pair (different Berlin
      // calendar days) and every window would read null/no-pairs.
      expect(result.last30Days).toEqual({ pct: 100, pairs: 1 });
    });

    it("defaults to near-UTC when the caller omits userTz (legacy compat)", async () => {
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", true],
        ["BLOOD_PRESSURE_DIA", true],
      ]);
      FULLY_COVERED.mockReturnValue(true);
      PROBE.mockResolvedValue(coverage);
      ROLLUP_FIND_MANY.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await computeBpInTargetFastPath({
        userId: "user-legacy",
        targets: TARGETS_UNDER_65,
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
      });

      expect(result.path).toBe("rollup");

      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const bpCall = calls.find(
        (c) => c?.meta?.analytics?.bp_in_target !== undefined,
      );
      expect(bpCall?.meta.analytics.bp_in_target.tz_guard).toBe("near-utc");
    });
  });
});
