/**
 * Integration suite for `POST /api/workouts/batch` — the v1.5 iOS
 * HealthKit ingest endpoint and the deferred Withings activity sync
 * target. Asserts the contract the iOS client relies on against a real
 * Postgres in a testcontainer:
 *
 *   - Mixed batches with nested routes succeed end-to-end
 *   - Re-posting the same batch yields per-entry duplicates
 *   - Over-cap batches return 400 with the documented error code
 *   - Over-cap routes return 400 with the documented error code
 *   - Idempotency-Key replay returns the cached envelope
 *   - Rate-limit kicks in at the documented ceiling
 *   - Narrow-scope Bearer tokens are admitted (W10 fix-C parity)
 *
 * A separate file at this directory carries the concurrent-write race
 * test so the contention assertion stays focused on the invariant that
 * was the original target of the W10 fix-C reconciliation.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

// The HMAC key must be present before any module that touches
// `@/lib/auth/hmac` is imported — `hashToken()` reads it lazily but
// only the first call's process state is exercised here.
process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-workout-batch-integration-32-bytes-min-1234567890";

const { hashToken } = await import("@/lib/auth/hmac");

const TEST_USER_ID = "user-workout-batch-test";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "workout-batch",
      email: "workout-batch@example.test",
    },
  });
  const session = await getPrismaClient().session.create({
    data: {
      userId: TEST_USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
});

interface WorkoutFixture {
  sportType?: string;
  startedAt?: string;
  endedAt?: string;
  totalEnergyKcal?: number;
  totalDistanceM?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  minHeartRate?: number;
  stepCount?: number;
  elevationM?: number;
  pauseDurationSec?: number;
  source?: string;
  externalId?: string;
  externalSourceVersion?: string;
  metadata?: Record<string, unknown>;
  route?: {
    geometry: { type: "LineString"; coordinates: [number, number][] };
    sampleTimestamps?: Array<{ t: string; speedMs?: number; hr?: number }>;
  };
}

function makeRequest(
  body: { workouts: WorkoutFixture[] },
  opts: {
    idempotencyKey?: string;
    bearer?: string;
    contentLength?: number | null;
  } = {},
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.idempotencyKey) {
    headers["idempotency-key"] = opts.idempotencyKey;
  }
  if (opts.bearer) {
    headers["authorization"] = `Bearer ${opts.bearer}`;
  }
  if (opts.contentLength !== null && opts.contentLength !== undefined) {
    headers["content-length"] = String(opts.contentLength);
  }
  const serialized = JSON.stringify(body);
  return new NextRequest("http://localhost/api/workouts/batch", {
    method: "POST",
    headers,
    body: serialized,
  });
}

function baseWorkout(
  externalId: string,
  overrides: WorkoutFixture = {},
): WorkoutFixture {
  return {
    sportType: "running",
    startedAt: "2026-05-14T06:30:00.000Z",
    endedAt: "2026-05-14T07:15:00.000Z",
    source: "APPLE_HEALTH",
    externalId,
    ...overrides,
  };
}

describe("POST /api/workouts/batch (real Postgres)", () => {
  it("inserts a single workout with a nested route", async () => {
    const { POST } = await import("@/app/api/workouts/batch/route");

    const body = {
      workouts: [
        baseWorkout("hk-uuid-route-001", {
          totalEnergyKcal: 412,
          totalDistanceM: 7800,
          avgHeartRate: 154,
          route: {
            geometry: {
              type: "LineString",
              coordinates: [
                [11.077, 49.452],
                [11.078, 49.453],
                [11.079, 49.454],
              ],
            },
            sampleTimestamps: [
              { t: "2026-05-14T06:30:00.000Z", speedMs: 3.2, hr: 142 },
              { t: "2026-05-14T06:30:05.000Z", speedMs: 3.3, hr: 144 },
              { t: "2026-05-14T06:30:10.000Z", speedMs: 3.1, hr: 146 },
            ],
          },
        }),
      ],
    };

    const res = await POST(makeRequest(body));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { processed: number; inserted: number; duplicates: number };
    };
    expect(json.data.processed).toBe(1);
    expect(json.data.inserted).toBe(1);

    const workouts = await getPrismaClient().workout.findMany({
      where: { userId: TEST_USER_ID },
      include: { route: true },
    });
    expect(workouts).toHaveLength(1);
    expect(workouts[0]?.sportType).toBe("running");
    expect(workouts[0]?.totalDistanceM).toBe(7800);
    expect(workouts[0]?.route).not.toBeNull();
    expect(workouts[0]?.durationSec).toBe(45 * 60);
  });

  it("inserts a 100-workout batch with a mix of routed and routeless entries", async () => {
    const { POST } = await import("@/app/api/workouts/batch/route");

    const workouts: WorkoutFixture[] = Array.from({ length: 100 }, (_, i) => {
      const offsetMin = i * 60;
      const start = new Date(2026, 4, 1, 6, offsetMin).toISOString();
      const end = new Date(2026, 4, 1, 6, offsetMin + 30).toISOString();
      const hasRoute = i % 5 === 0;
      return baseWorkout(`hk-uuid-batch-${i}`, {
        startedAt: start,
        endedAt: end,
        ...(hasRoute
          ? {
              route: {
                geometry: {
                  type: "LineString",
                  coordinates: [
                    [11.077 + i * 1e-4, 49.452],
                    [11.078 + i * 1e-4, 49.453],
                  ],
                },
              },
            }
          : {}),
      });
    });

    const res = await POST(makeRequest({ workouts }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { processed: number; inserted: number };
    };
    expect(json.data.processed).toBe(100);
    expect(json.data.inserted).toBe(100);

    const storedWorkouts = await getPrismaClient().workout.count({
      where: { userId: TEST_USER_ID },
    });
    expect(storedWorkouts).toBe(100);
    const storedRoutes = await getPrismaClient().workoutRoute.count({
      where: { workout: { userId: TEST_USER_ID } },
    });
    expect(storedRoutes).toBe(20);
  });

  it("returns 400 with workout.batch.too_large when workouts exceed the cap", async () => {
    const { POST } = await import("@/app/api/workouts/batch/route");

    const workouts = Array.from({ length: 101 }, (_, i) =>
      baseWorkout(`hk-uuid-cap-${i}`),
    );

    const res = await POST(makeRequest({ workouts }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      meta?: { errorCode?: string };
    };
    expect(body.meta?.errorCode).toBe("workout.batch.too_large");

    const stored = await getPrismaClient().workout.count({
      where: { userId: TEST_USER_ID },
    });
    expect(stored).toBe(0);
  });

  it("returns 400 when a single route exceeds the 20 000-point cap", async () => {
    const { POST } = await import("@/app/api/workouts/batch/route");

    const coordinates: [number, number][] = [];
    for (let i = 0; i < 20_001; i++) {
      coordinates.push([11 + i * 1e-7, 49 + i * 1e-7]);
    }

    const res = await POST(
      makeRequest(
        {
          workouts: [
            baseWorkout("hk-uuid-route-cap", {
              route: { geometry: { type: "LineString", coordinates } },
            }),
          ],
        },
        // Skip the Content-Length pre-flight — the test wants to
        // exercise the schema cap, not the byte cap.
        { contentLength: null },
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      meta?: { errorCode?: string };
    };
    expect(body.meta?.errorCode).toBe("workout.batch.invalid");

    const stored = await getPrismaClient().workout.count({
      where: { userId: TEST_USER_ID },
    });
    expect(stored).toBe(0);
  });

  it("collapses same-instant cross-source twins via write-time dedup, then surfaces re-posts as duplicates", async () => {
    const { POST } = await import("@/app/api/workouts/batch/route");

    // Two entries share `sportType`, `startedAt`, and `source`. The
    // v1.4.42 write-time cross-source picker (`dedupeWorkoutBatch`)
    // groups by `(userId, activityType, startedAt ± 90 s)` and keeps
    // ONE canonical row — the other lands as `duplicate` BEFORE
    // reaching the DB. This is the Apple Watch + Withings ScanWatch
    // case the picker exists to handle.
    const body = {
      workouts: [
        baseWorkout("hk-uuid-dup-1"),
        baseWorkout("hk-uuid-dup-2"),
      ],
    };

    const first = await POST(makeRequest(body));
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as {
      data: {
        inserted: number;
        duplicates: number;
        entries: Array<{ status: string }>;
      };
    };
    expect(firstJson.data.inserted).toBe(1);
    expect(firstJson.data.duplicates).toBe(1);

    const second = await POST(makeRequest(body));
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      data: {
        inserted: number;
        duplicates: number;
        entries: Array<{ status: string }>;
      };
    };
    // The write-time dedup still fires on the second post (one twin
    // collapses), and the surviving twin now collides with the row
    // persisted by the first post — so both end up as `duplicate`.
    expect(secondJson.data.inserted).toBe(0);
    expect(secondJson.data.duplicates).toBe(2);
    expect(secondJson.data.entries.every((e) => e.status === "duplicate")).toBe(
      true,
    );

    const stored = await getPrismaClient().workout.count({
      where: { userId: TEST_USER_ID },
    });
    // Only the first-post survivor lives in the DB — write-time dedup
    // dropped the other twin before any DB write.
    expect(stored).toBe(1);
  });

  it("replays a cached response when the same Idempotency-Key is reused", async () => {
    const { POST } = await import("@/app/api/workouts/batch/route");

    const body = {
      workouts: [baseWorkout("hk-uuid-idem-1")],
    };

    const key = "ios-workout-batch-12345678";
    const first = await POST(makeRequest(body, { idempotencyKey: key }));
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { data: { inserted: number } };
    expect(firstJson.data.inserted).toBe(1);

    const second = await POST(makeRequest(body, { idempotencyKey: key }));
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Idempotent-Replay")).toBe("true");
    const secondJson = (await second.json()) as { data: { inserted: number } };
    // Same envelope as the first call — even though it would otherwise
    // have surfaced as a duplicate.
    expect(secondJson.data.inserted).toBe(1);

    const stored = await getPrismaClient().workout.count({
      where: { userId: TEST_USER_ID, externalId: "hk-uuid-idem-1" },
    });
    expect(stored).toBe(1);
  });

  it("rate-limits a user at 60 batches per minute", async () => {
    const { POST } = await import("@/app/api/workouts/batch/route");

    const cap = 60;
    const resetAt = new Date(Date.now() + 60 * 1000);
    await getPrismaClient().$executeRaw`
      INSERT INTO rate_limits (key, count, reset_at)
      VALUES (${`workouts:batch:${TEST_USER_ID}`}, ${cap}, ${resetAt})
    `;

    const res = await POST(
      makeRequest({ workouts: [baseWorkout("hk-uuid-rate-limit-1")] }),
    );
    expect(res.status).toBe(429);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/too many/i);

    const stored = await getPrismaClient().workout.count({
      where: { userId: TEST_USER_ID },
    });
    expect(stored).toBe(0);
  });

  it("admits a narrow-scope Bearer token (W10 fix-C parity)", async () => {
    const { POST } = await import("@/app/api/workouts/batch/route");

    // Drop the cookie session so the Bearer path is the ONLY auth in
    // play. A narrow-scope token (no wildcard) MUST still admit on a
    // route that declares no required permission — that's the W10
    // fix-C correctness fix the iOS narrow-scope sync depends on.
    cookieJar.delete("healthlog_session");

    const rawToken = "hlk_narrow_scope_workout_ingest_token_value_a1b2c3d4e5";
    await getPrismaClient().apiToken.create({
      data: {
        userId: TEST_USER_ID,
        name: "narrow-scope-workouts",
        tokenHash: hashToken(rawToken),
        permissions: ["workouts:ingest"], // NO wildcard
      },
    });
    headerJar.set("authorization", `Bearer ${rawToken}`);

    const res = await POST(
      makeRequest(
        { workouts: [baseWorkout("hk-uuid-narrow-1")] },
        { bearer: rawToken },
      ),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { inserted: number } };
    expect(json.data.inserted).toBe(1);
  });
});
