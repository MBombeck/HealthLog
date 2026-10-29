/**
 * Pins what each sleep window protects (`protectFreshRowsInWindows`): every
 * fresh row of the fetch that lies inside the window, from any session, and
 * nothing outside it. Handing every window the whole fetch's ids made a full
 * backfill send one query per night carrying every segment id of the history.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/crypto", () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired: vi.fn(async () => false),
  recordSyncFailure: vi.fn(async () => {}),
  recordSyncSuccess: vi.fn(async () => {}),
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: vi.fn(() => []),
  recomputeBucketsForMeasurement: vi.fn(async () => {}),
  recomputeUserRollups: vi.fn(async () => {}),
}));
vi.mock("@/lib/insights/status-invalidation", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));
vi.mock("../credentials", () => ({
  getUserGoogleHealthCredentials: vi.fn(async () => null),
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn(async () => "Europe/Berlin"),
}));
vi.mock("@/lib/daily/morning-refresh-trigger", () => ({
  maybeEnqueueMorningRefresh: vi.fn(async () => {}),
}));

import { protectFreshRowsInWindows } from "../sync-sleep";

const at = (iso: string) => new Date(iso);

describe("protectFreshRowsInWindows", () => {
  it("protects another session's fresh row inside the window", () => {
    const [main] = protectFreshRowsInWindows(
      [
        {
          windowStart: at("2026-10-01T22:00:00Z"),
          windowEnd: at("2026-10-02T06:00:00Z"),
          keepIds: ["main:a"],
        },
      ],
      [
        { externalId: "main:a", measuredAt: at("2026-10-01T23:00:00Z") },
        // A nap session reported over the same stretch of the night.
        { externalId: "nap:b", measuredAt: at("2026-10-02T03:00:00Z") },
      ],
    );
    expect(new Set(main!.keepIds)).toEqual(new Set(["main:a", "nap:b"]));
  });

  it("leaves out fresh rows from other nights, edges included", () => {
    const [w] = protectFreshRowsInWindows(
      [
        {
          windowStart: at("2026-10-01T22:00:00Z"),
          windowEnd: at("2026-10-02T06:00:00Z"),
          keepIds: ["own:a"],
        },
      ],
      [
        { externalId: "before", measuredAt: at("2026-10-01T21:59:59Z") },
        { externalId: "start", measuredAt: at("2026-10-01T22:00:00Z") },
        { externalId: "own:a", measuredAt: at("2026-10-02T01:00:00Z") },
        { externalId: "end", measuredAt: at("2026-10-02T06:00:00Z") },
        { externalId: "after", measuredAt: at("2026-10-02T06:00:01Z") },
      ],
    );
    expect(new Set(w!.keepIds)).toEqual(new Set(["own:a", "start", "end"]));
  });

  it("passes a window without bounds through unchanged", () => {
    const open = { windowStart: null, windowEnd: null, keepIds: [] };
    expect(
      protectFreshRowsInWindows(
        [open],
        [{ externalId: "x", measuredAt: at("2026-10-01T23:00:00Z") }],
      ),
    ).toEqual([open]);
  });

  it("keeps each night's set to that night on a five-year backfill", () => {
    const nights = 5 * 365;
    const windows = [];
    const readings = [];
    for (let n = 0; n < nights; n++) {
      const start = Date.UTC(2021, 0, 1, 22) + n * 86_400_000;
      const ids: string[] = [];
      for (let s = 0; s < 30; s++) {
        const id = `night${n}:sleep:${s}`;
        ids.push(id);
        readings.push({
          externalId: id,
          measuredAt: new Date(start + (s + 1) * 16 * 60_000),
        });
      }
      windows.push({
        windowStart: new Date(start),
        windowEnd: new Date(start + 8 * 3_600_000),
        keepIds: ids,
      });
    }
    const out = protectFreshRowsInWindows(windows, readings);
    expect(out).toHaveLength(nights);
    // Before, every one of the 1825 queries carried all 54750 ids.
    expect(Math.max(...out.map((w) => w.keepIds.length))).toBe(30);
  });
});
