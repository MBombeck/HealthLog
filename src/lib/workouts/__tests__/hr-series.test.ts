import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: { measurement: { findMany: (...a: unknown[]) => findMany(...a) } },
}));
// The window folds in SQL; the fake folds the rows `findMany` hands back.
vi.mock("@/lib/measurements/dense-bucket-read", async () => {
  const { makeFakeDenseBucketRead } =
    await import("@/lib/measurements/__tests__/fake-dense-bucket-read");
  return makeFakeDenseBucketRead((args) => findMany(args));
});

import {
  adaptiveBucketSec,
  foldHrBuckets,
  buildWorkoutHrSeries,
} from "@/lib/workouts/hr-series";

const START = new Date("2026-05-15T07:00:00Z");
const startMs = START.getTime();

/** Stored-sample entries at `+seconds` offsets from START. */
function storedSample(seconds: number, hr: number) {
  return { t: new Date(startMs + seconds * 1000).toISOString(), hr };
}

beforeEach(() => {
  findMany.mockReset();
});

describe("adaptiveBucketSec", () => {
  it("clamps to [5, 60]", () => {
    expect(adaptiveBucketSec(300)).toBe(5); // ceil(1.25)=2 → floored to 5
    expect(adaptiveBucketSec(1800)).toBe(8);
    expect(adaptiveBucketSec(6 * 3600)).toBe(60); // ceil(90)=90 → capped 60
  });
});

describe("foldHrBuckets", () => {
  it("buckets by elapsed time and drops samples outside the session", () => {
    const samples = [
      { tMs: startMs - 5000, hr: 200 }, // before start → dropped
      { tMs: startMs + 1000, hr: 100 },
      { tMs: startMs + 2000, hr: 120 },
      { tMs: startMs + 11000, hr: 150 },
      { tMs: startMs + 60000, hr: 130 }, // == durationSec → dropped (half-open)
    ];
    const { points, bucketCount } = foldHrBuckets(samples, startMs, 60, 10);
    expect(bucketCount).toBe(6);
    // bucket 0 holds the two early samples → mean 110, min 100, max 120.
    expect(points[0]).toEqual({ tSec: 0, mean: 110, min: 100, max: 120 });
    // bucket 1 holds the +11s sample.
    expect(points[1]).toEqual({ tSec: 10, mean: 150, min: 150, max: 150 });
    expect(points).toHaveLength(2); // gaps stay as gaps
  });

  it("reports median per-bucket density for the envelope decision", () => {
    const samples = [
      { tMs: startMs + 0, hr: 100 },
      { tMs: startMs + 1000, hr: 110 },
      { tMs: startMs + 2000, hr: 120 },
      { tMs: startMs + 3000, hr: 130 },
    ];
    const { medianDensity } = foldHrBuckets(samples, startMs, 60, 10);
    expect(medianDensity).toBe(4);
  });
});

describe("buildWorkoutHrSeries", () => {
  const base = {
    userId: "u1",
    startedAt: START,
    endedAt: new Date(startMs + 600_000), // 10 min
    durationSec: 600,
    now: new Date(startMs + 600_000 + 1000),
  };

  it("prefers the stored series and never touches the DB", async () => {
    const stored = Array.from({ length: 40 }, (_, i) =>
      storedSample(i * 15, 120 + (i % 5)),
    );
    const result = await buildWorkoutHrSeries({
      ...base,
      storedSamples: stored,
    });
    expect(result).not.toBeNull();
    expect(result!.source).toBe("workout_series");
    expect(result!.bucketSec).toBe(adaptiveBucketSec(600));
    expect(result!.points.length).toBeGreaterThanOrEqual(2);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("marks the envelope when buckets are dense", async () => {
    // ~8 samples per bucket (1 Hz over an 8 s bucket) → well above the
    // density floor, so the min→max envelope band renders.
    const stored: ReturnType<typeof storedSample>[] = [];
    for (let s = 0; s < 600; s += 1) stored.push(storedSample(s, 140));
    const result = await buildWorkoutHrSeries({
      ...base,
      storedSamples: stored,
    });
    expect(result!.envelope).toBe(true);
  });

  it("falls back to the pulse window when no stored series exists", async () => {
    // Dense PULSE rows across the whole session → passes the gate.
    const rows = Array.from({ length: 60 }, (_, i) => ({
      value: 130 + (i % 7),
      measuredAt: new Date(startMs + i * 10_000),
      externalId: null,
    }));
    findMany.mockResolvedValue(rows);
    const result = await buildWorkoutHrSeries({ ...base, storedSamples: null });
    expect(findMany).toHaveBeenCalledOnce();
    expect(result).not.toBeNull();
    expect(result!.source).toBe("pulse_window");
  });

  it("hides (returns null) when the window has too few samples", async () => {
    findMany.mockResolvedValue([
      { value: 120, measuredAt: new Date(startMs + 1000), externalId: null },
      { value: 122, measuredAt: new Date(startMs + 2000), externalId: null },
    ]);
    const result = await buildWorkoutHrSeries({ ...base, storedSamples: null });
    expect(result).toBeNull();
  });

  it("does not synthesize a curve from aggregate HR or zone durations", async () => {
    findMany.mockResolvedValue([]);
    const result = await buildWorkoutHrSeries({
      ...base,
      storedSamples: null,
      // Aggregate-only WHOOP fields deliberately are not inputs to the
      // curve builder. Keep them on this structural fixture to pin that a
      // future widening cannot silently fabricate time-series points.
      avgHeartRate: 145,
      maxHeartRate: 180,
      metadata: {
        zoneDurations: {
          zone_two_milli: 300_000,
          zone_three_milli: 300_000,
        },
      },
    } as Parameters<typeof buildWorkoutHrSeries>[0] & {
      avgHeartRate: number;
      maxHeartRate: number;
      metadata: unknown;
    });

    expect(result).toBeNull();
  });

  it("hides when bucket coverage is below 40 %", async () => {
    // 10 samples all clustered in the first minute of a 10-minute run →
    // enough raw samples, but coverage is ~1 bucket of ~75.
    const rows = Array.from({ length: 10 }, (_, i) => ({
      value: 120 + i,
      measuredAt: new Date(startMs + i * 500),
      externalId: null,
    }));
    findMany.mockResolvedValue(rows);
    const result = await buildWorkoutHrSeries({ ...base, storedSamples: null });
    expect(result).toBeNull();
  });

  it("excludes consolidated stats: rows from the fallback", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      value: 130,
      measuredAt: new Date(startMs + i * 20_000),
      externalId: "stats:HKQuantityTypeIdentifierHeartRate:2026-05-15T07",
    }));
    findMany.mockResolvedValue(rows);
    const result = await buildWorkoutHrSeries({ ...base, storedSamples: null });
    expect(result).toBeNull();
  });

  it("skips the fallback for workouts older than the retention window", async () => {
    const old = {
      ...base,
      now: new Date(startMs + 100 * 24 * 60 * 60 * 1000),
    };
    const result = await buildWorkoutHrSeries({ ...old, storedSamples: null });
    expect(result).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });
});

