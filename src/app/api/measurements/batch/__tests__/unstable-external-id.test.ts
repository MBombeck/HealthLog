/**
 * `POST /api/measurements/batch` — external-id stability floor.
 *
 * `(user_id, type, source, external_id)` is idempotent only while the id
 * is stable across client launches. An id that rotates per process — an
 * object description carrying a memory address — never matches its own
 * earlier row, so every sync sweep mints a fresh measurement.
 *
 * The refusal is PER ENTRY, matching the range / timestamp guards on this
 * route: a client draining a HealthKit queue must not lose 499 good rows
 * because one carried a bad id.
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

vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, annotate: vi.fn() };
});

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
import { annotate } from "@/lib/logging/context";
import { reconcileExternalMeasurement } from "@/lib/measurements/reconcile-external-measurement";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

const DAY_MS = 24 * 60 * 60 * 1000;

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/measurements/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A plain step entry anchored a day back so it never date-bombs. */
function stepEntry(externalId: string) {
  const at = new Date(Date.now() - DAY_MS).toISOString();
  return {
    hkIdentifier: "HKQuantityTypeIdentifierStepCount",
    value: 1200,
    unit: "count",
    startDate: at,
    endDate: at,
    externalId,
  };
}

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

describe("POST /api/measurements/batch — unstable external ids", () => {
  it("skips an object-description id instead of minting a row", async () => {
    const results = await statusesFor([
      stepEntry("<HKHealthConceptIdentifier: 0x12568db80>"),
    ]);
    expect(results[0]).toMatchObject({
      index: 0,
      status: "skipped",
      reason: "unstable_external_id",
    });
    expect(reconcileExternalMeasurement).not.toHaveBeenCalled();
  });

  it("skips a bare memory-address id", async () => {
    const results = await statusesFor([stepEntry("0x126b25160")]);
    expect(results[0]).toMatchObject({
      status: "skipped",
      reason: "unstable_external_id",
    });
  });

  it("skips ONLY the offending entries — the rest of the batch still lands", async () => {
    const results = await statusesFor([
      stepEntry("hk-uuid-1"),
      stepEntry("<HKHealthConceptIdentifier: 0x12568db80>"),
      stepEntry("stats:HKQuantityTypeIdentifierStepCount:2026-07-25"),
      stepEntry("0xdeadbeef"),
    ]);
    expect(results[0]!.status).not.toBe("skipped");
    expect(results[1]).toMatchObject({ reason: "unstable_external_id" });
    expect(results[2]!.status).not.toBe("skipped");
    expect(results[3]).toMatchObject({ reason: "unstable_external_id" });
    // Two good rows still reached the writer.
    expect(reconcileExternalMeasurement).toHaveBeenCalledTimes(2);
  });

  it("never turns one bad row into a whole-batch 422", async () => {
    const res = await POST(
      makeRequest({
        entries: [stepEntry("hk-uuid-1"), stepEntry("0xdeadbeef")],
      }),
    );
    expect(res.status).toBe(200);
  });

  it("accepts the real id shapes this route receives", async () => {
    const results = await statusesFor([
      stepEntry("8AD2A9CB-3F0C-4E4D-9C1E-4B7E2A1D6F30"),
      stepEntry("stats:HKQuantityTypeIdentifierStepCount:2026-07-25"),
      stepEntry("hk-uuid-41"),
    ]);
    for (const r of results) expect(r.status).not.toBe("skipped");
  });

  it("annotates the refusal with the shape, never the id", async () => {
    await statusesFor([
      stepEntry("<HKHealthConceptIdentifier: 0x12568db80>"),
      stepEntry("0xdeadbeef"),
    ]);
    const calls = vi.mocked(annotate).mock.calls.map(([c]) => c);
    const rejection = calls.find(
      (c) => c?.meta && "external_id_rejected" in c.meta,
    );
    expect(rejection?.meta).toMatchObject({
      external_id_rejected: 2,
      external_id_shapes: "object_description,pointer_address",
      external_id_surface: "measurement.batch",
    });
    expect(JSON.stringify(rejection)).not.toContain("0x12568db80");
  });

  it("emits no rejection annotation on a clean batch", async () => {
    await statusesFor([stepEntry("hk-uuid-1")]);
    const calls = vi.mocked(annotate).mock.calls.map(([c]) => c);
    expect(calls.some((c) => c?.meta && "external_id_rejected" in c.meta)).toBe(
      false,
    );
  });
});
