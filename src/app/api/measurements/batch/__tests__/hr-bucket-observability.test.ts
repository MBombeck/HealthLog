/**
 * v1.32.1 (issue #585) — wide-event observability for the go-forward
 * aggregated 10-min heart-rate bucket wire contract.
 *
 * The intraday pulse chart reads exactly the `stats:HKQuantityTypeIdentifier
 * HeartRate:<10-min-Z>` rows this batch route accepts (or rejects). A report
 * of "the chart looks sparser after the ZIP-import cutoff" was previously
 * undiagnosable from server logs: the baseline `measurement.batch.ingest`
 * annotation carried only a total `skipped` count with no reason breakdown
 * and no visibility into how many of a batch's entries specifically targeted
 * an HR bucket. These tests pin the new `measurement.batch.hr-bucket`
 * annotation (fires only when the batch actually carried an HR-bucket entry)
 * and the `skipped_by_reason` breakdown on the baseline annotation.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ annotate: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      update: vi.fn(),
    },
    measurement: {
      findMany: vi.fn(),
      createManyAndReturn: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(async (fn: unknown) => {
      if (typeof fn === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (fn as any)(prisma as unknown as { measurement: unknown });
      }
    }),
  },
}));

vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return { ...actual, annotate: mocks.annotate };
});

vi.mock("@/lib/measurements/reconcile-external-measurement", () => ({
  reconcileExternalMeasurement: async (
    tx: {
      measurement: {
        findMany: (args: unknown) => Promise<
          Array<{
            id?: string;
            type?: string;
            source?: string;
            externalId?: string | null;
          }>
        >;
        createManyAndReturn: (args: {
          data: Record<string, unknown>;
        }) => Promise<Array<Record<string, unknown>>>;
        updateMany: (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => Promise<unknown>;
      };
    },
    input: Record<string, unknown> & {
      userId: string;
      type: string;
      source: string;
      externalId: string;
    },
    options: { exactExternalMatch?: "update" | "duplicate" } = {},
  ) => {
    const existing = await tx.measurement.findMany({});
    const exact = existing.find(
      (row: { type?: string; source?: string; externalId?: string | null }) =>
        row.type === input.type &&
        row.source === input.source &&
        row.externalId === input.externalId,
    );
    if (exact && options.exactExternalMatch !== "update") {
      return { status: "duplicate", row: exact };
    }
    if (exact) {
      await tx.measurement.updateMany({
        where: { id: exact.id },
        data: { ...input, deletedAt: null },
      });
      return { status: "updated", row: { ...exact, ...input } };
    }
    const [inserted] = await tx.measurement.createManyAndReturn({
      data: input,
    });
    if (inserted) return { status: "inserted", row: inserted };
    if (options.exactExternalMatch === "update") {
      await tx.measurement.updateMany({ where: {}, data: input });
      return { status: "updated", row: input };
    }
    return { status: "duplicate" };
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
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

const FRESH_BUCKET_ID =
  "stats:HKQuantityTypeIdentifierHeartRate:2026-06-21T14:00:00.000Z";
const REPOST_BUCKET_ID =
  "stats:HKQuantityTypeIdentifierHeartRate:2026-06-21T15:00:00.000Z";
const MALFORMED_BUCKET_ID =
  "stats:HKQuantityTypeIdentifierHeartRate:2026-06-21T14:35:00.000Z";
const SAMPLE_ID = "C0FFEE00-0000-4000-8000-000000000000";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/measurements/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function hrEntry(externalId: string, value: number) {
  return {
    hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
    value,
    unit: "count/min",
    startDate: "2026-06-21T14:00:00.000Z",
    endDate: "2026-06-21T14:59:59.000Z",
    externalId,
  };
}

function annotateCallsFor(actionName: string) {
  return mocks.annotate.mock.calls.filter(
    ([arg]) =>
      (arg as { action?: { name?: string } })?.action?.name === actionName,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 60,
    resetAt: Date.now() + 60_000,
  });
  vi.mocked(prisma.measurement.createManyAndReturn).mockImplementation((async (
    args: unknown,
  ) => {
    const { data } = args as {
      data:
        | { type: unknown; source: string; externalId: string | null }
        | Array<{ type: unknown; source: string; externalId: string | null }>;
    };
    const rows = Array.isArray(data) ? data : [data];
    return rows.map(({ type, source, externalId }) => ({
      type,
      source,
      externalId,
    }));
  }) as never);
  vi.mocked(prisma.measurement.updateMany).mockResolvedValue({ count: 1 });
});

describe("POST /api/measurements/batch — HR-bucket observability (issue #585)", () => {
  it("reports a per-outcome breakdown covering only HR-bucket entries", async () => {
    // REPOST_BUCKET_ID already exists — the reconcile mock overwrites it.
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        type: "PULSE",
        source: "APPLE_HEALTH",
        externalId: REPOST_BUCKET_ID,
      },
    ] as never);

    const res = await POST(
      makeRequest({
        entries: [
          hrEntry(FRESH_BUCKET_ID, 72), // inserted
          hrEntry(REPOST_BUCKET_ID, 78), // updated (overwrite)
          hrEntry(MALFORMED_BUCKET_ID, 70), // skipped (malformed)
          hrEntry(SAMPLE_ID, 64), // NOT an HR bucket — must be excluded
        ],
      }),
    );
    expect(res.status).toBe(200);

    const calls = annotateCallsFor("measurement.batch.hr-bucket");
    expect(calls).toHaveLength(1);
    const meta = (calls[0][0] as { meta: Record<string, number> }).meta;
    expect(meta).toEqual({
      attempted: 3,
      inserted: 1,
      updated: 1,
      duplicate: 0,
      skipped: 1,
      failed: 0,
      processed: 4,
    });
  });

  it("never fires the HR-bucket annotation for a batch with no bucket entries", async () => {
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([]);
    const res = await POST(makeRequest({ entries: [hrEntry(SAMPLE_ID, 64)] }));
    expect(res.status).toBe(200);
    expect(annotateCallsFor("measurement.batch.hr-bucket")).toHaveLength(0);
  });

  it("breaks the baseline ingest annotation's skip count down by reason", async () => {
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([]);
    const res = await POST(
      makeRequest({
        entries: [
          hrEntry(MALFORMED_BUCKET_ID, 70), // skipped: malformed_hr_bucket_id
        ],
      }),
    );
    expect(res.status).toBe(200);

    const calls = annotateCallsFor("measurement.batch.ingest");
    expect(calls).toHaveLength(1);
    const meta = calls[0][0] as { meta: { skipped_by_reason: unknown } };
    expect(meta.meta.skipped_by_reason).toEqual({
      malformed_hr_bucket_id: 1,
    });
  });
});
