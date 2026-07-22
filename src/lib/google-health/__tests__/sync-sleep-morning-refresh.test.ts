/**
 * v1.29.1 — pins the S4 morning-digest-refresh wiring on the Google Health
 * sleep transport. Google Health is a first-class sleep source, but the
 * sleep-arrival trigger (`maybeEnqueueMorningRefresh`) was only hooked into
 * Withings / WHOOP / Apple, so a Google-Health user's morning refresh never
 * fired and their day stayed stuck at the 04:30 nightly pre-pass.
 *
 * This asserts a Google-sourced last-night sleep segment landing enqueues the
 * debounced refresh EXACTLY once, with the segment's `measuredAt` — mirroring
 * the existing transport trigger contract. The debounce itself (one refresh
 * per user per local morning) is covered in `morning-refresh-trigger.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sleepMeasuredAt = new Date("2026-06-02T05:30:00.000Z");

const {
  fetchDataPointsMock,
  mapSleepSessionDetailedMock,
  upsertMock,
  maybeEnqueueMorningRefreshMock,
} = vi.hoisted(() => ({
  fetchDataPointsMock: vi.fn(),
  mapSleepSessionDetailedMock: vi.fn(),
  upsertMock: vi.fn(),
  maybeEnqueueMorningRefreshMock: vi.fn(async () => {}),
}));

vi.mock("../client", () => ({
  GOOGLE_HEALTH_ACTIVITY_PAGE_SIZE: 100,
  GOOGLE_HEALTH_DATA_TYPES: { sleep: "sleep" },
  fetchDataPoints: fetchDataPointsMock,
  mapSleepSessionDetailed: mapSleepSessionDetailedMock,
}));

vi.mock("../sync-core", () => ({
  getValidToken: vi.fn(async () => ({ accessToken: "tok" })),
  handleCollectionFetchError: vi.fn(() => 0),
  noteHardFailure: vi.fn(),
  replaceStaleGoogleHealthSleep: vi.fn(async () => 0),
  upsertGoogleHealthMeasurements: upsertMock,
}));

vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn(async () => "Europe/Berlin"),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
}));

vi.mock("@/lib/daily/morning-refresh-trigger", () => ({
  maybeEnqueueMorningRefresh: maybeEnqueueMorningRefreshMock,
}));

import { syncUserSleep } from "../sync-sleep";

beforeEach(() => {
  vi.clearAllMocks();
  fetchDataPointsMock.mockResolvedValue([{ raw: "point" }]);
  mapSleepSessionDetailedMock.mockReturnValue({
    rows: [
      {
        type: "SLEEP_DURATION",
        value: 480,
        unit: "min",
        measuredAt: sleepMeasuredAt,
        fieldTag: "anchor:sleep:a",
        sleepStage: null,
      },
    ],
    windowStart: new Date("2026-06-01T22:00:00.000Z"),
    windowEnd: sleepMeasuredAt,
  });
  upsertMock.mockImplementation(
    async (
      _userId: string,
      readings: Array<{ type: string; measuredAt: Date }>,
    ) => ({
      imported: readings.length,
      touched: readings,
      inserted: readings.map((row, index) => ({
        id: `inserted-${index}`,
        type: row.type,
        measuredAt: row.measuredAt,
      })),
    }),
  );
});

describe("google-health syncUserSleep — S4 morning-refresh trigger", () => {
  it("enqueues exactly one morning refresh with the sleep segment's measuredAt", async () => {
    await syncUserSleep("user-1");

    expect(maybeEnqueueMorningRefreshMock).toHaveBeenCalledTimes(1);
    expect(maybeEnqueueMorningRefreshMock).toHaveBeenCalledWith("user-1", [
      sleepMeasuredAt,
    ]);
  });

  it("does not refresh for an existing sleep row updated in place", async () => {
    upsertMock.mockResolvedValue({
      imported: 1,
      touched: [{ type: "SLEEP_DURATION", measuredAt: sleepMeasuredAt }],
      inserted: [],
    });

    await syncUserSleep("user-1");

    expect(maybeEnqueueMorningRefreshMock).toHaveBeenCalledWith("user-1", []);
  });

  it("passes no sleep timestamps when the night carried no SLEEP_DURATION rows", async () => {
    mapSleepSessionDetailedMock.mockReturnValue({
      rows: [
        {
          type: "HEART_RATE",
          value: 55,
          unit: "bpm",
          measuredAt: sleepMeasuredAt,
          fieldTag: "hr:a",
          sleepStage: null,
        },
      ],
      windowStart: new Date("2026-06-01T22:00:00.000Z"),
      windowEnd: sleepMeasuredAt,
    });

    await syncUserSleep("user-1");

    // Still called once (the trigger self-gates on an empty array), but with no
    // sleep timestamps — so it no-ops rather than refreshing on non-sleep rows.
    expect(maybeEnqueueMorningRefreshMock).toHaveBeenCalledTimes(1);
    expect(maybeEnqueueMorningRefreshMock).toHaveBeenCalledWith("user-1", []);
  });
});
