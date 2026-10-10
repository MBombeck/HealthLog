/**
 * v1.42 — a watch worn without its phone uploads hours late.
 *
 * Those samples keep their original sample time. With a two-hour intraday
 * overlap measured from `lastSyncedAt` (stamped at the end of every clean
 * cycle), anything that reaches Google's cloud more than two hours late was
 * never fetched. The first cycle of each local day now reads intraday samples
 * with the full day of overlap; later cycles that day stay at two hours.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, metrics } = vi.hoisted(() => ({
  prismaMock: {
    integrationStatus: { findUnique: vi.fn(async () => null) },
    googleHealthConnection: {
      findUnique: vi.fn(),
      update: vi.fn(async () => ({})),
    },
  },
  metrics: vi.fn(async (_userId: string, _opts: unknown) => 0),
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

// The account lock is a Postgres advisory lock on a connection of its own;
// these cases run without a database, so the lock is always free.
vi.mock("../sync-lock", () => ({
  withGoogleHealthSyncLock: async (
    _userId: string,
    run: () => Promise<unknown>,
  ) => ({
    ran: true,
    result: await run(),
  }),
}));
vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired: vi.fn(async () => false),
  recordSyncSuccess: vi.fn(async () => {}),
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn(async () => "Europe/Berlin"),
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: vi.fn(() => []),
  recomputeUserRollups: vi.fn(async () => {}),
}));
vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));
vi.mock("../sync-workout", () => ({ syncUserWorkout: vi.fn(async () => 0) }));
vi.mock("../sync-sleep", () => ({ syncUserSleep: vi.fn(async () => 0) }));
vi.mock("../sync-activity", () => ({ syncUserActivity: vi.fn(async () => 0) }));
vi.mock("../sync-metrics", () => ({ syncUserMetrics: metrics }));

import {
  GOOGLE_HEALTH_DEFAULT_OVERLAP_MS,
  GOOGLE_HEALTH_INTRADAY_OVERLAP_MS,
  intradayOverlapMs,
} from "../sync-core";
import { syncUserGoogleHealth } from "../sync";

const HOUR = 60 * 60 * 1000;

function intradayStartOfLastCall(): Date | undefined {
  const opts = metrics.mock.calls.at(-1)?.[1] as
    { intradayStart?: Date } | undefined;
  return opts?.intradayStart;
}

beforeEach(() => {
  vi.useRealTimers();
  metrics.mockClear();
});

describe("intradayOverlapMs", () => {
  it("is wide on the first cycle of a local day and narrow after", () => {
    const now = new Date("2026-10-08T06:00:00.000Z"); // 08:00 Berlin
    // 23:30 Berlin the evening before: a new local day.
    expect(
      intradayOverlapMs(
        new Date("2026-10-07T21:30:00.000Z"),
        "Europe/Berlin",
        now,
      ),
    ).toBe(GOOGLE_HEALTH_DEFAULT_OVERLAP_MS);
    // 07:00 Berlin the same morning: same local day.
    expect(
      intradayOverlapMs(
        new Date("2026-10-08T05:00:00.000Z"),
        "Europe/Berlin",
        now,
      ),
    ).toBe(GOOGLE_HEALTH_INTRADAY_OVERLAP_MS);
  });

  it("uses the local day, not the UTC day", () => {
    // 23:30 UTC on the 7th is 01:30 Berlin on the 8th: same local day as now.
    const now = new Date("2026-10-08T06:00:00.000Z");
    expect(
      intradayOverlapMs(
        new Date("2026-10-07T23:30:00.000Z"),
        "Europe/Berlin",
        now,
      ),
    ).toBe(GOOGLE_HEALTH_INTRADAY_OVERLAP_MS);
  });
});

describe("syncUserGoogleHealth intraday window", () => {
  it("reads a full day of intraday samples on the first cycle of the day", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-08T06:00:00.000Z") });
    const lastSyncedAt = new Date("2026-10-07T21:00:00.000Z");
    prismaMock.googleHealthConnection.findUnique.mockResolvedValue({
      lastSyncedAt,
    });

    await syncUserGoogleHealth("late-watch-user");

    expect(intradayStartOfLastCall()?.toISOString()).toBe(
      new Date(lastSyncedAt.getTime() - 24 * HOUR).toISOString(),
    );
  });

  it("keeps the two-hour window for later cycles of the same day", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-08T10:00:00.000Z") });
    const lastSyncedAt = new Date("2026-10-08T09:00:00.000Z");
    prismaMock.googleHealthConnection.findUnique.mockResolvedValue({
      lastSyncedAt,
    });

    await syncUserGoogleHealth("late-watch-user");

    expect(intradayStartOfLastCall()?.toISOString()).toBe(
      new Date(lastSyncedAt.getTime() - 2 * HOUR).toISOString(),
    );
  });
});
