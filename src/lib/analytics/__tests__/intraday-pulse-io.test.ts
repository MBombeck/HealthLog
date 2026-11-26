/**
 * Unit coverage for `loadIntradayPulse` — the two DATAINT-audit fixes:
 *
 *   - M2: the PULSE/step reads are bounded to the exact local-day window
 *     (`localDayWindow`), not the ±15h/39h padded superset.
 *   - M5: the resting-baseline PULSE-proxy fallback buckets by the CALLER's
 *     timezone, not a hardcoded Berlin default — `resolveBaseline` threads
 *     `timezone` into the proxy read.
 *
 * The raw readings fold in SQL (`dense-bucket-read.ts`) and the proxy too
 * (`resting-pulse-read.ts`); the fakes below fold the rows `findMany` hands
 * back with the same rules, so these cases keep exercising the caller. The
 * SQL is pinned in `tests/integration/dense-day-readers.test.ts`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const findManyMock = vi.fn();
const workoutFindManyMock = vi.fn();
const { annotateMock } = vi.hoisted(() => ({ annotateMock: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: (...args: unknown[]) => findManyMock(...args) },
    workout: { findMany: (...args: unknown[]) => workoutFindManyMock(...args) },
  },
}));

vi.mock("@/lib/logging/context", () => ({ annotate: annotateMock }));
vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: async () => null,
}));
vi.mock("@/lib/measurements/dense-bucket-read", async () => {
  const { makeFakeDenseBucketRead } =
    await import("@/lib/measurements/__tests__/fake-dense-bucket-read");
  return makeFakeDenseBucketRead((args) => findManyMock(args));
});
const proxyMock = vi.fn();
vi.mock("@/lib/analytics/resting-pulse-read", () => ({
  readRestingPulseProxy: (...args: unknown[]) => proxyMock(...args),
}));

/** A row source that honours the `stats:` prefix filter a read asks for. */
function byPrefix<T extends { externalId?: string | null }>(
  args: { where: { externalId?: { startsWith?: string } } },
  rows: T[],
): T[] {
  const prefix = args.where.externalId?.startsWith;
  return prefix ? rows.filter((r) => r.externalId?.startsWith(prefix)) : rows;
}

import { loadIntradayPulse } from "@/lib/analytics/intraday-pulse-io";
import {
  deriveRestingProxyFromPulse,
  resolveRestingPulseSeries,
  type PulseSample,
} from "@/lib/analytics/resting-pulse";
import { userDayKey } from "@/lib/tz/format";
import { percentile } from "@/lib/insights/strain-score";
import { localDayWindow } from "@/lib/tz/local-day";

