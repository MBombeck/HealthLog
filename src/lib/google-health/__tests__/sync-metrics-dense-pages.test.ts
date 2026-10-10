/**
 * #1023 — a dense heart-rate collection is written page by page.
 *
 * Intraday heart rate is one point a minute. `syncUserMetrics` used to collect
 * the whole collection, map all of it, and hand every reading to one upsert,
 * so a full-history backfill held a million raw points and a million readings
 * at once and ran a 1 GB heap out of memory (the reproduction on 1.3 M
 * readings dies within seconds of the walk). The contract pinned here: every
 * upsert carries at most one page, and a page is written before the next one
 * is requested, so nothing but the current page is ever resident.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { safeFetchMock, upsertMock, events, shape } = vi.hoisted(() => ({
  safeFetchMock: vi.fn(),
  upsertMock: vi.fn(),
  events: [] as string[],
  /** How the fake heart-rate collection is cut into pages. */
  shape: { pages: 3, perPage: 0 },
}));

vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...actual, safeFetch: safeFetchMock };
});

vi.mock("../sync-core", () => ({
  getValidToken: vi.fn(async () => ({ accessToken: "token" })),
  handleCollectionFetchError: vi.fn(async () => 0),
  upsertGoogleHealthMeasurements: upsertMock,
  googleHealthTokenSource:
    (_userId: string, info: { accessToken: string }) => async () =>
      info.accessToken,
  runGoogleHealthCollection: (_key: string, fn: () => Promise<number>) => fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() } },
}));

vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn(async () => "UTC"),
}));

import {
  GOOGLE_HEALTH_PAGE_SIZE,
  runWithGoogleHealthClientOutcome,
} from "../client";
import { syncUserMetrics } from "../sync-metrics";

const PAGES = 3;
const NOW = Date.parse("2026-09-27T17:00:00.000Z");

function heartRatePage(page: number): unknown {
  const dataPoints = [];
  for (let i = 0; i < shape.perPage; i++) {
    const g = page * shape.perPage + i;
    dataPoints.push({
      heartRate: {
        beatsPerMinute: String(55 + (g % 50)),
        sampleTime: { physicalTime: new Date(NOW - g * 60_000).toISOString() },
      },
    });
  }
  return {
    dataPoints,
    ...(page + 1 < shape.pages ? { nextPageToken: String(page + 1) } : {}),
  };
}

beforeEach(() => {
  shape.pages = PAGES;
  shape.perPage = GOOGLE_HEALTH_PAGE_SIZE;
  events.length = 0;
  upsertMock.mockReset().mockImplementation(async (_u, readings: unknown[]) => {
    events.push(`upsert:${readings.length}`);
    return { imported: readings.length, touched: [], inserted: [] };
  });
  safeFetchMock.mockReset().mockImplementation(async (url: string) => {
    const u = new URL(url);
    let body: unknown = {};
    if (u.pathname.endsWith("/dataTypes/heart-rate/dataPoints")) {
      const page = Number(u.searchParams.get("pageToken") ?? 0);
      events.push(`fetch:${page}`);
      body = heartRatePage(page);
    }
    return {
      status: 200,
      ok: true,
      json: async () => body,
    } as unknown as Response;
  });
});

describe("syncUserMetrics over a dense heart-rate collection", () => {
  it("writes each page before the next one is requested", async () => {
    const imported = await syncUserMetrics("dense-user", {
      deferRollup: true,
    });

    expect(imported).toBe(PAGES * GOOGLE_HEALTH_PAGE_SIZE);
    const pulseWrites = upsertMock.mock.calls
      .map((c) => c[1] as Array<{ type: string }>)
      .filter((readings) => readings.some((r) => r.type === "PULSE"));
    expect(pulseWrites).toHaveLength(PAGES);
    for (const readings of pulseWrites) {
      expect(readings.length).toBeLessThanOrEqual(GOOGLE_HEALTH_PAGE_SIZE);
    }
    const hr = events.filter(
      (e) =>
        e.startsWith("fetch:") || e === `upsert:${GOOGLE_HEALTH_PAGE_SIZE}`,
    );
    expect(hr).toEqual([
      "fetch:0",
      `upsert:${GOOGLE_HEALTH_PAGE_SIZE}`,
      "fetch:1",
      `upsert:${GOOGLE_HEALTH_PAGE_SIZE}`,
      "fetch:2",
      `upsert:${GOOGLE_HEALTH_PAGE_SIZE}`,
    ]);
  });

  it("walks a heart-rate history longer than a thousand pages to its end", async () => {
    // A thousand pages is a million points: under two years of one reading a
    // minute. The old ceiling ended every longer history truncated, which the
    // backfill reads as incomplete, so it retried the whole walk forever.
    shape.pages = 1_001;
    shape.perPage = 1;

    const { outcome } = await runWithGoogleHealthClientOutcome(() =>
      syncUserMetrics("dense-user", { deferRollup: true }),
    );

    expect(events.filter((e) => e.startsWith("fetch:"))).toHaveLength(1_001);
    expect(outcome.truncated).toBe(false);
  });
});