/**
 * `durationSec` is a denormalised DURATION, and not every source reports
 * the elapsed one: Strava sends `moving_time` while the row's `endedAt`
 * is `startedAt + elapsed_time`. A ride with 20 minutes of stops
 * therefore carries a `durationSec` 20 minutes shorter than its own
 * wall-clock span, and folding the curve against it drops every reading
 * after the moving-time mark — the tail of the session vanishes with no
 * gap, no marker, nothing that reads as missing.
 */
describe("buildWorkoutHrSeries — sessions whose duration is not their span", () => {
  const SPAN_SEC = 3600;
  const MOVING_SEC = 2400;
  const strava = {
    userId: "u1",
    startedAt: START,
    endedAt: new Date(startMs + SPAN_SEC * 1000),
    durationSec: MOVING_SEC,
    now: new Date(startMs + SPAN_SEC * 1000 + 1000),
  };

  it("carries a stored series to the end of the session, not to the moving-time mark", async () => {
    const stored = Array.from({ length: SPAN_SEC / 15 }, (_, i) =>
      storedSample(i * 15, 120 + (i % 20)),
    );
    const result = await buildWorkoutHrSeries({
      ...strava,
      storedSamples: stored,
    });
    expect(result).not.toBeNull();
    const lastTSec = result!.points[result!.points.length - 1].tSec;
    // The final bucket sits within one bucket width of the session end.
    expect(lastTSec).toBeGreaterThanOrEqual(SPAN_SEC - result!.bucketSec);
    expect(lastTSec).toBeLessThan(SPAN_SEC);
  });

  it("carries a pulse-window series past the moving-time mark too", async () => {
    const rows = Array.from({ length: SPAN_SEC / 20 }, (_, i) => ({
      value: 125 + (i % 9),
      measuredAt: new Date(startMs + i * 20_000),
      externalId: null,
    }));
    findMany.mockResolvedValue(rows);
    const result = await buildWorkoutHrSeries({
      ...strava,
      storedSamples: null,
    });
    expect(result).not.toBeNull();
    expect(result!.source).toBe("pulse_window");
    const lastTSec = result!.points[result!.points.length - 1].tSec;
    expect(lastTSec).toBeGreaterThan(MOVING_SEC);
    // The rows sit 20 s apart, so the final one can miss the very last
    // bucket; landing within a sample interval of the end is the claim.
    expect(lastTSec).toBeGreaterThanOrEqual(SPAN_SEC - 20 - result!.bucketSec);
  });

  it("keeps the duration as the floor when the row carries no usable span", async () => {
    const stored = Array.from({ length: 40 }, (_, i) =>
      storedSample(i * 15, 130),
    );
    const result = await buildWorkoutHrSeries({
      ...strava,
      // A row whose end is not after its start: the span is unusable, so
      // the denormalised duration has to stay the fold window.
      endedAt: START,
      storedSamples: stored,
    });
    expect(result).not.toBeNull();
    expect(result!.bucketSec).toBe(adaptiveBucketSec(MOVING_SEC));
  });
});
