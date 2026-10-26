/**
 * v1.12.1 — `runFitbitPollCohort` bounded-concurrency + per-user isolation.
 *
 * The hourly Fitbit cron carries no `userId`, so the worker resolves every
 * connection and hands the cohort to `runFitbitPollCohort`. These tests pin the
 * contract that matters for a growing cohort:
 *   - the pool never runs more than `concurrency` users at once (one slow
 *     Google response can't stall the whole pass — the others proceed);
 *   - a single user's failure is isolated (reported, not thrown) and the rest
 *     of the cohort still syncs;
 *   - the per-cohort totals add up across the pool.
 */
import { describe, expect, it, vi } from "vitest";

// `runFitbitPollCohort` is exercised with an injected `sync` fn so the real
// per-resource modules + db are never touched.
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => s,
  decrypt: (s: string) => s,
}));
vi.mock("@/lib/logging/context", () => ({
  getEvent: () => null,
  annotate: () => {},
}));
vi.mock("@/lib/integrations/status", () => ({
  recordSyncFailure: vi.fn(async () => {}),
  recordSyncSuccess: vi.fn(async () => {}),
  isReauthRequired: vi.fn(async () => false),
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: (r: unknown) => r,
  recomputeBucketsForMeasurement: vi.fn(async () => {}),
  recomputeUserRollups: vi.fn(async () => ({ rowsUpserted: 0, durationMs: 0 })),
}));
vi.mock("@/lib/insights/status-invalidation", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));

import { FITBIT_POLL_CONCURRENCY, runFitbitPollCohort } from "../sync";

/**
 * A sync fn that records the peak number of simultaneously-in-flight calls.
 * Each call yields across several microtask/timer ticks so the pool genuinely
 * overlaps work — if `runFitbitPollCohort` ran serially, peak would stay 1; if
 * it ran unbounded, peak would reach the cohort size.
 */
function trackingSync(perCall = 1) {
  let inFlight = 0;
  const state = { peak: 0 };
  const sync = vi.fn(async () => {
    inFlight++;
    state.peak = Math.max(state.peak, inFlight);
    // Several real-timer ticks so overlapping calls actually coexist.
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return perCall;
  });
  return { sync, state };
}

describe("runFitbitPollCohort — bounded concurrency", () => {
  it("overlaps work but never runs more than the concurrency cap at once", async () => {
    const { sync, state } = trackingSync(1);

    const { usersSynced, measurementsImported } = await runFitbitPollCohort(
      Array.from({ length: 10 }, (_, i) => String(i)),
      { concurrency: 3, sync },
    );

    // Bounded: never more than 3 at once …
    expect(state.peak).toBeLessThanOrEqual(3);
    // … yet genuinely parallel (a serial loop would peak at 1).
    expect(state.peak).toBeGreaterThan(1);
    expect(usersSynced).toBe(10);
    expect(measurementsImported).toBe(10);
    expect(sync).toHaveBeenCalledTimes(10);
  });

  it("isolates a per-user failure — the rest of the cohort still syncs", async () => {
    const onUserError = vi.fn();
    const sync = vi.fn(async (userId: string) => {
      if (userId === "boom") throw new Error("google 500");
      return 2;
    });

    const { usersSynced, measurementsImported } = await runFitbitPollCohort(
      ["a", "boom", "b"],
      { concurrency: 2, sync, onUserError },
    );

    // The failing user is captured, not thrown; the other two complete.
    expect(usersSynced).toBe(2);
    expect(measurementsImported).toBe(4);
    expect(onUserError).toHaveBeenCalledTimes(1);
    expect(onUserError.mock.calls[0]![0]).toBe("boom");
  });

  it("defaults the concurrency cap to FITBIT_POLL_CONCURRENCY", async () => {
    const { sync, state } = trackingSync(0);

    await runFitbitPollCohort(
      Array.from({ length: 12 }, (_, i) => String(i)),
      { sync },
    );

    expect(state.peak).toBeLessThanOrEqual(FITBIT_POLL_CONCURRENCY);
    expect(sync).toHaveBeenCalledTimes(12);
  });

  it("returns zero totals for an empty cohort without running anything", async () => {
    const sync = vi.fn(async () => 1);
    const res = await runFitbitPollCohort([], { sync });
    expect(res).toEqual({ usersSynced: 0, measurementsImported: 0 });
    expect(sync).not.toHaveBeenCalled();
  });
});
