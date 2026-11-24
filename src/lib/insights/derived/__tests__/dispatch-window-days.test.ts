/**
 * `windowDays` is a route parameter now, and a route parameter that a
 * dispatch arm quietly drops is worse than no parameter at all — the caller
 * asks for sixty days, gets fourteen, and has nothing in the payload to tell
 * them apart. This suite freezes the two halves of that contract:
 *
 *   1. Every dispatch arm that CAN honour a caller-supplied window does, and
 *      says so in `provenance.windowDays`. An arm added later that forgets to
 *      thread `args.windowDays` fails here rather than shipping silently.
 *   2. The arms that structurally cannot honour it are named, and their
 *      `provenance.windowDays` still reports the window they actually used —
 *      so a client comparing what it asked for against what came back can
 *      see the difference instead of guessing.
 *
 * The check is behavioural, not a grep over the dispatcher's source: it calls
 * each metric with an unmistakable window and reads the answer back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Day-mean reads fold per-day aggregates in SQL; the fake folds the mocked
// `measurement.findMany` rows with the same rules.
vi.mock("@/lib/measurements/day-aggregates", async () => ({
  readDayAggregates: (
    await import("@/lib/measurements/__tests__/fake-day-aggregates")
  ).fakeReadDayAggregates,
}));

// Dense reads fold in SQL; the fake folds the rows the mocked `findMany` serves.
vi.mock("@/lib/measurements/dense-bucket-read", async () => {
  const { makeFakeDenseBucketRead } =
    await import("@/lib/measurements/__tests__/fake-dense-bucket-read");
  const { prisma } = await import("@/lib/db");
  return makeFakeDenseBucketRead((args) =>
    (prisma.measurement.findMany as (a: unknown) => never)(args),
  );
});
// The same-time baseline's day totals fold in SQL; an empty account has none.
vi.mock("@/lib/measurements/cumulative-day-totals", () => ({
  readCanonicalCumulativeDayTotals: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    moodEntry: { findMany: vi.fn().mockResolvedValue([]) },
    strainTrimpCache: { findUnique: vi.fn().mockResolvedValue(null) },
    intradayCumulativeProfile: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  readBestGranularityRollups: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn().mockResolvedValue("UTC"),
}));
// HEALTH_SCORE recomposes the whole pillar report; stub it at the adapter
// boundary and hand back a provenance whose window is one the caller could
// never have asked for, so "it ignored me" is observable rather than inferred.
vi.mock("@/lib/analytics/score/derived", () => ({
  computeHealthScoreDerived: vi.fn(async () => ({
    status: "insufficient" as const,
    coverage: {
      requiredInputs: 1,
      presentInputs: 0,
      historyDays: 0,
      missing: [],
    },
    provenance: {
      inputs: [],
      source: "none" as const,
      windowDays: 365,
      computedAt: "2026-06-02T09:00:00+02:00",
    },
    reason: "no_pillars",
  })),
}));

import { computeDerivedMetric } from "../dispatch";
import { DERIVED_METRIC_IDS, getDerivedMetricMeta } from "../registry";
import type { DerivedMetricId } from "../registry";

const PROFILE = { ageYears: 40, sex: "MALE" as const };
const NOW = new Date("2026-06-02T07:00:00Z");
/** A window no engine uses as a default, so an echo cannot be a coincidence. */
const ASKED = 77;

/**
 * Dispatch arms that structurally cannot honour a caller-supplied window.
 *
 * `HEALTH_SCORE` is a composite of pillar reads, each pinned to the window its
 * own clinical convention requires (an HbA1c pillar does not become a 77-day
 * question because the caller typed 77). Its `provenance.windowDays` reports
 * the widest pillar window it actually used, which is the honest answer.
 *
 * Adding an id here is a deliberate act: it means the parameter is documented
 * as inert for that metric, not that threading it was forgotten.
 */
const WINDOW_AGNOSTIC: DerivedMetricId[] = ["HEALTH_SCORE"];

beforeEach(() => vi.clearAllMocks());

describe("derived dispatch — windowDays", () => {
  const implemented = DERIVED_METRIC_IDS.filter(
    (id) => getDerivedMetricMeta(id)?.implemented === true,
  );

  it("has metrics to check (an empty sweep would pass vacuously)", () => {
    expect(implemented.length).toBeGreaterThan(10);
  });

  it.each(implemented.filter((id) => !WINDOW_AGNOSTIC.includes(id)))(
    "%s reports back the window it was asked for",
    async (metric) => {
      const derived = await computeDerivedMetric({
        metric,
        userId: "u1",
        profile: PROFILE,
        windowDays: ASKED,
        now: NOW,
      });
      // A stub arm would answer `not_implemented` with a zero window; the
      // registry says these are implemented, so that would be the drift.
      expect(
        derived.status === "insufficient" ? derived.reason : "ok",
      ).not.toBe("not_implemented");
      expect(derived.provenance.windowDays).toBe(ASKED);
    },
  );

  it.each(WINDOW_AGNOSTIC)(
    "%s ignores the window but still reports the one it used",
    async (metric) => {
      const derived = await computeDerivedMetric({
        metric,
        userId: "u1",
        profile: PROFILE,
        windowDays: ASKED,
        now: NOW,
      });
      expect(derived.provenance.windowDays).not.toBe(ASKED);
      expect(derived.provenance.windowDays).toBeGreaterThan(0);
    },
  );
});
