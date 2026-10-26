import { beforeEach, describe, expect, it, vi } from "vitest";

const { createManyAndReturnMock, findFirstMock, updateMock, safeFetchMock } =
  vi.hoisted(() => ({
    createManyAndReturnMock: vi.fn(),
    findFirstMock: vi.fn(),
    updateMock: vi.fn(),
    safeFetchMock: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      createManyAndReturn: createManyAndReturnMock,
      findFirst: findFirstMock,
    },
    workout: {
      createManyAndReturn: createManyAndReturnMock,
      update: updateMock,
    },
  },
}));
vi.mock("@/lib/safe-fetch", () => ({ safeFetch: safeFetchMock }));
vi.mock("@/lib/arrivals/measurement-emit", () => ({
  emitInsertedMeasurementArrivals: vi.fn(async () => {}),
}));
vi.mock("@/lib/arrivals/workout-emit", () => ({
  emitInsertedWorkoutArrival: vi.fn(async () => {}),
}));
vi.mock("@/lib/rollups/measurement-rollups", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/rollups/measurement-rollups")
  >()),
  recomputeBucketsForKeys: vi.fn(async () => {}),
}));
vi.mock("@/lib/insights/status-invalidation", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));

import { mapHeartRateSample } from "@/lib/oura/map";
import { OuraApiError } from "../response-classifier";
import { mapOuraSportType } from "../sport-map";
import {
  OURA_HEART_RATE_LOOKBACK_HOURS,
  OURA_HEART_RATE_MAX_LOOKBACK_HOURS,
  OURA_HEART_RATE_WRITE_CHUNK,
  resolveOuraHeartRateWindow,
  syncOuraHeartRateRange,
} from "../sync-heart-rate";
import { mapOuraWorkout, upsertOuraWorkouts } from "../sync-workouts";

const HOUR = 60 * 60 * 1000;

function jsonResponse(body: unknown, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

beforeEach(() => {
  createManyAndReturnMock.mockReset();
  findFirstMock.mockReset();
  updateMock.mockReset();
  safeFetchMock.mockReset();
});

describe("mapOuraSportType", () => {
  it("maps Oura's labels onto the canonical buckets", () => {
    expect(mapOuraSportType("walking")).toBe("walking");
    expect(mapOuraSportType("strength_training")).toBe("strength");
    expect(mapOuraSportType("Strength Training")).toBe("strength");
    expect(mapOuraSportType("cycling")).toBe("cycling");
    expect(mapOuraSportType("kayaking")).toBe("rowing");
    expect(mapOuraSportType("cross_country_skiing")).toBe("other");
  });

  it("lands an unknown or blank label on other", () => {
    expect(mapOuraSportType("underwater_hockey")).toBe("other");
    expect(mapOuraSportType("")).toBe("other");
    expect(mapOuraSportType(null)).toBe("other");
  });
});

describe("mapOuraWorkout", () => {
  const base = {
    id: "w-1",
    activity: "cycling",
    calories: 412.6,
    distance: 18250.4,
    intensity: "moderate",
    source: "autodetected",
    label: "Commute with a friend",
    start_datetime: "2026-10-01T07:00:00+02:00",
    end_datetime: "2026-10-01T07:45:30+02:00",
  };

  it("maps times, energy, real distance and provenance", () => {
    expect(mapOuraWorkout(base)).toEqual({
      externalId: "w-1",
      sportType: "cycling",
      startedAt: new Date("2026-10-01T05:00:00Z"),
      endedAt: new Date("2026-10-01T05:45:30Z"),
      durationSec: 2730,
      totalEnergyKcal: 413,
      totalDistanceM: 18250.4,
      metadata: {
        ouraActivity: "cycling",
        ouraIntensity: "moderate",
        ouraSource: "autodetected",
      },
    });
  });

  it("never carries the person's free-text label", () => {
    expect(JSON.stringify(mapOuraWorkout(base))).not.toContain("Commute");
  });

  it("refuses a record without an id or with an end before its start", () => {
    expect(mapOuraWorkout({ ...base, id: "" })).toBeNull();
    expect(
      mapOuraWorkout({ ...base, end_datetime: "2026-10-01T06:00:00+02:00" }),
    ).toBeNull();
    expect(mapOuraWorkout({ ...base, start_datetime: "nope" })).toBeNull();
  });

  it("keeps a missing energy or distance null rather than zero", () => {
    const row = mapOuraWorkout({ ...base, calories: null, distance: -1 });
    expect(row?.totalEnergyKcal).toBeNull();
    expect(row?.totalDistanceM).toBeNull();
  });
});

describe("upsertOuraWorkouts", () => {
  it("inserts a new workout and overwrites an existing one in place", async () => {
    const row = mapOuraWorkout({
      id: "w-1",
      activity: "running",
      start_datetime: "2026-10-01T07:00:00Z",
      end_datetime: "2026-10-01T07:30:00Z",
    })!;
    createManyAndReturnMock
      .mockResolvedValueOnce([{ id: "x", startedAt: row.startedAt }])
      .mockResolvedValueOnce([]);
    expect(await upsertOuraWorkouts("u1", [row])).toBe(1);
    expect(createManyAndReturnMock.mock.calls[0]![0].data).toMatchObject({
      userId: "u1",
      source: "OURA",
      externalId: "w-1",
      sportType: "running",
    });
    expect(updateMock).not.toHaveBeenCalled();

    expect(await upsertOuraWorkouts("u1", [row])).toBe(1);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_source_externalId: {
            userId: "u1",
            source: "OURA",
            externalId: "w-1",
          },
        },
      }),
    );
  });
});

