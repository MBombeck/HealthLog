/**
 * `POST /api/measurements/batch` — what a refusal tells the client.
 *
 * Two gaps the native client reported against v1.39.0:
 *
 *   - The whole-batch validation 422 carried no `meta.errorCode`, so the
 *     client could not tell a permanent refusal from a transient one and had
 *     to hold its anchor for several syncs before giving up on the rows.
 *     The too-large and source refusals already had codes; this one now has
 *     `measurement.batch.invalid`.
 *   - A `value_out_of_range` skip said neither what the value became after
 *     conversion nor which band it broke, so a unit-mapping slip (a fraction
 *     sent where a percent was expected) looked the same as a sensor glitch.
 *     The entry now carries `convertedValue` and `range`.
 *
 * Both are additive: status codes, the envelope and every existing field
 * are unchanged.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { update: vi.fn() },
    measurement: { findMany: vi.fn() },
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
import { reconcileExternalMeasurement } from "@/lib/measurements/reconcile-external-measurement";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/measurements/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const AT = new Date(Date.now() - 3_600_000).toISOString();

function entry(overrides: Record<string, unknown> = {}) {
  return {
    hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
    value: 64,
    unit: "count/min",
    startDate: AT,
    endDate: AT,
    externalId: "uuid-1",
    ...overrides,
  };
}

type EntryResult = {
  index: number;
  status: string;
  reason?: string;
  convertedValue?: number;
  range?: { min: number; max: number; unit: string };
};

async function entriesFor(entries: unknown[]): Promise<EntryResult[]> {
  const res = await post({ entries });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { entries: EntryResult[] } }).data
    .entries;
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
});

describe("POST /api/measurements/batch — validation refusal code", () => {
  it("names a malformed batch measurement.batch.invalid and keeps the 422 envelope", async () => {
    const res = await post({ entries: [entry({ startDate: "yesterday" })] });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: { issues: unknown[] };
      meta?: { errorCode?: string };
    };
    expect(body.data).toBeNull();
    expect(typeof body.error).toBe("string");
    expect(body.details.issues.length).toBeGreaterThan(0);
    expect(body.meta?.errorCode).toBe("measurement.batch.invalid");
  });

  it("names an empty entries array the same way", async () => {
    const res = await post({ entries: [] });
    expect(res.status).toBe(422);
    expect(
      ((await res.json()) as { meta?: { errorCode?: string } }).meta?.errorCode,
    ).toBe("measurement.batch.invalid");
  });

  it("keeps measurement.batch.too_large for an over-cap batch", async () => {
    const entries = Array.from({ length: 501 }, (_, i) =>
      entry({ externalId: `uuid-${i}` }),
    );
    const res = await post({ entries });
    expect(res.status).toBe(422);
    expect(
      ((await res.json()) as { meta?: { errorCode?: string } }).meta?.errorCode,
    ).toBe("measurement.batch.too_large");
  });
});

describe("POST /api/measurements/batch — value_out_of_range detail", () => {
  it("reports the converted value and the band it broke, in the stored unit", async () => {
    // HealthKit reports body fat as a fraction; 0.9 becomes 90 %, above 80.
    const [result] = await entriesFor([
      entry({
        hkIdentifier: "HKQuantityTypeIdentifierBodyFatPercentage",
        value: 0.9,
        unit: "%",
      }),
    ]);
    expect(result).toEqual({
      index: 0,
      status: "skipped",
      reason: "value_out_of_range",
      convertedValue: 90,
      range: { min: 1, max: 80, unit: "%" },
    });
  });

  it("reports the lower edge too", async () => {
    const [result] = await entriesFor([entry({ value: 12 })]);
    expect(result).toMatchObject({
      reason: "value_out_of_range",
      convertedValue: 12,
      range: { min: 20, max: 300, unit: "bpm" },
    });
  });

  it("carries the same detail when the write-side gate is the one that refuses", async () => {
    vi.mocked(reconcileExternalMeasurement).mockResolvedValueOnce({
      status: "rejected_range",
      rejection: { type: "PULSE", direction: "above_max" },
    });
    const [result] = await entriesFor([entry({ value: 64 })]);
    expect(result).toMatchObject({
      status: "skipped",
      reason: "value_out_of_range",
      convertedValue: 64,
      range: { min: 20, max: 300, unit: "bpm" },
    });
  });

  it("adds nothing to an entry that landed or was skipped for another reason", async () => {
    const results = await entriesFor([
      entry({ externalId: "uuid-ok" }),
      entry({ hkIdentifier: "HKQuantityTypeIdentifierNotAThing" }),
    ]);
    expect(results[0]).toEqual({ index: 0, status: "inserted" });
    expect(results[1]).toEqual({
      index: 1,
      status: "skipped",
      reason: "unmappable_identifier",
    });
  });
});
