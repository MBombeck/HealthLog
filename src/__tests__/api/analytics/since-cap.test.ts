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
import { annotate } from "@/lib/logging/context";
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

describe("GET /api/analytics — live-fallback `since` cap (W-SINCE)", () => {
  it("passes a trailing-425-day `where.measuredAt.gte` to every per-type findMany", async () => {
    const before = Date.now();
    const response = await callGet(
      new Request("http://localhost/api/analytics"),
    );
    expect(response.status).toBe(200);
    const after = Date.now();

    const findMany = prisma.measurement.findMany as ReturnType<typeof vi.fn>;
    expect(findMany.mock.calls.length).toBeGreaterThan(0);

    // QA Specialist-H2 (v1.4.39): 425 days = 365 (year-ago window) +
    // 30 (avg30LastYear bucket span) + 30 (cache-aging buffer).
    const FOUR_TWENTY_FIVE_DAYS_MS = 425 * 24 * 60 * 60 * 1000;
    const expectedMinSince = before - FOUR_TWENTY_FIVE_DAYS_MS;
    const expectedMaxSince = after - FOUR_TWENTY_FIVE_DAYS_MS;

    // The per-type loop (A2) issues chunked reads with an `orderBy`
    // *array* (`(measuredAt asc, id asc)`); the 30-day glucose and
    // 30-day sleep-stage reads use either a single-object orderBy or
    // none at all. Filtering on the array shape isolates the chunked
    // helper's traffic from the unrelated narrow reads.
    const perTypeCalls = findMany.mock.calls.filter((call) => {
      const arg = call[0] as { orderBy?: unknown };
      return Array.isArray(arg?.orderBy);
    });

    expect(perTypeCalls.length).toBeGreaterThan(0);

    for (const call of perTypeCalls) {
      const arg = call[0] as {
        where?: { measuredAt?: { gte?: Date } };
      };
      const gte = arg.where?.measuredAt?.gte;
      expect(gte).toBeInstanceOf(Date);
      const gteMs = (gte as Date).getTime();
      expect(gteMs).toBeGreaterThanOrEqual(expectedMinSince);
      expect(gteMs).toBeLessThanOrEqual(expectedMaxSince);
    }
  });

  it("annotates `meta.analytics.bp_aggregate.live_since` with the 425-day cutoff ISO", async () => {
    const before = Date.now();
    await callGet(new Request("http://localhost/api/analytics"));
    const after = Date.now();

    const annotateFn = annotate as ReturnType<typeof vi.fn>;
    const bpAggregateCall = annotateFn.mock.calls.find((call) => {
      const fields = call[0] as
        | { meta?: { analytics?: { bp_aggregate?: unknown } } }
        | undefined;
      return fields?.meta?.analytics?.bp_aggregate !== undefined;
    });
    expect(bpAggregateCall).toBeDefined();

    const fields = bpAggregateCall![0] as {
      meta: {
        analytics: {
          bp_aggregate: { row_count: number; live_since: string };
        };
      };
    };
    const bpAggregate = fields.meta.analytics.bp_aggregate;
    expect(typeof bpAggregate.live_since).toBe("string");

    const FOUR_TWENTY_FIVE_DAYS_MS = 425 * 24 * 60 * 60 * 1000;
    const liveSinceMs = new Date(bpAggregate.live_since).getTime();
    expect(liveSinceMs).toBeGreaterThanOrEqual(
      before - FOUR_TWENTY_FIVE_DAYS_MS,
    );
    expect(liveSinceMs).toBeLessThanOrEqual(after - FOUR_TWENTY_FIVE_DAYS_MS);
  });

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