describe("mapHeartRateSample", () => {
  it("maps a sample to a PULSE row keyed on its instant", () => {
    expect(
      mapHeartRateSample({
        bpm: 61.4,
        source: "awake",
        timestamp: "2026-10-01T10:05:00+00:00",
      }),
    ).toEqual({
      type: "PULSE",
      value: 61,
      unit: "bpm",
      measuredAt: new Date("2026-10-01T10:05:00Z"),
      fieldTag: "hr",
      externalId: "heartrate:2026-10-01T10:05:00.000Z",
    });
  });

  it("drops a sample without an instant or outside a human band", () => {
    expect(mapHeartRateSample({ bpm: 60, timestamp: null })).toBeNull();
    expect(mapHeartRateSample({ bpm: 60, timestamp: "x" })).toBeNull();
    expect(
      mapHeartRateSample({ bpm: 0, timestamp: "2026-10-01T10:05:00Z" }),
    ).toBeNull();
    expect(
      mapHeartRateSample({ bpm: 400, timestamp: "2026-10-01T10:05:00Z" }),
    ).toBeNull();
  });
});

describe("syncOuraHeartRateRange", () => {
  it("writes every page as it arrives, in bounded batches, following next_token", async () => {
    const start = new Date("2026-10-01T00:00:00Z");
    const page = (offset: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        bpm: 60,
        source: "awake",
        timestamp: new Date(
          start.getTime() + (offset + i) * 60_000,
        ).toISOString(),
      }));
    safeFetchMock
      .mockResolvedValueOnce(
        jsonResponse({ data: page(0, 1200), next_token: "p2" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: page(1200, 10), next_token: null }),
      );
    createManyAndReturnMock.mockImplementation(
      async ({ data }: { data: Array<{ measuredAt: Date }> }) =>
        data.map((d, i) => ({ id: `r${i}`, type: "PULSE", ...d })),
    );

    const result = await syncOuraHeartRateRange("u1", "tok", {
      start,
      end: new Date(start.getTime() + 2 * 24 * HOUR),
    });

    expect(result).toEqual({ imported: 1210, truncated: false });
    // 1 200 samples in chunks of 500, then the second page.
    expect(
      createManyAndReturnMock.mock.calls.map(([a]) => a.data.length),
    ).toEqual([
      OURA_HEART_RATE_WRITE_CHUNK,
      OURA_HEART_RATE_WRITE_CHUNK,
      200,
      10,
    ]);
    expect(createManyAndReturnMock.mock.calls[0]![0].skipDuplicates).toBe(true);
    const firstUrl = new URL(safeFetchMock.mock.calls[0]![0] as string);
    expect(firstUrl.pathname).toBe("/v2/usercollection/heartrate");
    expect(firstUrl.searchParams.get("start_datetime")).toBe(
      start.toISOString(),
    );
    const secondUrl = new URL(safeFetchMock.mock.calls[1]![0] as string);
    expect(secondUrl.searchParams.get("next_token")).toBe("p2");
  });

  it("carries Retry-After on a 429", async () => {
    safeFetchMock.mockResolvedValueOnce(
      jsonResponse({ detail: "slow down" }, 429, { "retry-after": "120" }),
    );
    const err = await syncOuraHeartRateRange("u1", "tok", {
      start: new Date("2026-10-01T00:00:00Z"),
      end: new Date("2026-10-02T00:00:00Z"),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OuraApiError);
    expect((err as OuraApiError).retryAfterMs).toBe(120_000);
    expect((err as OuraApiError).classification).toBe("transient");
  });
});

describe("resolveOuraHeartRateWindow", () => {
  const now = new Date("2026-10-21T12:00:00Z");

  it("reads the last few hours while readings are flowing", async () => {
    findFirstMock.mockResolvedValue({
      measuredAt: new Date(now.getTime() - 20 * 60_000),
    });
    const w = await resolveOuraHeartRateWindow("u1", now);
    expect(now.getTime() - w.start.getTime()).toBe(
      OURA_HEART_RATE_LOOKBACK_HOURS * HOUR,
    );
    expect(w.end).toEqual(now);
  });

  it("reaches back to the newest reading after a gap, up to the ceiling", async () => {
    findFirstMock.mockResolvedValueOnce({
      measuredAt: new Date(now.getTime() - 30 * HOUR),
    });
    let w = await resolveOuraHeartRateWindow("u1", now);
    expect(now.getTime() - w.start.getTime()).toBe(31 * HOUR);

    findFirstMock.mockResolvedValueOnce({
      measuredAt: new Date(now.getTime() - 30 * 24 * HOUR),
    });
    w = await resolveOuraHeartRateWindow("u1", now);
    expect(now.getTime() - w.start.getTime()).toBe(
      OURA_HEART_RATE_MAX_LOOKBACK_HOURS * HOUR,
    );
  });

  it("leaves history to the backfill on a fresh connection", async () => {
    findFirstMock.mockResolvedValue(null);
    const w = await resolveOuraHeartRateWindow("u1", now);
    expect(now.getTime() - w.start.getTime()).toBe(
      OURA_HEART_RATE_LOOKBACK_HOURS * HOUR,
    );
  });
});
