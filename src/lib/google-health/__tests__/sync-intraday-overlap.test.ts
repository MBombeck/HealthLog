/**
 * v1.42 (#1023) — intraday heart rate re-reads two hours, not a day.
 *
 * Every hourly sync re-read the last 24 hours of every Google Health type,
 * because daily summaries and sleep are re-scored after the fact. A
 * per-minute heart-rate stream does not change once written, and re-reading
 * a whole day of it each hour was 38 to 40 pages per sync on a slow host.
 * Heart rate now uses the short intraday overlap; daily summaries keep the
 * full day.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));

vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...actual, safeFetch: safeFetchMock };
});

vi.mock("../sync-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sync-core")>();
  return {
    ...actual,
    getValidToken: vi.fn(async () => ({
      accessToken: "token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })),
    handleCollectionFetchError: vi.fn(async () => 0),
    upsertGoogleHealthMeasurements: vi.fn(async () => ({
      imported: 0,
      touched: [],
      inserted: [],
    })),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() } },
}));

vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn(async () => "UTC"),
}));

import {
  GOOGLE_HEALTH_DEFAULT_OVERLAP_MS,
  GOOGLE_HEALTH_INTRADAY_OVERLAP_MS,
  incrementalStart,
} from "../sync-core";
import { syncUserMetrics } from "../sync-metrics";

const LAST_SYNC = new Date("2026-10-08T03:00:00.000Z");

/** The `filter` the request for one data-type path carried. */
function filterFor(path: string): string | null {
  const call = safeFetchMock.mock.calls.find((c) =>
    new URL(c[0] as string).pathname.endsWith(`/dataTypes/${path}/dataPoints`),
  );
  return call ? new URL(call[0] as string).searchParams.get("filter") : null;
}

beforeEach(() => {
  safeFetchMock.mockReset().mockImplementation(async () => ({
    status: 200,
    ok: true,
    json: async () => ({ dataPoints: [] }),
  }));
});

describe("Google Health incremental overlap", () => {
  it("keeps a day for summaries and narrows intraday samples to two hours", () => {
    expect(GOOGLE_HEALTH_DEFAULT_OVERLAP_MS).toBe(24 * 60 * 60 * 1000);
    expect(GOOGLE_HEALTH_INTRADAY_OVERLAP_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("reads heart rate from the intraday start and resting heart rate from the day start", async () => {
    const start = incrementalStart(LAST_SYNC);
    const intradayStart = incrementalStart(LAST_SYNC, {
      overlapMs: GOOGLE_HEALTH_INTRADAY_OVERLAP_MS,
    });

    await syncUserMetrics("u1", { start, intradayStart });

    expect(filterFor("heart-rate")).toBe(
      'heart_rate.sample_time.physical_time >= "2026-10-08T01:00:00.000Z"',
    );
    expect(filterFor("daily-resting-heart-rate")).toBe(
      'dailyRestingHeartRate.date >= "2026-10-07"',
    );
  });
});
