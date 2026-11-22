/**
 * v1.4.37 — unit pin for the probe-gated correlation runner.
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
    // v1.11.1 — readRollupBuckets lazy-loads the source-priority blob.
    user: { findUnique: vi.fn() },
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

// The PULSE proxy folds in SQL; the fake derives it from `proxyPulseRows`
// in the zone the read is asked for.
const { proxyRead } = vi.hoisted(() => ({ proxyRead: vi.fn() }));
let proxyPulseRows: Array<{ measuredAt: Date; value: number }> = [];
vi.mock("@/lib/analytics/resting-pulse-read", () => ({
  readRestingPulseProxy: (opts: unknown) => proxyRead(opts),
}));

import { prisma } from "@/lib/db";
import { deriveRestingProxyFromPulse } from "@/lib/analytics/resting-pulse";
import { annotate } from "@/lib/logging/context";
import { userDayKey } from "@/lib/tz/format";
import {
  isFullyCovered,
  probeRollupCoverage,
} from "@/lib/rollups/measurement-coverage";
import {
  CORRELATION_WINDOW_DAYS,
  computeCorrelationHypothesesFastPath,
} from "../correlations-fast-path";

const MEASUREMENT_FIND_MANY = prisma.measurement
  .findMany as unknown as ReturnType<typeof vi.fn>;
const ROLLUP_FIND_MANY = prisma.measurementRollup
  .findMany as unknown as ReturnType<typeof vi.fn>;
const MOOD_FIND_MANY = prisma.moodEntry.findMany as unknown as ReturnType<
  typeof vi.fn
>;
const INTAKE_FIND_MANY = prisma.medicationIntakeEvent
  .findMany as unknown as ReturnType<typeof vi.fn>;
const PROBE = probeRollupCoverage as unknown as ReturnType<typeof vi.fn>;
const FULLY_COVERED = isFullyCovered as unknown as ReturnType<typeof vi.fn>;
const ANNOTATE = annotate as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  proxyRead.mockReset();
  proxyPulseRows = [];
  proxyRead.mockImplementation(async (opts: { timeZone: string }) =>
    deriveRestingProxyFromPulse(proxyPulseRows, (d) =>
      userDayKey(d, opts.timeZone),
    ),
  );
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

  describe("rollup-fast-path — SYS / WEIGHT covered", () => {
    it("reads SYS + WEIGHT per-day means from measurement_rollups (PULSE no longer)", async () => {
      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", true],
        ["PULSE", true],
        ["WEIGHT", true],
      ]);
      FULLY_COVERED.mockReturnValue(true);
      PROBE.mockResolvedValue(coverage);

      ROLLUP_FIND_MANY.mockResolvedValueOnce([]) // SYS buckets
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
      // v1.2.5 — SYS + WEIGHT ride the rollup tier; PULSE no
      // longer does. The mood × resting-pulse hypothesis instead reads the
      // RESTING_HEART_RATE rows (and, only when absent, RAW PULSE for the
      // low-percentile proxy) from `measurements`, so the rollup count
      // drops to 2 and the resting reads land on `measurements`.
      expect(ROLLUP_FIND_MANY).toHaveBeenCalledTimes(2);
      // RESTING read returns [] (default mock) → the PULSE proxy is read,
      // folded in SQL rather than as raw rows.
      expect(MEASUREMENT_FIND_MANY).toHaveBeenCalledTimes(1);
      expect(proxyRead).toHaveBeenCalledOnce();
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

      MEASUREMENT_FIND_MANY.mockResolvedValue([]); // SYS / WEIGHT / RESTING / PULSE

      const result = await computeCorrelationHypothesesFastPath({
        userId: "user-partial",
        userTz: "Europe/Berlin",
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
      });

      expect(result.path).toBe("live");
      // SYS + WEIGHT (live series) + RESTING = 3 row reads; the PULSE proxy
      // (RESTING returns [] under the default mock) folds in SQL.
      expect(MEASUREMENT_FIND_MANY).toHaveBeenCalledTimes(3);
      expect(proxyRead).toHaveBeenCalledOnce();
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
      expect(ROLLUP_FIND_MANY).toHaveBeenCalledTimes(2);
      // The RESTING read lands on measurements; the PULSE proxy folds in SQL.
      expect(MEASUREMENT_FIND_MANY).toHaveBeenCalledTimes(1);
      expect(proxyRead).toHaveBeenCalledOnce();

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
      // SYS + WEIGHT + RESTING as rows; the PULSE proxy folds in SQL.
      expect(MEASUREMENT_FIND_MANY).toHaveBeenCalledTimes(3);
      expect(proxyRead).toHaveBeenCalledOnce();
      expect(ROLLUP_FIND_MANY).not.toHaveBeenCalled();

      const calls = ANNOTATE.mock.calls.map((c) => c[0]);
      const corrCall = calls.find((c) => c?.meta?.correlations !== undefined);
      expect(corrCall?.meta.correlations.tz_guard).toBe(
        "non-utc-live-fallback",
      );
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

  describe("mood × resting pulse uses the RESTING series, not the raw PULSE mean (M-CS2)", () => {
    it("scores the low-percentile resting proxy, so workout HR can't inflate the pair", async () => {
      // One day with a handful of resting-low readings buried under a dense
      // workout burst. The OLD code paired mood against the day's raw PULSE
      // MEAN (~120 bpm — workout-inflated). The fix routes through
      // `resolveRestingPulseSeries`, whose proxy is the day's 20th-percentile
      // (the resting floor), so the paired value sits in the ~50s, not ~120.
      const day = new Date("2026-05-16T10:00:00.000Z"); // Berlin 12:00 → 05-16
      const pulseValues = [55, 57, 59, 150, 151, 152, 153, 154, 155, 156];
      const rawMean =
        pulseValues.reduce((s, v) => s + v, 0) / pulseValues.length; // ~124.2

      const coverage = new Map<string, boolean>([
        ["BLOOD_PRESSURE_SYS", false], // force the live path
      ]);
      FULLY_COVERED.mockReturnValue(false);
      PROBE.mockResolvedValue(coverage);

      // SYS / WEIGHT / RESTING_HEART_RATE → empty, so the proxy is read.
      MEASUREMENT_FIND_MANY.mockResolvedValue([]);
      proxyPulseRows = pulseValues.map((value) => ({ measuredAt: day, value }));
      MOOD_FIND_MANY.mockResolvedValue([{ score: 4, moodLoggedAt: day }]);

      const result = await computeCorrelationHypothesesFastPath({
        userId: "user-resting",
        userTz: "Europe/Berlin",
        now: new Date("2026-05-17T12:00:00.000Z"),
        coverage,
      });

      // n = 1 day → below the n>=20 surfacing gate, but the points preview
      // still carries the paired resting value the runner computed.
      expect(result.moodPulse.points).toHaveLength(1);
      const y = result.moodPulse.points[0].y;
      // The paired pulse is the resting floor (~50s), NOT the raw day-mean.
      expect(y).toBeLessThan(70);
      expect(y).toBeLessThan(rawMean - 40);
    });
  });
});
