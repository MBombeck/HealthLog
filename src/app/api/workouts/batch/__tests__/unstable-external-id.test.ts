/**
 * `POST /api/workouts/batch` — external-id stability floor.
 *
 * `(userId, source, externalId)` is idempotent only while the id survives
 * an app restart. A per-process value — an object description carrying a
 * memory address — never matches its own earlier row, so every re-sync
 * mints another workout for the same session.
 *
 * The refusal is PER ENTRY. A cold-start HealthKit backfill is "every
 * workout I have ever recorded"; losing the whole batch to one bad row
 * would be worse than the duplicate it prevents.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    workout: { findMany: vi.fn(), createManyAndReturn: vi.fn() },
    $transaction: vi.fn(async (fn: unknown) => {
      if (typeof fn === "function") {
        return (fn as (tx: unknown) => unknown)(txClient);
      }
    }),
  },
}));

const txClient = {
  workout: { createManyAndReturn: vi.fn() },
  workoutRoute: { createMany: vi.fn() },
  workoutSamples: { createMany: vi.fn() },
};

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/idempotency", () => ({
  withIdempotency:
    <Args extends unknown[]>(fn: (...args: Args) => Promise<Response>) =>
    (...args: Args) =>
      fn(...args),
}));
vi.mock("@/lib/jobs/pr-detection", () => ({
  enqueuePrDetection: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMeasurements: vi.fn(),
}));
vi.mock("@/lib/arrivals/emit-shared", () => ({
  emitDataArrival: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
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

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/workouts/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A minimal well-formed run; only the id varies per case. */
function workout(externalId: string, offsetMin = 0) {
  const start = new Date(Date.UTC(2026, 5, 15, 6, offsetMin, 0));
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return {
    sportType: "running",
    startedAt: start.toISOString(),
    endedAt: end.toISOString(),
    source: "APPLE_HEALTH",
    externalId,
  };
}

async function entriesFor(workouts: unknown[]) {
  const res = await POST(postReq({ workouts }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: {
      entries: Array<{ index: number; status: string; reason?: string }>;
      skipped: Array<{ index: number; reason: string }>;
    };
  };
  return body.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    sourcePriorityJson: null,
  } as never);
  vi.mocked(prisma.workout.findMany).mockResolvedValue([] as never);
  // Every row handed to the writer comes back inserted, keyed by its id.
  txClient.workout.createManyAndReturn.mockImplementation(
    async (args: {
      data: Array<Record<string, unknown>> | Record<string, unknown>;
    }) => {
      const rows = Array.isArray(args.data) ? args.data : [args.data];
      return rows.map((row, i) => ({
        id: `w-${i}-${String(row.externalId ?? "null")}`,
        source: row.source,
        externalId: row.externalId ?? null,
      }));
    },
  );
  txClient.workoutRoute.createMany.mockResolvedValue({ count: 0 });
  txClient.workoutSamples.createMany.mockResolvedValue({ count: 0 });
});

describe("POST /api/workouts/batch — unstable external ids", () => {
  it("skips the poisoned workout and still writes the two good ones", async () => {
    const data = await entriesFor([
      workout("8AD2A9CB-3F0C-4E4D-9C1E-4B7E2A1D6F30", 0),
      workout("<HKWorkout: 0x12568db80>", 40),
      workout("3f0c4e4d-9c1e-4b7e-2a1d-6f30ad2a9cb1", 80),
    ]);
    expect(data.entries[0].status).toBe("inserted");
    expect(data.entries[1]).toMatchObject({
      index: 1,
      status: "skipped",
      reason: "unstable_external_id",
    });
    expect(data.entries[2].status).toBe("inserted");
    expect(data.skipped).toEqual([
      { index: 1, reason: "unstable_external_id" },
    ]);
    // The writer only ever saw the two good rows.
    const written = txClient.workout.createManyAndReturn.mock.calls.flatMap(
      (call) => {
        const arg = call[0] as { data: unknown };
        return Array.isArray(arg.data) ? arg.data : [arg.data];
      },
    ) as Array<{ externalId: string | null }>;
    expect(written).toHaveLength(2);
    expect(written.map((r) => r.externalId)).not.toContain(
      "<HKWorkout: 0x12568db80>",
    );
  });

  it("skips a bare memory-address id", async () => {
    const data = await entriesFor([workout("0x126b25160")]);
    expect(data.entries[0]).toMatchObject({
      status: "skipped",
      reason: "unstable_external_id",
    });
    expect(txClient.workout.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("never turns one poisoned entry into a whole-batch refusal", async () => {
    const res = await POST(
      postReq({ workouts: [workout("0xdeadbeef"), workout("hk-uuid-41", 40)] }),
    );
    expect(res.status).toBe(200);
  });

  it("accepts the HealthKit workout UUID the iOS sync really sends", async () => {
    const data = await entriesFor([
      workout("8AD2A9CB-3F0C-4E4D-9C1E-4B7E2A1D6F30"),
    ]);
    expect(data.entries[0].status).toBe("inserted");
    expect(txClient.workout.createManyAndReturn).toHaveBeenCalled();
  });

  it("leaves a workout with no externalId alone — NULL is legitimately distinct", async () => {
    const noId: Record<string, unknown> = { ...workout("unused") };
    delete noId.externalId;
    const data = await entriesFor([noId]);
    expect(data.entries[0].status).toBe("inserted");
  });

  it("annotates the refusal with the shape, never the id", async () => {
    await entriesFor([
      workout("<HKWorkout: 0x12568db80>", 0),
      workout("0xdeadbeef", 40),
    ]);
    const calls = vi.mocked(annotate).mock.calls.map(([c]) => c);
    const rejection = calls.find(
      (c) => c?.meta && "external_id_rejected" in c.meta,
    );
    expect(rejection?.meta).toMatchObject({
      external_id_rejected: 2,
      external_id_shapes: "object_description,pointer_address",
      external_id_surface: "workout.batch",
    });
    expect(JSON.stringify(rejection)).not.toContain("0x12568db80");
  });
});
