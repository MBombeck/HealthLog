/**
 * v1.32.8 (iOS #66) — the optional per-request `syncTrigger` on the HealthKit
 * batch ingest.
 *
 * It is DIAGNOSTIC-ONLY: recorded on the `measurement.batch.ingest` wide event
 * and kept on the account, where the Apple Health card reads it. These pin that
 * contract:
 *
 *   - a batch carrying `syncTrigger:"background"` is accepted and the value
 *     rides the ingest annotation;
 *   - a batch WITHOUT it is accepted and the annotation carries `null`;
 *   - an invalid value is a 422 (closed enum);
 *   - the field never changes which rows are inserted / updated — the per-row
 *     outcomes are byte-identical with and without it, so it cannot leak into
 *     dedup, attribution, or storage;
 *   - the trigger is stamped on the account, and a background or push trigger
 *     additionally dates the last background arrival. That second timestamp is
 *     the whole diagnostic (#586): `healthKitLastSyncedAt` alone reads the same
 *     whether the phone delivers on its own or only while the app is open.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ annotate: vi.fn() }));

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

const SAMPLE_ID = "C0FFEE00-0000-4000-8000-000000000000";
const STATS_ID = "stats:HKQuantityTypeIdentifierStepCount:2026-06-21";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/measurements/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sampleEntry(externalId: string, value: number) {
  return {
    hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
    value,
    unit: "count/min",
    startDate: "2026-06-21T14:00:00.000Z",
    endDate: "2026-06-21T14:00:01.000Z",
    externalId,
  };
}

function stepsEntry(externalId: string, value: number) {
  return {
    hkIdentifier: "HKQuantityTypeIdentifierStepCount",
    value,
    unit: "count",
    startDate: "2026-06-21T00:00:00.000Z",
    endDate: "2026-06-21T23:59:59.000Z",
    externalId,
  };
}

function ingestMeta(): Record<string, unknown> {
  const call = mocks.annotate.mock.calls.find(
    ([arg]) =>
      (arg as { action?: { name?: string } })?.action?.name ===
      "measurement.batch.ingest",
  );
  return (call?.[0] as { meta: Record<string, unknown> }).meta;
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
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
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

describe("POST /api/measurements/batch — syncTrigger diagnostic (iOS #66)", () => {
  it("records `syncTrigger` on the ingest annotation when the client sends it", async () => {
    const res = await POST(
      makeRequest({
        entries: [sampleEntry(SAMPLE_ID, 64)],
        syncTrigger: "background",
      }),
    );
    expect(res.status).toBe(200);
    expect(ingestMeta().syncTrigger).toBe("background");
  });

  it("accepts a batch WITHOUT `syncTrigger` and annotates null", async () => {
    const res = await POST(
      makeRequest({ entries: [sampleEntry(SAMPLE_ID, 64)] }),
    );
    expect(res.status).toBe(200);
    expect(ingestMeta().syncTrigger).toBe(null);
  });

  it("rejects an invalid `syncTrigger` value with 422 (closed enum)", async () => {
    const res = await POST(
      makeRequest({
        entries: [sampleEntry(SAMPLE_ID, 64)],
        syncTrigger: "wifi",
      }),
    );
    expect(res.status).toBe(422);
  });

  it("does not change which rows insert / update with vs without the field", async () => {
    // A pre-existing per-day steps row makes the re-post an overwrite; a fresh
    // sample row inserts. The per-row outcome must be identical regardless of
    // whether `syncTrigger` rides the request.
    const seedExisting = () =>
      vi.mocked(prisma.measurement.findMany).mockResolvedValue([
        {
          id: "m1",
          type: "ACTIVITY_STEPS",
          source: "APPLE_HEALTH",
          externalId: STATS_ID,
        },
      ] as never);

    const entries = [sampleEntry(SAMPLE_ID, 64), stepsEntry(STATS_ID, 5000)];

    seedExisting();
    const withoutRes = await POST(makeRequest({ entries }));
    expect(withoutRes.status).toBe(200);
    const withoutBody = (await withoutRes.json()).data;

    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      limit: 60,
      remaining: 60,
      resetAt: Date.now() + 60_000,
    });
    vi.mocked(prisma.measurement.createManyAndReturn).mockImplementation(
      (async (args: unknown) => {
        const { data } = args as { data: unknown };
        const rows = Array.isArray(data) ? data : [data];
        return rows.map((r) => {
          const row = r as {
            type: unknown;
            source: string;
            externalId: string | null;
          };
          return {
            type: row.type,
            source: row.source,
            externalId: row.externalId,
          };
        });
      }) as never,
    );
    vi.mocked(prisma.measurement.updateMany).mockResolvedValue({ count: 1 });
    seedExisting();
    const withRes = await POST(makeRequest({ entries, syncTrigger: "push" }));
    expect(withRes.status).toBe(200);
    const withBody = (await withRes.json()).data;

    // The row-level outcome (what inserted, what updated, per-entry statuses)
    // is byte-identical; only the diagnostic annotation differs.
    expect(withBody.inserted).toBe(withoutBody.inserted);
    expect(withBody.updated).toBe(withoutBody.updated);
    expect(withBody.duplicates).toBe(withoutBody.duplicates);
    expect(withBody.entries).toEqual(withoutBody.entries);
    expect(withoutBody.updated).toBe(1);
    expect(withoutBody.inserted).toBe(1);
  });
});

describe("POST /api/measurements/batch — HealthKit trigger persistence (#586)", () => {
  function stampedData() {
    const call = vi.mocked(prisma.user.update).mock.calls[0]?.[0] as
      { data: Record<string, unknown> } | undefined;
    return call?.data;
  }

  it("dates the last background arrival when the batch says it woke in the background", async () => {
    const res = await POST(
      makeRequest({
        entries: [sampleEntry(SAMPLE_ID, 64)],
        syncTrigger: "background",
      }),
    );
    expect(res.status).toBe(200);
    expect(stampedData()).toMatchObject({
      healthKitLastSyncedAt: expect.any(Date),
      healthKitLastSyncTrigger: "background",
      healthKitLastBackgroundSyncAt: expect.any(Date),
    });
  });

  it("treats a push wake as delivery without the app too", async () => {
    const res = await POST(
      makeRequest({
        entries: [sampleEntry(SAMPLE_ID, 64)],
        syncTrigger: "push",
      }),
    );
    expect(res.status).toBe(200);
    expect(stampedData()).toMatchObject({
      healthKitLastSyncTrigger: "push",
      healthKitLastBackgroundSyncAt: expect.any(Date),
    });
  });

  it("leaves the background timestamp untouched for a foreground batch", async () => {
    const res = await POST(
      makeRequest({
        entries: [sampleEntry(SAMPLE_ID, 64)],
        syncTrigger: "foreground",
      }),
    );
    expect(res.status).toBe(200);
    const data = stampedData();
    expect(data).toMatchObject({ healthKitLastSyncTrigger: "foreground" });
    // Not written at all — a sync the user triggered by opening the app is no
    // evidence about background delivery, and overwriting the older honest
    // timestamp with this one would erase the only answer the card has.
    expect(data).not.toHaveProperty("healthKitLastBackgroundSyncAt");
  });

  it("writes null over a stale trigger when the client declares none", async () => {
    const res = await POST(
      makeRequest({ entries: [sampleEntry(SAMPLE_ID, 64)] }),
    );
    expect(res.status).toBe(200);
    const data = stampedData();
    // The field describes THIS sync. Leaving the previous batch's trigger
    // standing would attribute it to a batch that never declared one.
    expect(data).toMatchObject({ healthKitLastSyncTrigger: null });
    expect(data).not.toHaveProperty("healthKitLastBackgroundSyncAt");
  });
});
