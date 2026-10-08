/**
 * RED contract for GH-03/GH-04/SYNC-03.
 *
 * Resource outcomes are bounded facts, never provider payloads. The observed
 * 786 Heart Rate pages are retained as evidence without converting that
 * observation into an invented truncation ceiling.
 */
import { describe, expect, it, vi } from "vitest";

const RESOURCE_KEYS = [
  "resource",
  "pages",
  "fetched",
  "mapped",
  "written",
  "status",
  "durationMs",
  "truncated",
  "reasonCode",
] as const;

const resourceOutcomes = [
  {
    resource: "workout",
    pages: 1,
    fetched: 1,
    mapped: 1,
    written: 1,
    status: "complete",
    durationMs: 12,
    truncated: false,
    reasonCode: null,
  },
  {
    resource: "sleep",
    pages: 1,
    fetched: 2,
    mapped: 2,
    written: 1,
    status: "partial",
    durationMs: 13,
    truncated: false,
    reasonCode: "upsert_failed",
  },
  {
    resource: "steps",
    pages: 1,
    fetched: 0,
    mapped: 0,
    written: 0,
    status: "empty",
    durationMs: 4,
    truncated: false,
    reasonCode: null,
  },
  {
    resource: "heart-rate",
    pages: 786,
    fetched: 78_600,
    mapped: 78_600,
    written: 78_600,
    status: "complete",
    durationMs: 323_849,
    truncated: false,
    reasonCode: null,
  },
  {
    resource: "distance",
    pages: 8,
    fetched: 800,
    mapped: 800,
    written: 800,
    status: "truncated",
    durationMs: 900,
    truncated: true,
    reasonCode: "existing_page_limit",
  },
  {
    resource: "activity",
    pages: 0,
    fetched: 0,
    mapped: 0,
    written: 0,
    status: "failed",
    durationMs: 5,
    truncated: false,
    reasonCode: "collection_failed",
  },
  {
    resource: "token",
    pages: 0,
    fetched: 0,
    mapped: 0,
    written: 0,
    status: "failed",
    durationMs: 2,
    truncated: false,
    reasonCode: "token_failed",
  },
  {
    resource: "rollup",
    pages: 0,
    fetched: 1,
    mapped: 1,
    written: 1,
    status: "failed",
    durationMs: 7,
    truncated: false,
    reasonCode: "rollup_failed",
  },
];

const { prismaMock, runCycle } = vi.hoisted(() => ({
  prismaMock: {
    googleHealthConnection: {
      findUnique: vi.fn(async () => ({ lastSyncedAt: null })),
      update: vi.fn(async () => ({})),
    },
  },
  runCycle: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired: vi.fn(async () => false),
  recordSyncSuccess: vi.fn(async () => {}),
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: vi.fn(() => []),
  recomputeUserRollups: vi.fn(async () => {}),
}));
vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));
vi.mock("../sync-core", () => ({
  GOOGLE_HEALTH_INTEGRATION_KEY: "google-health",
  incrementalStart: vi.fn(() => undefined),
  GOOGLE_HEALTH_INTRADAY_OVERLAP_MS: 2 * 60 * 60 * 1000,
  markSynced: vi.fn(async () => {}),
  runWithGoogleHealthSyncCycle: runCycle,
}));
vi.mock("../sync-metrics", () => ({ syncUserMetrics: vi.fn() }));
vi.mock("../sync-activity", () => ({ syncUserActivity: vi.fn() }));
vi.mock("../sync-sleep", () => ({ syncUserSleep: vi.fn() }));
vi.mock("../sync-workout", () => ({ syncUserWorkout: vi.fn() }));

import { syncUserGoogleHealth } from "../sync";

describe("Google Health bounded resource outcomes", () => {
  it("returns exact redacted fields for every terminal class", async () => {
    runCycle.mockResolvedValue({
      result: { total: 79_402, anyFailed: true, resources: resourceOutcomes },
      hardFailures: [
        "activity:collection",
        "token",
        "workout:upsert",
        "rollup",
      ],
      softSkipCount: 0,
      deferredRollupKeys: [],
      resources: resourceOutcomes,
    });

    const result = (await syncUserGoogleHealth("outcome-user", {
      fullSync: true,
    })) as unknown as { resources: Array<Record<string, unknown>> };

    expect(result.resources).toHaveLength(resourceOutcomes.length);
    for (const outcome of result.resources) {
      expect(Object.keys(outcome).sort()).toEqual([...RESOURCE_KEYS].sort());
      expect(JSON.stringify(outcome)).not.toMatch(
        /access[_-]?token|refresh[_-]?token|https?:|rawError|healthValue|samples/i,
      );
    }
    expect(result.resources).toEqual(resourceOutcomes);
    expect(
      result.resources.find((item) => item.resource === "heart-rate"),
    ).toMatchObject({
      pages: 786,
      truncated: false,
      status: "complete",
    });
  });
});
