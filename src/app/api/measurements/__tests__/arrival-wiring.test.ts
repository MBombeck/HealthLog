import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// v1.36.x — the create arms resolve a RECORD now. The stub returns the caller
// as both the record and the actor, which is what the resolver itself returns
// for anyone who has not switched; the substitution proper is proved against
// real Postgres in `tests/integration/sharing-delegable-writes.test.ts`.
const SELF = {
  id: "user-1",
  username: "tester",
  role: "USER",
  timezone: "Europe/Berlin",
};

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  // The shared single-record write ceiling. Allowed here: this file is about
  // what the handler does with a body it accepted, not about the bucket.
  checkRecordWriteRateLimit: vi.fn(async () => ({
    allowed: true,
    limit: 300,
    remaining: 299,
    resetAt: Date.now() + 60_000,
  })),
}));
vi.mock("@/lib/api-handler", () => ({
  apiHandler: (fn: unknown) => fn,
  requireRecordAuth: vi.fn(async () => ({ user: SELF, actor: SELF })),
  // These cases resolve as a cookie session, which is what "unscoped" means:
  // no narrow Bearer admitted the request, so the route's source and
  // sync-checkpoint rules take their ordinary path. Stubbed rather than
  // omitted because this file mocks the module wholesale, so an export the
  // route reaches for and the mock does not list fails the import outright.
  isScopedCredential: vi.fn(() => false),
}));

vi.mock("@/lib/idempotency", () => ({
  withIdempotency: (fn: unknown) => fn,
}));

vi.mock("@/lib/db", () => {
  const measurement = { create: vi.fn() };
  return {
    prisma: {
      measurement,
      auditLog: { create: vi.fn() },
      $transaction: vi.fn(async (operations: Array<Promise<unknown>>) =>
        Promise.all(operations),
      ),
    },
  };
});

vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/logging/fire-and-forget", () => ({
  fireAndForget: (promise: Promise<unknown>) => void promise.catch(() => {}),
}));
vi.mock("@/lib/crypto/note-cipher", () => ({
  encryptNote: vi.fn(() => null),
  shapeMeasurementNotes: vi.fn((row: unknown) => row),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMeasurements: vi.fn(),
}));
vi.mock("@/lib/arrivals/emit-shared", () => ({
  emitDataArrival: vi.fn(async () => {}),
}));
vi.mock("@/lib/arrivals/measurement-emit", () => ({
  emitInsertedMeasurementArrivals: vi.fn(async () => {}),
}));
vi.mock("@/lib/daily/morning-refresh-trigger", () => ({
  maybeEnqueueMorningRefresh: vi.fn(async () => {}),
}));
vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));
vi.mock("@/lib/jobs/reminder-satisfy", () => ({
  enqueueReminderSatisfy: vi.fn(async () => {}),
}));
vi.mock("@/lib/illness/safety-floor-check", () => ({
  runSafetyFloorCheck: vi.fn(async () => {}),
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  recomputeBucketsForMeasurement: vi.fn(async () => {}),
  collapseToTypeDayKeys: vi.fn(
    (rows: Array<{ type: string; measuredAt: Date }>) => rows,
  ),
}));

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { emitInsertedMeasurementArrivals } from "@/lib/arrivals/measurement-emit";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";
import { POST } from "../route";

const measuredAt = new Date("2026-07-18T06:30:00.000Z");

