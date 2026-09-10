/**
 * `POST /api/measurements/batch` — entry-instant plausibility bound.
 *
 * The single-entry twin has applied `validateEntryInstant` to `measuredAt`
 * since v1.17 W1b; the 500-entry batch path did not, so a future-dated row
 * landed and permanently won "latest reading" on every dashboard while
 * poisoning the rollup buckets and the canonical picker.
 *
 * The past floor deliberately stays at 1900: a historical Apple Health
 * backfill is a legitimate shape on this route. Only the future side is a bug.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { update: vi.fn() },
    measurement: {
      findMany: vi.fn(),
      createManyAndReturn: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(async (fn: unknown) => {
      if (typeof fn === "function") {
        return (fn as (tx: unknown) => unknown)(prisma);
      }
    }),
  },
}));

// Main routes every ingested row through `reconcileExternalMeasurement`; the
// plausibility guard runs BEFORE that call, so a valid entry only needs the
// reconcile to report a non-skip status for the assertion to hold.
vi.mock("@/lib/measurements/reconcile-external-measurement", () => ({
  reconcileExternalMeasurement: vi.fn(
    async (_tx: unknown, input: Record<string, unknown>) => ({
      status: "inserted",
      row: { id: "row-1", ...input },
    }),
  ),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/jobs/pr-detection", () => ({
  enqueuePrDetection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/jobs/reminder-satisfy", () => ({
  enqueueReminderSatisfy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMeasurements: vi.fn(),
}));

vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rollups/measurement-rollups", () => ({
  recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
  collapseToTypeDayKeys: vi.fn(() => []),
}));
vi.mock("@/lib/rollups/after-measurement-mutation", () => ({
  afterMeasurementMutation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/daily/morning-refresh-trigger", () => ({
  maybeEnqueueMorningRefresh: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/arrivals/emit-shared", () => ({
  emitDataArrival: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/measurements/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A step entry anchored on an offset from now, so the test never date-bombs. */
function stepEntryAt(externalId: string, startMs: number, endMs = startMs) {
  return {
    hkIdentifier: "HKQuantityTypeIdentifierStepCount",
    value: 1200,
    unit: "count",
    startDate: new Date(startMs).toISOString(),
    endDate: new Date(endMs).toISOString(),
    externalId,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function statusesFor(entries: unknown[]) {
  const res = await POST(makeRequest({ entries }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: {
      entries: Array<{ index: number; status: string; reason?: string }>;
    };
  };
  return body.data.entries;
}

beforeEach(() => {
  // clearAllMocks (not resetAllMocks): the fire-and-forget post-processing
  // mocks above carry `.mockResolvedValue` implementations that the route
  // chains `.catch` onto; resetAllMocks would wipe those to bare `undefined`.
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 60,
    resetAt: Date.now() + 60_000,
  });
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([]);
  vi.mocked(prisma.measurement.createManyAndReturn).mockResolvedValue([
    { id: "row-1" },
  ] as never);
  vi.mocked(prisma.measurement.updateMany).mockResolvedValue({ count: 0 });
});

describe("POST /api/measurements/batch — entry-instant plausibility", () => {
  it("skips a far-future entry instead of persisting it", async () => {
    const results = await statusesFor([
      stepEntryAt("ext-future", Date.now() + 365 * DAY_MS),
    ]);
    expect(results[0]).toMatchObject({
      index: 0,
      status: "skipped",
      reason: "implausible_timestamp",
    });
  });

  it("skips an entry predating the 1900 floor", async () => {
    const results = await statusesFor([
      stepEntryAt("ext-ancient", Date.UTC(1899, 11, 31)),
    ]);
    expect(results[0]).toMatchObject({
      status: "skipped",
      reason: "implausible_timestamp",
    });
  });

  it("accepts a historical backfill entry — the past floor stays at 1900", async () => {
    const results = await statusesFor([
      stepEntryAt("ext-old", Date.now() - 8 * 365 * DAY_MS),
    ]);
    expect(results[0]!.status).not.toBe("skipped");
  });

  it("tolerates a client clock a couple of minutes fast", async () => {
    const results = await statusesFor([
      stepEntryAt("ext-skew", Date.now() + 2 * 60 * 1000),
    ]);
    expect(results[0]!.status).not.toBe("skipped");
  });

  it("skips only the offending entry and keeps the rest of the batch", async () => {
    const results = await statusesFor([
      stepEntryAt("ext-ok", Date.now() - DAY_MS),
      stepEntryAt("ext-bad", Date.now() + 365 * DAY_MS),
    ]);
    expect(results[0]!.status).not.toBe("skipped");
    expect(results[1]).toMatchObject({ reason: "implausible_timestamp" });
  });
});
