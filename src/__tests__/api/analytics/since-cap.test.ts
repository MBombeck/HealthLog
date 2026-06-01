/**
 * v1.4.39 W-SINCE — defense-in-depth row cap on the live-fallback
 * per-type read.
 *
 * The v1.4.38.7 perf audit (`.planning/round-v1438-perf-analysis.md`
 * §1 A2) flagged the per-type `fetchMeasurementSeriesChunked` loop
 * inside `/api/analytics` as the dominant cost of Marc's 74.6 s cold
 * full-slice mount. v1.4.38.8 (commit 8a8150d2) relaxed the
 * `isFullyCovered` gate inside the three downstream fast-paths so the
 * walk became unreachable in the common case — but the A2 loop itself
 * has no fast-path gate. A regression that flips a fast-path back to
 * the all-types-required form would re-trigger the unbounded read.
 *
 * This file pins:
 *
 *   1. **The 425-day floor reaches `prisma.measurement.findMany`.**
 *      Every per-type read inside the default slice carries
 *      `where.measuredAt.gte` ≈ now − 425 days. QA Specialist-H2
 *      (v1.4.39) widened the original 90-day cap to 425 days so
 *      `summarize().avg30LastYear` (year-ago tile) stays populated
 *      on the live-fallback path. If a future refactor drops the
 *      `since` option from the chunked helper this test breaks loudly.
 *
 *   2. **The `meta.analytics.bp_aggregate.live_since` annotate fires.**
 *      Lets the next perf-verify see how far back the live-fallback
 *      read actually went. A widened window in a regression would
 *      surface in this annotation.
 *
 *   3. **The slim slice (`?slice=summaries`) is unaffected.** That
 *      branch never hit the per-type loop in the first place and
 *      keeps its own SQL aggregator.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

// Spy on the real `annotate` so we can assert the
// `meta.analytics.bp_aggregate.live_since` field while keeping the
// AsyncLocalStorage `eventStorage.run` wiring intact (the
// `apiHandler` opens an event scope inside `run()`).
vi.mock("@/lib/logging/context", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/logging/context")
  >("@/lib/logging/context");
  return {
    ...actual,
    annotate: vi.fn(actual.annotate),
  };
});

// The three fast-paths and the rollup helpers are exercised by their
// own tests; here we stub them so the route's per-type read is the
// only Prisma traffic the test observes.
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  ensureUserRollupsFresh: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@/lib/analytics/bp-in-target-fast-path", () => ({
  computeBpInTargetFastPath: vi.fn().mockResolvedValue({
    last7Days: null,
    last30Days: null,
    allTime: null,
    priorMonth: null,
    priorYear: null,
  }),
}));

vi.mock("@/lib/analytics/health-score-fast-path", () => ({
  computeUserHealthScoreFastPath: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/analytics/correlations-fast-path", () => ({
  computeCorrelationHypothesesFastPath: vi
    .fn()
    .mockResolvedValue({ hypotheses: [] }),
}));

vi.mock("@/lib/analytics/summaries-slice", () => ({
  computeSummariesSlice: vi.fn().mockResolvedValue({
    summaries: {},
    bmi: null,
    bpInTargetPct: null,
    lastSeenByType: {},
  }),
}));

import { GET } from "@/app/api/analytics/route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
// v1.4.49.1 — `annotate` import retired alongside the
// `bp_aggregate.live_since` annotation assertion (the annotation lived
// in the now-deleted per-type live walk). The surviving slim-slice
// invariant doesn't read annotate. Re-add this import if a future
// regression test needs to verify a wide-event field.
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";

const callGet = GET as unknown as (req: Request) => Promise<Response>;

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-since-1",
    username: "marc",
    role: "USER" as const,
    locale: "en",
    timezone: "Europe/Berlin",
    heightCm: null,
    dateOfBirth: null,
    sourcePriorityJson: null,
  },
};

beforeEach(async () => {
  vi.clearAllMocks();
  __resetAllCachesForTests();
  (getSession as ReturnType<typeof vi.fn>).mockResolvedValue(SESSION_OK);
  // Default: every per-type findMany returns an empty page so the
  // chunked loop terminates after the first call.
  (prisma.measurement.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
    [],
  );

  // Re-prime the fast-path / probe / slim-slice stubs because we use
  // `clearAllMocks()` to wipe call history between tests; `vi.fn()` at
  // module scope only sets the initial implementation, and the slim
  // slice test must observe a resolved value not `undefined`.
  const { ensureUserRollupsFresh } = await import(
    "@/lib/rollups/measurement-rollups"
  );
  const { probeRollupCoverage } = await import(
    "@/lib/rollups/measurement-coverage"
  );
  const { computeBpInTargetFastPath } = await import(
    "@/lib/analytics/bp-in-target-fast-path"
  );
  const { computeUserHealthScoreFastPath } = await import(
    "@/lib/analytics/health-score-fast-path"
  );
  const { computeCorrelationHypothesesFastPath } = await import(
    "@/lib/analytics/correlations-fast-path"
  );
  const { computeSummariesSlice } = await import(
    "@/lib/analytics/summaries-slice"
  );

  (ensureUserRollupsFresh as ReturnType<typeof vi.fn>).mockResolvedValue(
    undefined,
  );
  (probeRollupCoverage as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Map(),
  );
  (computeBpInTargetFastPath as ReturnType<typeof vi.fn>).mockResolvedValue({
    last7Days: null,
    last30Days: null,
    allTime: null,
    priorMonth: null,
    priorYear: null,
  });
  (computeUserHealthScoreFastPath as ReturnType<typeof vi.fn>).mockResolvedValue(
    null,
  );
  (
    computeCorrelationHypothesesFastPath as ReturnType<typeof vi.fn>
  ).mockResolvedValue({ hypotheses: [] });
  (computeSummariesSlice as ReturnType<typeof vi.fn>).mockResolvedValue({
    summaries: {},
    bmi: null,
    lastSeenByType: {},
  });
});

describe("GET /api/analytics — per-type live walk retired (v1.4.49.1)", () => {
  // v1.4.49.1 — the W-SINCE 425-day `since` cap was a defense-in-depth
  // bound on the now-deleted 15-way per-type live walk. The default
  // slice routes through `computeSummariesSlice` exclusively, which
  // reads `measurement_rollups` DAY buckets + a 90-day narrow
  // `$queryRaw` directly — no chunked findMany against `measurements`
  // at all on the default critical path. The two assertions that pinned
  // (a) the per-type `where.measuredAt.gte` and (b) the
  // `meta.analytics.bp_aggregate.live_since` annotate were removed
  // together because both code paths were deleted; the surviving
  // `slim ?slice=summaries` invariant below still pins that the slim
  // branch never reaches a chunked measurements walk.

  it("does not invoke the per-type loop on the slim `?slice=summaries` branch", async () => {
    const response = await callGet(
      new Request("http://localhost/api/analytics?slice=summaries"),
    );
    expect(response.status).toBe(200);

    // The slim slice resolves through `computeSummariesSlice` only;
    // the per-type findMany loop is skipped entirely so the rollup-
    // path semantics are unaffected by the `since` cap.
    const findMany = prisma.measurement.findMany as ReturnType<typeof vi.fn>;
    expect(findMany).not.toHaveBeenCalled();
  });
});
