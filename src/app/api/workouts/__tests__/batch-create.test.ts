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
      createManyAndReturn: vi.fn(),
    },
    workoutRoute: {
      createMany: vi.fn(),
    },
    workoutSamples: {
      createManyAndReturn: vi.fn(),
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
        return (fn as any)(prisma as unknown as { workout: unknown });
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

import { POST } from "../batch/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { enqueuePrDetection } from "@/lib/jobs/pr-detection";
import { emitDataArrival } from "@/lib/arrivals/emit-shared";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
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

/**
 * `workout.findMany` serves two callers in this route: the pre-flight
 * probe for rows that already exist (it passes a `where`), and — inside
 * the fake above — the stand-in for `INSERT ... RETURNING` (`select`
 * only). Keying on `select.id` alone stopped telling the two apart once
 * the probe began selecting `id` so an enrichment can address the stored
 * workout, so the RETURNING arm is the one WITHOUT a `where`.
 */
function mockInsertReturning(
  rows: Array<{ id: string; source: string; externalId: string }>,
) {
  vi.mocked(prisma.workout.findMany).mockImplementation((async (args: {
    where?: unknown;
    select?: Record<string, unknown>;
  }) => (args.where === undefined && args.select?.id ? rows : [])) as never);
}

function validWorkout(
  externalId: string,
  overrides: Record<string, unknown> = {},
) {
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
    limit: 60,
    remaining: 60,
    resetAt: Date.now() + 60_000,
  });
  vi.mocked(prisma.workout.findMany).mockResolvedValue([]);
  vi.mocked(prisma.workout.createMany).mockResolvedValue({ count: 0 });
  vi.mocked(prisma.workout.createManyAndReturn).mockImplementation(
    (async (args: {
      data: Record<string, unknown> | Array<Record<string, unknown>>;
      skipDuplicates?: boolean;
    }) => {
      const data = Array.isArray(args.data) ? args.data : [args.data];
      const result = await prisma.workout.createMany({
        data: args.data,
        skipDuplicates: args.skipDuplicates,
      } as never);
      const lookedUp = await prisma.workout.findMany({
        select: { id: true, source: true, externalId: true },
      } as never);
      const returned = lookedUp.filter(
        (row): row is typeof row & { id: string } =>
          typeof (row as { id?: unknown }).id === "string",
      );
      if (returned.length >= result.count) {
        return returned.slice(0, result.count);
      }
      return data.slice(0, result.count).map((row, index) => ({
        ...row,
        id: `inserted-${index}`,
      }));
    }) as never,
  );
  vi.mocked(prisma.workout.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.workoutRoute.createMany).mockResolvedValue({ count: 0 });
  // The series write reports which rows landed, so an enrichment can tell
  // an attach from a row a concurrent writer got in first. The fake
  // echoes every row back as landed.
  vi.mocked(prisma.workoutSamples.createManyAndReturn).mockImplementation(
    (async (args: { data: Array<{ workoutId: string }> }) =>
      args.data.map((row) => ({ workoutId: row.workoutId }))) as never,
  );
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
      limit: 60,
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

  it("marks the exact row returned by the insert as the race winner", async () => {
    vi.mocked(prisma.workout.findMany).mockResolvedValue([]);
    vi.mocked(prisma.workout.createMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.workout.createManyAndReturn).mockResolvedValue([
      {
        id: "winner-1",
        source: "APPLE_HEALTH",
        externalId: "uuid-race-1",
        startedAt: new Date("2026-05-14T06:30:00.000Z"),
        sportType: "running",
        createdAt: new Date("2026-05-14T10:00:00.000Z"),
      },
    ] as never);

    const res = await POST(
      makeRequest({
        workouts: [
          validWorkout("uuid-race-1"),
          validWorkout("uuid-race-2", {
            startedAt: "2026-05-14T08:30:00.000Z",
            endedAt: "2026-05-14T09:15:00.000Z",
          }),
        ],
      }),
    );
    const body = (await res.json()) as {
      data: { entries: Array<{ index: number; status: string }> };
    };

    expect(body.data.entries).toEqual([
      { index: 0, status: "inserted" },
      { index: 1, status: "duplicate" },
    ]);
  });

  it("keeps same external ids from different sources mapped to their own workout", async () => {
    vi.mocked(prisma.workout.createMany).mockResolvedValue({ count: 2 });
    vi.mocked(prisma.workout.createManyAndReturn).mockResolvedValue([
      {
        id: "apple-id",
        source: "APPLE_HEALTH",
        externalId: "shared-external-id",
        startedAt: new Date("2026-05-14T06:30:00.000Z"),
        sportType: "running",
        createdAt: new Date("2026-05-14T10:00:00.000Z"),
      },
      {
        id: "manual-id",
        source: "MANUAL",
        externalId: "shared-external-id",
        startedAt: new Date("2026-05-14T08:30:00.000Z"),
        sportType: "strength",
        createdAt: new Date("2026-05-14T10:00:01.000Z"),
      },
    ] as never);
    mockInsertReturning([
      {
        id: "apple-id",
        source: "APPLE_HEALTH",
        externalId: "shared-external-id",
      },
      {
        id: "manual-id",
        source: "MANUAL",
        externalId: "shared-external-id",
      },
    ]);

    const res = await POST(
      makeRequest({
        workouts: [
          validWorkout("shared-external-id"),
          validWorkout("shared-external-id", {
            source: "MANUAL",
            sportType: "strength",
            startedAt: "2026-05-14T08:30:00.000Z",
            endedAt: "2026-05-14T09:15:00.000Z",
          }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(emitDataArrival).toHaveBeenCalledTimes(2));
    expect(
      vi.mocked(emitDataArrival).mock.calls.map(([call]) => call.refId),
    ).toEqual(["apple-id", "manual-id"]);
  });
});

describe("POST /api/workouts/batch — nested route attachment", () => {
  it("creates a WorkoutRoute row for a workout that ships a route", async () => {
    vi.mocked(prisma.workout.createMany).mockResolvedValue({ count: 1 });
    // Post-insert lookup returns the newly-inserted workout id so the
    // route can be attached by FK.
    mockInsertReturning([
      {
        id: "wkt-fresh-id",
        source: "APPLE_HEALTH",
        externalId: "uuid-with-route",
      },
    ]);

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

describe("POST /api/workouts/batch — per-workout HR series (v1.10.0)", () => {
  it("creates a WorkoutSamples row for an indoor workout (samples, no route)", async () => {
    vi.mocked(prisma.workout.createMany).mockResolvedValue({ count: 1 });
    mockInsertReturning([
      {
        id: "wkt-indoor-id",
        source: "APPLE_HEALTH",
        externalId: "uuid-indoor",
      },
    ]);

    const res = await POST(
      makeRequest({
        workouts: [
          validWorkout("uuid-indoor", {
            sportType: "strength",
            samples: [
              { t: "2026-05-14T06:30:00.000Z", hr: 110 },
              { t: "2026-05-14T06:30:05.000Z", hr: 118 },
              { t: "2026-05-14T06:30:10.000Z", hr: 124, power: 0, cadence: 0 },
            ],
          }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    // The route table is untouched — an indoor workout has no GPS route.
    expect(prisma.workoutRoute.createMany).not.toHaveBeenCalled();
    // The HR series lands in the dedicated child table by FK.
    expect(prisma.workoutSamples.createManyAndReturn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.workoutSamples.createManyAndReturn).mock
      .calls[0]?.[0];
    const rows = (
      call as {
        data: Array<{
          workoutId: string;
          sampleCount: number;
          samples: unknown;
        }>;
      }
    ).data;
    expect(rows[0]?.workoutId).toBe("wkt-indoor-id");
    // `sampleCount` is the denormalised series length.
    expect(rows[0]?.sampleCount).toBe(3);
    expect((rows[0]?.samples as unknown[]).length).toBe(3);
  });

  it("attaches both a route and an HR series on one workout", async () => {
    vi.mocked(prisma.workout.createMany).mockResolvedValue({ count: 1 });
    mockInsertReturning([
      {
        id: "wkt-both-id",
        source: "APPLE_HEALTH",
        externalId: "uuid-both",
      },
    ]);

    const res = await POST(
      makeRequest({
        workouts: [
          validWorkout("uuid-both", {
            route: {
              geometry: {
                type: "LineString",
                coordinates: [
                  [11.077, 49.452],
                  [11.078, 49.453],
                ],
              },
            },
            samples: [{ t: "2026-05-14T06:30:00.000Z", hr: 142 }],
          }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.workoutRoute.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.workoutSamples.createManyAndReturn).toHaveBeenCalledTimes(1);
    const routeRows = (
      vi.mocked(prisma.workoutRoute.createMany).mock.calls[0]?.[0] as {
        data: Array<{ workoutId: string }>;
      }
    ).data;
    const sampleRows = (
      vi.mocked(prisma.workoutSamples.createManyAndReturn).mock
        .calls[0]?.[0] as {
        data: Array<{ workoutId: string }>;
      }
    ).data;
    // Both children attach to the SAME freshly-inserted workout id.
    expect(routeRows[0]?.workoutId).toBe("wkt-both-id");
    expect(sampleRows[0]?.workoutId).toBe("wkt-both-id");
  });

  it("does not touch the samples table when no workout ships a series", async () => {
    vi.mocked(prisma.workout.createMany).mockResolvedValue({ count: 1 });
    const res = await POST(
      makeRequest({ workouts: [validWorkout("uuid-no-series")] }),
    );
    expect(res.status).toBe(200);
    expect(prisma.workoutSamples.createManyAndReturn).not.toHaveBeenCalled();
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
    // Counted by SELECT shape rather than by raw call count: the route also
    // resolves the user's timezone and module map through the arrival seam,
    // which are separate cached lookups. The guard here is that the
    // source-priority blob is read ONCE PER BATCH and never once per workout —
    // two workouts must still produce exactly one read.
    const sourcePriorityReads = vi
      .mocked(prisma.user.findUnique)
      .mock.calls.filter(
        (call) =>
          (call[0] as { select?: Record<string, unknown> })?.select
            ?.sourcePriorityJson === true,
      );
    expect(sourcePriorityReads).toHaveLength(1);
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
    const big = Array.from({ length: 51 }, (_, i) => validWorkout(`uuid-${i}`));
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