/** Mirrors the private `median()` helper in `intraday-pulse-io.ts`. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(percentile(values, 50) * 10) / 10;
}

describe("loadIntradayPulse", () => {
  beforeEach(() => {
    findManyMock.mockReset();
    findManyMock.mockResolvedValue([]);
    proxyMock.mockReset();
    proxyMock.mockResolvedValue([]);
    workoutFindManyMock.mockReset();
    workoutFindManyMock.mockResolvedValue([]);
    annotateMock.mockReset();
  });

  it("M2 — queries PULSE/step rows against the exact local-day window, not the padded lead/trail superset", async () => {
    const tz = "America/New_York";
    const dateKey = "2026-06-15";
    const { dayStart, dayEnd } = localDayWindow(dateKey, tz);

    findManyMock.mockResolvedValue([]);

    await loadIntradayPulse("user-1", tz, dateKey);

    const pulseCall = findManyMock.mock.calls.find(
      (call) => call[0]?.where?.type === "PULSE",
    );
    const stepCall = findManyMock.mock.calls.find(
      (call) => call[0]?.where?.type === "ACTIVITY_STEPS",
    );
    expect(pulseCall).toBeDefined();
    expect(stepCall).toBeDefined();
    expect(pulseCall![0].where.measuredAt).toEqual({
      gte: dayStart,
      lt: dayEnd,
    });
    expect(stepCall![0].where.measuredAt).toEqual({
      gte: dayStart,
      lt: dayEnd,
    });
  });

  it("M5 — the PULSE-proxy baseline buckets by the caller's timezone, not Berlin", async () => {
    const tz = "Pacific/Kiritimati"; // UTC+14, no DST — deterministic offset
    const dateKey = "2026-06-15";

    // Two UTC instants that land on DIFFERENT Kiritimati calendar days but
    // the SAME Berlin calendar day (Kiritimati is ~13h ahead of Berlin in
    // June) — a clean tz-bucketing fork.
    const dayA = [
      new Date("2026-06-10T09:00:00.000Z"), // Kiritimati: 2026-06-10T23:00 (day A)
      new Date("2026-06-10T10:00:00.000Z"),
      new Date("2026-06-10T11:00:00.000Z"),
    ];
    const dayB = [
      new Date("2026-06-10T12:00:00.000Z"), // Kiritimati: 2026-06-11T02:00 (day B)
      new Date("2026-06-10T13:00:00.000Z"),
      new Date("2026-06-10T14:00:00.000Z"),
    ];
    expect(userDayKey(dayA[0], tz)).not.toBe(userDayKey(dayB[0], tz));
    // Sanity: under the OLD hardcoded-Berlin bug all six samples fall on the
    // SAME Berlin day — proving the two tz groupings genuinely diverge.
    const berlinDays = new Set(
      [...dayA, ...dayB].map((d) => userDayKey(d, "Europe/Berlin")),
    );
    expect(berlinDays.size).toBe(1);

    const pulseHistory: Array<{ value: number; measuredAt: Date }> = [
      ...dayA.map((measuredAt, i) => ({ value: 50 + i, measuredAt })),
      ...dayB.map((measuredAt, i) => ({ value: 80 + i, measuredAt })),
    ];

    // No resting rows, so `resolveBaseline` reads the PULSE proxy; the fake
    // folds the history in whatever zone the read is asked for.
    proxyMock.mockImplementation(async (opts: { timeZone: string }) =>
      deriveRestingProxyFromPulse(pulseHistory, (d) =>
        userDayKey(d, opts.timeZone),
      ),
    );

    const result = await loadIntradayPulse("user-1", tz, dateKey);

    expect(result.baselineSource).toBe("proxy");
    expect(proxyMock).toHaveBeenCalledOnce();
    expect(proxyMock.mock.calls[0][0]).toMatchObject({ timeZone: tz });

    const expected = resolveRestingPulseSeries({
      restingSamples: [],
      pulseSamples: pulseHistory as PulseSample[],
      dayKeyOf: (d) => userDayKey(d, tz),
    });
    const expectedBaseline = median(
      expected.series.slice(-30).map((p) => p.value),
    );
    expect(result.baseline).toBe(expectedBaseline);

    // Regression guard: the OLD hardcoded-Berlin bucketing would have folded
    // every sample into ONE day (see the `berlinDays.size === 1` sanity
    // check above) and produced a materially different proxy value — assert
    // the fixed result does NOT match that wrong grouping's outcome.
    const buggyBerlin = resolveRestingPulseSeries({
      restingSamples: [],
      pulseSamples: pulseHistory as PulseSample[],
      dayKeyOf: (d) => userDayKey(d, "Europe/Berlin"),
    });
    const buggyBaseline = median(
      buggyBerlin.series.slice(-30).map((p) => p.value),
    );
    expect(result.baseline).not.toBe(buggyBaseline);
  });

  it("v1.30.7 — classifies uploaded 10-min HR buckets to a tenMin series with the envelope", async () => {
    const tz = "UTC";
    const dateKey = "2026-06-15";

    // A bucket-native day: the view-day PULSE read returns uploaded 10-min
    // `stats:<HK>:<ISO-Z>` rows (avg in `value`, spread in valueMin/valueMax),
    // no raw per-sample rows. Mature resting baseline so nothing falls back.
    const restingRows = Array.from({ length: 20 }, (_, i) => ({
      value: 55,
      measuredAt: new Date(
        `2026-05-${String((i % 28) + 1).padStart(2, "0")}T06:00:00.000Z`,
      ),
    }));
    const bucketRows = [
      {
        value: 72,
        valueMin: 64,
        valueMax: 88,
        measuredAt: new Date("2026-06-15T08:09:00.000Z"),
        externalId:
          "stats:HKQuantityTypeIdentifierHeartRate:2026-06-15T08:00:00.000Z",
      },
      {
        value: 75,
        valueMin: 70,
        valueMax: 81,
        measuredAt: new Date("2026-06-15T08:19:00.000Z"),
        externalId:
          "stats:HKQuantityTypeIdentifierHeartRate:2026-06-15T08:10:00.000Z",
      },
    ];

    findManyMock.mockImplementation(
      async (args: {
        where: {
          type: string;
          measuredAt?: unknown;
          externalId?: { startsWith?: string };
        };
        take?: number;
      }) => {
        if (args.where.type === "RESTING_HEART_RATE") return restingRows;
        if (args.where.type === "PULSE" && args.where.measuredAt) {
          return byPrefix(args, bucketRows); // the view-day-windowed reads
        }
        return [];
      },
    );

    const result = await loadIntradayPulse("user-1", tz, dateKey);

    expect(result.resolution).toBe("tenMin");
    expect(result.bucketMinutes).toBe(10);
    expect(result.series).toEqual([
      { startMinute: 480, mean: 72, count: 2, min: 64, max: 88 },
      { startMinute: 490, mean: 75, count: 2, min: 70, max: 81 },
    ]);
  });

  it("v1.32.1 (issue #585) — annotates the per-shape row/bucket breakdown for observability", async () => {
    const tz = "UTC";
    const dateKey = "2026-06-15";

    const restingRows = Array.from({ length: 20 }, (_, i) => ({
      value: 55,
      measuredAt: new Date(
        `2026-05-${String((i % 28) + 1).padStart(2, "0")}T06:00:00.000Z`,
      ),
    }));
    // One uploaded 10-min bucket row and one raw per-sample row sharing the
    // day — the DTO merges them (bucket overlays raw on a slot collision),
    // but the annotation must still report each SHAPE's own row count, not
    // just the merged bucket total.
    const uploadedBucket = {
      value: 72,
      valueMin: 64,
      valueMax: 88,
      measuredAt: new Date("2026-06-15T08:09:00.000Z"),
      externalId:
        "stats:HKQuantityTypeIdentifierHeartRate:2026-06-15T08:00:00.000Z",
    };
    const rawSample = {
      value: 65,
      valueMin: null,
      valueMax: null,
      measuredAt: new Date("2026-06-15T09:05:00.000Z"),
      externalId: "sample:abc123",
    };

    findManyMock.mockImplementation(
      async (args: {
        where: {
          type: string;
          measuredAt?: unknown;
          externalId?: { startsWith?: string };
        };
        take?: number;
      }) => {
        if (args.where.type === "RESTING_HEART_RATE") return restingRows;
        if (args.where.type === "PULSE" && args.where.measuredAt) {
          return byPrefix(args, [uploadedBucket, rawSample]);
        }
        return [];
      },
    );

    await loadIntradayPulse("user-1", tz, dateKey);

    expect(annotateMock).toHaveBeenCalledWith({
      meta: {
        intraday_raw_sample_rows: 1,
        intraday_uploaded_bucket_rows: 1,
        intraday_folded_hourly_rows: 0,
        intraday_ten_min_buckets: 2,
      },
    });
  });
});
