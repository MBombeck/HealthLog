/**
 * v1.4.25 W16c — PR detection enqueue coverage for
 * `POST /api/measurements/batch`. The full per-entry envelope is
 * exercised by the integration suite; this file checks the hook fires
 * with the right `silent` flag for the small / large batch cases and
 * stays out of the way when nothing landed.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const reconcileOverrideMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      update: vi.fn(),
    },
    measurement: {
      findMany: vi.fn(),
      createManyAndReturn: vi.fn(),
    },
    $transaction: vi.fn(async (fn: unknown) => {
      if (typeof fn === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (fn as any)(prisma as unknown as { measurement: unknown });
      }
    }),
  },
}));

vi.mock("@/lib/measurements/reconcile-external-measurement", () => ({
  reconcileExternalMeasurement: async (
    tx: {
      measurement: {
        createManyAndReturn: (args: {
          data: Record<string, unknown>;
        }) => Promise<Array<Record<string, unknown>>>;
      };
    },
    input: Record<string, unknown>,
  ) => {
    const override = await reconcileOverrideMock(tx, input);
    if (override !== undefined) return override;
    const [inserted] = await tx.measurement.createManyAndReturn({
      data: input,
    });
    return inserted
      ? { status: "inserted", row: inserted }
      : { status: "duplicate" };
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

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/jobs/pr-detection", () => ({
  enqueuePrDetection: vi.fn().mockResolvedValue(undefined),
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
import { enqueuePrDetection } from "@/lib/jobs/pr-detection";

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

function validStepEntry(externalId: string) {
  return {
    hkIdentifier: "HKQuantityTypeIdentifierStepCount",
    value: 1200,
    unit: "count",
    startDate: "2026-05-14T06:30:00.000Z",
    endDate: "2026-05-14T06:45:00.000Z",
    externalId,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 60,
    resetAt: Date.now() + 60_000,
  });
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([]);
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
  vi.mocked(prisma.user.update).mockResolvedValue({} as never);
});

describe("POST /api/measurements/batch — PR detection enqueue (v1.4.25 W16c)", () => {
  it("enqueues with silent=false for a small healthy batch", async () => {
    const res = await POST(makeRequest({ entries: [validStepEntry("ext-a")] }));
    expect(res.status).toBe(200);
    expect(enqueuePrDetection).toHaveBeenCalledTimes(1);
    expect(enqueuePrDetection).toHaveBeenCalledWith("user-1", {
      silent: false,
    });
  });

  it("stamps HealthKit sync status after a durable Apple Health write", async () => {
    const res = await POST(makeRequest({ entries: [validStepEntry("ext-a")] }));

    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { healthKitLastSyncedAt: expect.any(Date) },
    });
  });

  it("does not stamp HealthKit sync status for a manual-only batch", async () => {
    const res = await POST(
      makeRequest({
        entries: [{ ...validStepEntry("ext-manual"), source: "MANUAL" }],
      }),
    );

    expect(res.status).toBe(200);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("surfaces a hard reconciliation failure without checkpointing it", async () => {
    reconcileOverrideMock.mockResolvedValueOnce({
      status: "failed",
      error: { message: "write rejected", code: "P2002" },
    });

    const res = await POST(makeRequest({ entries: [validStepEntry("ext-a")] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(await res.json()).toMatchObject({
      data: {
        processed: 1,
        inserted: 0,
        updated: 0,
        duplicates: 0,
        failed: 1,
        entries: [{ index: 0, status: "failed", reason: "P2002" }],
      },
      error: null,
    });
    expect(enqueuePrDetection).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("sets silent=true once the batch crosses the 50-entry threshold", async () => {
    const big = Array.from({ length: 51 }, (_, i) =>
      validStepEntry(`ext-${i}`),
    );
    const res = await POST(makeRequest({ entries: big }));
    expect(res.status).toBe(200);
    expect(enqueuePrDetection).toHaveBeenCalledWith("user-1", {
      silent: true,
    });
  });
});