function row(id: string, type: string, value: number) {
  return {
    id,
    userId: "user-1",
    type,
    value,
    unit:
      type === "WEIGHT" ? "kg" : type === "SLEEP_DURATION" ? "minutes" : "mmHg",
    source: "MANUAL",
    measuredAt,
    notes: null,
    notesEncrypted: null,
    glucoseContext: null,
    deviceType: null,
    createdAt: measuredAt,
    updatedAt: measuredAt,
  };
}

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/measurements", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/measurements — exact arrival wiring", () => {
  it("passes a fresh single sleep insert to the morning refresh seam", async () => {
    const created = row("sleep-1", "SLEEP_DURATION", 450);
    vi.mocked(prisma.measurement.create).mockResolvedValue(created as never);

    const response = await (
      POST as unknown as (request: NextRequest) => Promise<Response>
    )(
      request({
        type: "SLEEP_DURATION",
        value: 450,
        measuredAt: measuredAt.toISOString(),
      }),
    );

    expect(response.status).toBe(201);
    expect(maybeEnqueueMorningRefresh).toHaveBeenCalledWith("user-1", [
      measuredAt,
    ]);
    expect(emitInsertedMeasurementArrivals).toHaveBeenCalledWith(
      "user-1",
      [created],
      "manual",
    );
  });

  it("passes only fresh sleep timestamps from an array create to the morning seam", async () => {
    const created = [
      row("sleep-batch-1", "SLEEP_DURATION", 435),
      row("pulse-batch-1", "PULSE", 64),
    ];
    vi.mocked(prisma.measurement.create)
      .mockResolvedValueOnce(created[0] as never)
      .mockResolvedValueOnce(created[1] as never);

    const response = await (
      POST as unknown as (request: NextRequest) => Promise<Response>
    )(
      request(
        created.map(({ type, value }) => ({
          type,
          value,
          measuredAt: measuredAt.toISOString(),
        })),
      ),
    );

    expect(response.status).toBe(201);
    expect(emitInsertedMeasurementArrivals).toHaveBeenCalledWith(
      "user-1",
      created,
      "manual",
    );
    expect(maybeEnqueueMorningRefresh).toHaveBeenCalledWith("user-1", [
      measuredAt,
    ]);
  });

  it("passes the exact returned weight and BP batch inserts to the arrival helper", async () => {
    const created = [
      row("weight-1", "WEIGHT", 82),
      row("sys-1", "BLOOD_PRESSURE_SYS", 120),
      row("dia-1", "BLOOD_PRESSURE_DIA", 78),
    ];
    vi.mocked(prisma.measurement.create)
      .mockResolvedValueOnce(created[0] as never)
      .mockResolvedValueOnce(created[1] as never)
      .mockResolvedValueOnce(created[2] as never);

    const response = await (
      POST as unknown as (request: NextRequest) => Promise<Response>
    )(
      request(
        created.map(({ type, value }) => ({
          type,
          value,
          measuredAt: measuredAt.toISOString(),
        })),
      ),
    );

    expect(response.status).toBe(201);
    expect(emitInsertedMeasurementArrivals).toHaveBeenCalledWith(
      "user-1",
      created,
      "manual",
    );
    expect(maybeEnqueueMorningRefresh).not.toHaveBeenCalled();
  });

  it("does not invoke arrival callbacks for a duplicate single create", async () => {
    vi.mocked(prisma.measurement.create).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    const response = await (
      POST as unknown as (request: NextRequest) => Promise<Response>
    )(
      request({
        type: "WEIGHT",
        value: 82,
        measuredAt: measuredAt.toISOString(),
      }),
    );

    expect(response.status).toBe(409);
    expect(emitInsertedMeasurementArrivals).not.toHaveBeenCalled();
    expect(maybeEnqueueMorningRefresh).not.toHaveBeenCalled();
  });

  it("keeps the successful write response when both best-effort callbacks reject", async () => {
    const created = row("sleep-2", "SLEEP_DURATION", 420);
    vi.mocked(prisma.measurement.create).mockResolvedValue(created as never);
    vi.mocked(emitInsertedMeasurementArrivals).mockRejectedValueOnce(
      new Error("arrival unavailable"),
    );
    vi.mocked(maybeEnqueueMorningRefresh).mockRejectedValueOnce(
      new Error("morning unavailable"),
    );

    const response = await (
      POST as unknown as (request: NextRequest) => Promise<Response>
    )(
      request({
        type: "SLEEP_DURATION",
        value: 420,
        measuredAt: measuredAt.toISOString(),
      }),
    );

    expect(response.status).toBe(201);
  });
});
