/**
 * Unit suite for `POST /api/workouts/batch`.
 *
 * Database-free coverage of the surface that doesn't require a real
 * Postgres — the per-entry status envelope, the rate-limit gate, the
 * payload-size ceiling, the Zod-parse short-circuits, and the
 * race-reconciliation downgrade pass. Full request-lifecycle assertions
 * (idempotency replay, real-DB dedup, concurrent-write race) live in
 * the matching `tests/integration/workout-batch-create.test.ts`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    workout: {
      findMany: vi.fn(),
      createMany: vi.fn(),
      findFirst: vi.fn(),
    },
    workoutRoute: {
      createMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(async (fn: unknown) => {
      // Same shape as the real Prisma client — invoke the supplied
      // callback with the mocked client itself so `tx.workout.createMany`
      // calls land on the same vi.fn instances.
      if (typeof fn === "function") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (fn as any)((prisma as unknown as { workout: unknown }));
      }
    }),
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

import { POST } from "../batch/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { enqueuePrDetection } from "@/lib/jobs/pr-detection";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

function makeRequest(
  body: unknown,
  opts: {
    contentLength?: number | null;
    headers?: Record<string, string>;
  } = {},
): NextRequest {
  const baseHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...(opts.headers ?? {}),
  };
  const serialized = JSON.stringify(body);
  if (opts.contentLength !== null) {
    baseHeaders["content-length"] = String(
      opts.contentLength ?? serialized.length,
    );
  }
  return new NextRequest("http://localhost/api/workouts/batch", {
    method: "POST",
    headers: baseHeaders,
    body: serialized,
  });
}

function validWorkout(externalId: string, overrides: Record<string, unknown> = {}) {
  return {
    sportType: "running",
    startedAt: "2026-05-14T06:30:00.000Z",
    endedAt: "2026-05-14T07:15:00.000Z",
    source: "APPLE_HEALTH",
    externalId,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 60,
    resetAt: Date.now() + 60_000,
  });
  vi.mocked(prisma.workout.findMany).mockResolvedValue([]);
  vi.mocked(prisma.workout.createMany).mockResolvedValue({ count: 0 });
  vi.mocked(prisma.workout.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.workoutRoute.createMany).mockResolvedValue({ count: 0 });
  // v1.4.43 W9 — default to no per-user source-priority override so
  // the write-time picker walks the canonical default ladder. Tests
  // that exercise a custom ladder override this in-line.
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    sourcePriorityJson: null,
  } as never);
});

describe("POST /api/workouts/batch — auth + size + rate-limit", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await POST(makeRequest({ workouts: [validWorkout("a")] }));
    expect(res.status).toBe(401);
  });

  it("returns 413 when Content-Length exceeds the 5 MB ceiling", async () => {
    const res = await POST(
      makeRequest(
        { workouts: [validWorkout("uuid-1")] },
        { contentLength: 6 * 1024 * 1024 },
      ),
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as {
      error: string;
      meta?: { errorCode?: string };
    };
    expect(body.meta?.errorCode).toBe("workout.batch.payload_too_large");
  });

  it("returns 429 when the rate-limit gate blocks the call", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await POST(makeRequest({ workouts: [validWorkout("uuid-1")] }));
    expect(res.status).toBe(429);
    // We must NOT have queried Prisma after a rate-limit miss — the
    // gate's whole point is to short-circuit before the DB.
    expect(prisma.workout.createMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/workouts/batch — validation", () => {
  it("returns 400 when the workouts array exceeds the per-batch cap", async () => {
    const workouts = Array.from({ length: 101 }, (_, i) =>
      validWorkout(`uuid-${i}`),
    );
    const res = await POST(makeRequest({ workouts }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      meta?: { errorCode?: string };
    };
    expect(body.meta?.errorCode).toBe("workout.batch.too_large");
  });

  it("returns 400 when the Zod schema rejects the payload", async () => {
    const res = await POST(
      makeRequest({
        workouts: [
          {
            // Missing required fields — Zod must reject.
            sportType: "running",
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      meta?: { errorCode?: string };
    };
    expect(body.meta?.errorCode).toBe("workout.batch.invalid");
  });

  it("returns 400 when a route exceeds the 20 000-point cap", async () => {
    // 20 001 points — schema must reject before the handler reaches
    // its DB layer. We assert no Prisma query fires.
    const coordinates: [number, number][] = [];
    for (let i = 0; i < 20_001; i++) {
      coordinates.push([11 + i * 1e-7, 49 + i * 1e-7]);
    }
    const res = await POST(
      makeRequest(
        {
          workouts: [
            validWorkout("uuid-route-cap", {
              route: { geometry: { type: "LineString", coordinates } },
            }),
          ],
        },
        // Skip the Content-Length check — 20k coordinates serialised
        // is well under 5 MB and the request as built has the real
        // header anyway. The test asserts that the SCHEMA cap fires
        // even when the byte cap doesn't.
        { contentLength: null },
      ),
    );
    expect(res.status).toBe(400);
    expect(prisma.workout.createMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/workouts/batch — per-entry status envelope", () => {
  it("marks every fresh entry as inserted", async () => {
    vi.mocked(prisma.workout.createMany).mockResolvedValue({ count: 2 });
    const res = await POST(
      makeRequest({
        workouts: [
          // Two distinct runs separated by 2 h so the v1.4.42 W5
          // write-time canonical-row picker treats them as separate
          // workouts. Without the spacing the picker would collapse
          // them to one survivor (same userId + sportType + startedAt
          // inside the 90 s dedup window) and the envelope-count
          // assertion would mask the per-entry status pin.
          validWorkout("uuid-fresh-1"),
          validWorkout("uuid-fresh-2", {
            startedAt: "2026-05-14T08:30:00.000Z",
            endedAt: "2026-05-14T09:15:00.000Z",
          }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        processed: number;
        inserted: number;
        duplicates: number;
        entries: Array<{ status: string }>;
      };
    };
    expect(body.data.processed).toBe(2);
    expect(body.data.inserted).toBe(2);
    expect(body.data.duplicates).toBe(0);
    expect(body.data.entries.every((e) => e.status === "inserted")).toBe(true);
  });

  it("flags entries already in the DB as duplicate without re-inserting", async () => {
    vi.mocked(prisma.workout.findMany).mockResolvedValue([
      { source: "APPLE_HEALTH", externalId: "uuid-existing" },
    ] as never);
    vi.mocked(prisma.workout.createMany).mockResolvedValue({ count: 1 });
    const res = await POST(
      makeRequest({
        workouts: [
          // Same spacing rationale as the prior test — keep the two
          // entries' `startedAt` outside the W5 dedup window so the
          // pre-`createMany` pass doesn't collapse them.
          validWorkout("uuid-existing"),
          validWorkout("uuid-fresh", {
            startedAt: "2026-05-14T08:30:00.000Z",
            endedAt: "2026-05-14T09:15:00.000Z",
          }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        inserted: number;
        duplicates: number;
        entries: Array<{ index: number; status: string }>;
      };
    };
    expect(body.data.inserted).toBe(1);
    expect(body.data.duplicates).toBe(1);
    expect(body.data.entries[0]?.status).toBe("duplicate");
    expect(body.data.entries[1]?.status).toBe("inserted");
  });

  it("downgrades inserted statuses to duplicate when createMany.count < attempted (race)", async () => {
    // Pre-flight findMany returns empty (no obvious duplicates), so
    // every entry is initially marked "inserted". createMany then
    // returns count=1 — the other batch already won the race for one
    // row. The race-reconciliation block must downgrade exactly one
    // "inserted" status to "duplicate" so the envelope sums match the
    // aggregate counts (the v1.4.25 W10 fix-C invariant).
    vi.mocked(prisma.workout.findMany).mockResolvedValue([]);
    vi.mocked(prisma.workout.createMany).mockResolvedValue({ count: 1 });
    const res = await POST(
      makeRequest({
        workouts: [
          // Same spacing rationale as the per-entry tests — keep both
          // entries outside the W5 dedup window so the race-reconcile
          // contract is exercised directly without the write-time
          // canonical-picker absorbing one of the rows first.
          validWorkout("uuid-race-1"),
          validWorkout("uuid-race-2", {
            startedAt: "2026-05-14T08:30:00.000Z",
            endedAt: "2026-05-14T09:15:00.000Z",
          }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        inserted: number;
        duplicates: number;
        entries: Array<{ status: string }>;
      };
    };
    const insertedEntries = body.data.entries.filter(
      (e) => e.status === "inserted",
    ).length;
    const duplicateEntries = body.data.entries.filter(
      (e) => e.status === "duplicate",
    ).length;
    expect(insertedEntries).toBe(body.data.inserted);
    expect(duplicateEntries).toBe(body.data.duplicates);
    expect(body.data.inserted).toBe(1);
    expect(body.data.duplicates).toBe(1);
  });
});

describe("POST /api/workouts/batch — nested route attachment", () => {
  it("creates a WorkoutRoute row for a workout that ships a route", async () => {
    vi.mocked(prisma.workout.createMany).mockResolvedValue({ count: 1 });
    // Post-insert lookup returns the newly-inserted workout id so the
    // route can be attached by FK.
    vi.mocked(prisma.workout.findMany).mockImplementation((async (args: {
      select?: { id?: true; source?: true; externalId?: true };
    }) => {
      if (args.select?.id) {
        return [
          {
            id: "wkt-fresh-id",
            source: "APPLE_HEALTH",
            externalId: "uuid-with-route",
          },
        ];
      }
      return [];
    }) as never);

    const res = await POST(
      makeRequest({
        workouts: [
          validWorkout("uuid-with-route", {
            route: {
              geometry: {
                type: "LineString",
                coordinates: [
                  [11.077, 49.452],
                  [11.078, 49.453],
                ],
              },
            },
          }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.workoutRoute.createMany).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.workoutRoute.createMany).mock.calls[0]?.[0];
    const rows = (call as { data: Array<{ workoutId: string }> }).data;
    expect(rows[0]?.workoutId).toBe("wkt-fresh-id");
  });
});

describe("POST /api/workouts/batch — user source-priority (v1.4.43 W9)", () => {
  it("looks up the user's source-priority blob exactly once per batch", async () => {
    vi.mocked(prisma.workout.createMany).mockResolvedValue({ count: 1 });
    const res = await POST(
      makeRequest({
        workouts: [
          validWorkout("uuid-prio-1"),
          validWorkout("uuid-prio-2", {
            startedAt: "2026-05-14T08:30:00.000Z",
            endedAt: "2026-05-14T09:15:00.000Z",
          }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { sourcePriorityJson: true },
    });
  });

  it("threads a custom MANUAL>APPLE_HEALTH ladder so the user's preferred row survives the write-time dedup", async () => {
    // User has flipped the default in Settings. Two rows for the same
    // logical run inside the 90 s write-time window — MANUAL must
    // win because the user told us so.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      sourcePriorityJson: {
        steps: ["MANUAL", "APPLE_HEALTH", "WITHINGS"],
      },
    } as never);
    vi.mocked(prisma.workout.createMany).mockResolvedValue({ count: 1 });

    const res = await POST(
      makeRequest({
        workouts: [
          validWorkout("uuid-apple", { source: "APPLE_HEALTH" }),
          validWorkout("uuid-manual", {
            source: "MANUAL",
            startedAt: "2026-05-14T06:31:00.000Z",
            endedAt: "2026-05-14T07:16:00.000Z",
          }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        inserted: number;
        duplicates: number;
        entries: Array<{ index: number; status: string }>;
      };
    };
    // One survivor (MANUAL), one dropped twin (APPLE_HEALTH).
    expect(body.data.inserted).toBe(1);
    expect(body.data.duplicates).toBe(1);
    // The Apple row at index 0 is the duplicate; the Manual row at
    // index 1 is the survivor.
    expect(body.data.entries[0]?.status).toBe("duplicate");
    expect(body.data.entries[1]?.status).toBe("inserted");
  });
});

describe("POST /api/workouts/batch — PR detection enqueue (v1.4.25 W16c)", () => {
  it("enqueues PR detection after a successful batch with silent=false", async () => {
    vi.mocked(prisma.workout.createMany).mockResolvedValue({ count: 1 });
    const res = await POST(
      makeRequest({ workouts: [validWorkout("uuid-small")] }),
    );
    expect(res.status).toBe(200);
    expect(enqueuePrDetection).toHaveBeenCalledTimes(1);
    expect(enqueuePrDetection).toHaveBeenCalledWith("user-1", {
      silent: false,
    });
  });

  it("propagates silent=true when the batch exceeds the historical threshold", async () => {
    const big = Array.from({ length: 51 }, (_, i) =>
      validWorkout(`uuid-${i}`),
    );
    vi.mocked(prisma.workout.createMany).mockResolvedValue({ count: 51 });
    const res = await POST(makeRequest({ workouts: big }));
    expect(res.status).toBe(200);
    expect(enqueuePrDetection).toHaveBeenCalledWith("user-1", {
      silent: true,
    });
  });

  it("still enqueues for an all-duplicate batch (cursor cleanup path)", async () => {
    // Pre-flight dedup matches all incoming entries, so insertedCount
    // stays 0 but duplicateCount becomes 1. The hook fires anyway —
    // the detector is cheap and a duplicate batch can still reveal a
    // PR if the row was written by another path between dispatches.
    vi.mocked(prisma.workout.findMany).mockResolvedValue([
      { source: "APPLE_HEALTH", externalId: "uuid-dup" } as never,
    ]);
    vi.mocked(prisma.workout.createMany).mockResolvedValue({ count: 0 });
    const res = await POST(
      makeRequest({ workouts: [validWorkout("uuid-dup")] }),
    );
    expect(res.status).toBe(200);
    expect(enqueuePrDetection).toHaveBeenCalledTimes(1);
    expect(enqueuePrDetection).toHaveBeenCalledWith("user-1", {
      silent: false,
    });
  });
});
