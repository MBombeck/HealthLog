import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

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
        return (fn as (tx: unknown) => unknown)(prisma);
      }
    }),
  },
}));
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
      await tx.measurement.updateMany({ where: { id: exact.id }, data: input });
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
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";
import { emitDataArrival } from "@/lib/arrivals/emit-shared";

const session = {
  session: { id: "session-1", expiresAt: new Date("2026-08-01T00:00:00Z") },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function entry(
  hkIdentifier: string,
  value: number,
  unit: string,
  endDate: string,
  externalId: string,
  sleepStage?: number,
) {
  return {
    hkIdentifier,
    value,
    unit,
    startDate: new Date(Date.parse(endDate) - 60_000).toISOString(),
    endDate,
    externalId,
    ...(sleepStage === undefined ? {} : { sleepStage }),
  };
}

function request(entries: unknown[]): NextRequest {
  return new NextRequest("http://localhost/api/measurements/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entries }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(session as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetAt: Date.now() + 60_000,
  });
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([]);
  vi.mocked(prisma.measurement.updateMany).mockResolvedValue({ count: 0 });
});

describe("POST /api/measurements/batch — exact INSERT RETURNING identity", () => {
  it("emits and refreshes only exact inserted rows when mixed kinds lose insert races", async () => {
    const weightAt = "2026-07-19T07:00:00.000Z";
    const insertedSleepAt = "2026-07-19T06:30:00.000Z";
    const racedSleepAt = "2026-07-19T06:45:00.000Z";
    const racedBpAt = "2026-07-19T07:15:00.000Z";
    const entries = [
      entry(
        "HKQuantityTypeIdentifierBodyMass",
        80,
        "kg",
        weightAt,
        "weight-inserted",
      ),
      entry(
        "HKCategoryTypeIdentifierSleepAnalysis",
        90,
        "min",
        insertedSleepAt,
        "sleep-inserted",
        3,
      ),
      entry(
        "HKCategoryTypeIdentifierSleepAnalysis",
        45,
        "min",
        racedSleepAt,
        "sleep-raced",
        3,
      ),
      entry(
        "HKQuantityTypeIdentifierBloodPressureSystolic",
        120,
        "mmHg",
        racedBpAt,
        "bp-raced",
      ),
    ];

    vi.mocked(prisma.measurement.createManyAndReturn).mockImplementation(
      (async (args: unknown) => {
        const { data } = args as {
          data:
            | { type: unknown; source: string; externalId: string | null }
            | Array<{
                type: unknown;
                source: string;
                externalId: string | null;
              }>;
        };
        const rows = Array.isArray(data) ? data : [data];
        return rows
          .filter(
            (row) =>
              typeof row.externalId === "string" &&
              ["weight-inserted", "sleep-inserted"].includes(row.externalId),
          )
          .reverse()
          .map(({ type, source, externalId }) => ({
            type,
            source,
            externalId,
          }));
      }) as never,
    );

    const response = await POST(request(entries));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        inserted: number;
        duplicates: number;
        entries: Array<{ index: number; status: string }>;
      };
    };

    expect(body.data.inserted).toBe(2);
    expect(body.data.duplicates).toBe(2);
    expect(body.data.entries.map(({ status }) => status)).toEqual([
      "inserted",
      "inserted",
      "duplicate",
      "duplicate",
    ]);
    expect(prisma.measurement.createManyAndReturn).toHaveBeenCalledTimes(4);
    expect(maybeEnqueueMorningRefresh).toHaveBeenCalledWith("user-1", [
      new Date(insertedSleepAt),
    ]);
    expect(emitDataArrival).toHaveBeenCalledTimes(1);
    expect(emitDataArrival).toHaveBeenCalledWith({
      userId: "user-1",
      kind: "weight",
      newestSampleAt: new Date(weightAt),
      insertedCount: 1,
      source: "batch",
    });
  });
});
