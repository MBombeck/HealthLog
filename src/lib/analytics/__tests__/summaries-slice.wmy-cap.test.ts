/**
 * v1.4.43 — pins the `p-limit(4)` cap on the WMY per-type fan-out
 * inside the slim summaries slice.
 *
 * The pre-fix `computeAvg30LastYearMap` ran an unbounded `Promise.all`
 * over every type the user had data for. On a 15-type tenant the
 * burst held 15+ Prisma slots simultaneously, drowning the `pg.Pool`
 * max=20 when the slim and thick analytics slices fired in parallel
 * on dashboard mount (`.planning/round-v1443-AUDIT-analytics-9s-findings.md`).
 *
 * This test mirrors the v1.4.40 W-POOL pin
 * (`src/app/api/analytics/__tests__/route.test.ts` —
 * "pin concurrency cap and pool ceiling"). It mocks
 * `readBestGranularityRollups` with a controllable promise so we can
 * observe the in-flight count at the helper boundary and assert it
 * never exceeds 4 across a 15-type fan-out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  readBestGranularityRollups: vi.fn(),
}));

import { readBestGranularityRollups } from "@/lib/rollups/measurement-read-wmy";
import {
  WMY_FANOUT_CONCURRENCY,
  computeAvg30LastYearMap,
} from "../summaries-slice";

const READ = readBestGranularityRollups as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  READ.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computeAvg30LastYearMap — WMY fan-out cap (v1.4.43)", () => {
  it("pins the module-level concurrency constant at 4", () => {
    // Catches accidental loosening of the cap in a future edit. The
    // route-level `ANALYTICS_TYPE_FETCH_CONCURRENCY` uses the same
    // value; both must move together if ever revisited.
    expect(WMY_FANOUT_CONCURRENCY).toBe(4);
  });

  it("holds at most 4 concurrent readBestGranularityRollups calls for a 15-type list", async () => {
    let inFlight = 0;
    let peak = 0;
    const resolvers: Array<() => void> = [];

    READ.mockImplementation(() => {
      inFlight += 1;
      if (inFlight > peak) peak = inFlight;
      return new Promise((resolve) => {
        resolvers.push(() => {
          inFlight -= 1;
          // Resolve with `null` — the helper treats no-coverage as
          // `null` in the output map, which is fine for this test.
          resolve(null);
        });
      });
    });

    const types = Array.from({ length: 15 }, (_, i) => `TYPE_${i}`);
    const promise = computeAvg30LastYearMap("user-1", types);

    // Let the scheduler hand out the initial batch before we start
    // draining. Two macrotask flushes is enough for `p-limit` to fill
    // its slots up to the cap.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(peak).toBeLessThanOrEqual(WMY_FANOUT_CONCURRENCY);
    expect(peak).toBeGreaterThan(0);

    // Drain the queued resolvers one at a time, re-checking the peak
    // after each release so a future regression that floods the
    // pool on completion would also be caught.
    while (resolvers.length > 0) {
      const next = resolvers.shift();
      next?.();
      // Yield so `p-limit` can schedule the next slot before we
      // observe again.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(peak).toBeLessThanOrEqual(WMY_FANOUT_CONCURRENCY);
    }

    await promise;

    // Every type must still have been probed — capping must not
    // drop work.
    expect(READ).toHaveBeenCalledTimes(types.length);
    expect(peak).toBe(WMY_FANOUT_CONCURRENCY);
  });

  it("returns an empty map without invoking the reader when given no types", async () => {
    const result = await computeAvg30LastYearMap("user-1", []);
    expect(result.size).toBe(0);
    expect(READ).not.toHaveBeenCalled();
  });
});
