/**
 * Integration suite for the track enrichment path of `POST /api/workouts/batch`,
 * against a real Postgres in a testcontainer.
 *
 * The case: an account turned `storeWorkoutRoutes` on after its workouts were
 * stored without tracks. A later re-post of the SAME `(source, externalId)`
 * carrying a `route` attaches the track to the stored workout, sealed the way
 * an insert seals it, and reports the entry as `enriched`.
 *
 * What the suite pins:
 *   - The attach happens once, sealed, and reports `enriched`; the climb
 *     fills the empty `elevationM` and no other column of the workout moves
 *   - The readers (detail, list) and the backup see the attached track by
 *     construction
 *   - A workout that already holds a track keeps it and reports `duplicate`
 *   - With the opt-in off, nothing is written
 *   - An entry attaching both series and track reports one `enriched`
 *   - Two concurrent batches for the same workout leave one track row and
 *     both answer 200
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-workout-route-enrich-integration-32-bytes-min-12345";
process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const TEST_USER_ID = "user-workout-route-enrich-test";

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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "workout-route-enrich",
      email: "workout-route-enrich@example.test",
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

interface BatchResponse {
  processed: number;
  inserted: number;
  duplicates: number;
  entries: Array<{ index: number; status: string; reason?: string }>;
}

type Geometry = { type: "LineString"; coordinates: number[][] };

const TRACK: Geometry = {
  type: "LineString",
  coordinates: [
    [11.077, 49.452, 300],
    [11.078, 49.453, 312],
    [11.079, 49.454, 325],
  ],
};
const OTHER_TRACK: Geometry = {
  type: "LineString",
  coordinates: [
    [7.21, 51.48, 90],
    [7.22, 51.49, 95],
  ],
};
const SERIES = [
  { t: "2026-05-14T06:30:00.000Z", hr: 121 },
  { t: "2026-05-14T06:30:05.000Z", hr: 128 },
];

function workout(
  externalId: string,
  extra: { route?: { geometry: Geometry }; samples?: unknown } = {},
) {
  return {
    sportType: "running",
    startedAt: "2026-05-14T06:30:00.000Z",
    endedAt: "2026-05-14T07:15:00.000Z",
    source: "APPLE_HEALTH",
    externalId,
    ...extra,
  };
}

async function post(workouts: unknown[]): Promise<{
  status: number;
  data: BatchResponse;
}> {
  const { POST } = await import("@/app/api/workouts/batch/route");
  const res = await POST(
    new NextRequest("http://localhost/api/workouts/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workouts }),
    }),
  );
  const json = (await res.json()) as { data: BatchResponse };
  return { status: res.status, data: json.data };
}

async function keepRoutes(on: boolean): Promise<void> {
  await getPrismaClient().user.update({
    where: { id: TEST_USER_ID },
    data: { storeWorkoutRoutes: on },
  });
}

/** A workout stored before the account kept tracks. */
async function storeWithoutTrack(externalId: string): Promise<string> {
  const first = await post([workout(externalId)]);
  expect(first.data.entries[0]?.status).toBe("inserted");
  const row = await getPrismaClient().workout.findFirstOrThrow({
    where: { userId: TEST_USER_ID, externalId },
    include: { route: true },
  });
  expect(row.route).toBeNull();
  return row.id;
}

async function decrypt(workoutId: string): Promise<unknown> {
  const { decryptRouteGeometry } =
    await import("@/lib/workouts/route-geometry-cipher");
  const route = await getPrismaClient().workoutRoute.findUniqueOrThrow({
    where: { workoutId },
  });
  return decryptRouteGeometry(route.geometryEncrypted!);
}

describe("POST /api/workouts/batch — track enrichment (real Postgres)", () => {
  it("attaches a sealed track to a stored workout without one and reports enriched", async () => {
    const id = await storeWithoutTrack("hk-route-enrich-001");
    const before = await getPrismaClient().workout.findUniqueOrThrow({
      where: { id },
    });
    await keepRoutes(true);

    const second = await post([
      workout("hk-route-enrich-001", { route: { geometry: TRACK } }),
    ]);
    expect(second.status).toBe(200);
    expect(second.data.entries).toEqual([{ index: 0, status: "enriched" }]);
    expect(second.data.inserted).toBe(0);
    expect(second.data.duplicates).toBe(1);

    // Sealed only, exactly like an insert: the readable column is SQL NULL,
    // the ciphertext holds no coordinate, and it opens to what was sent.
    const onDisk = await getPrismaClient().$queryRaw<
      { readable_is_null: boolean; leaks: boolean }[]
    >`
      SELECT geometry IS NULL AS readable_is_null,
             position(convert_to('49.452', 'UTF8') IN geometry_encrypted) > 0
               AS leaks
      FROM workout_routes WHERE workout_id = ${id}`;
    expect(onDisk).toEqual([{ readable_is_null: true, leaks: false }]);
    expect(await decrypt(id)).toEqual(TRACK);

    // The climb fills the empty column (300 → 312 → 325 m); nothing else
    // on the workout row moves.
    const after = await getPrismaClient().workout.findUniqueOrThrow({
      where: { id },
    });
    expect(after.elevationM).toBe(25);
    const { elevationM: _b, updatedAt: _bu, ...restBefore } = before;
    const { elevationM: _a, updatedAt: _au, ...restAfter } = after;
    expect(restAfter).toEqual(restBefore);

    // A third post is a no-op: the track is there now.
    const third = await post([
      workout("hk-route-enrich-001", { route: { geometry: OTHER_TRACK } }),
    ]);
    expect(third.data.entries).toEqual([{ index: 0, status: "duplicate" }]);
    expect(await decrypt(id)).toEqual(TRACK);
  });

  it("serves the attached track to the readers and the climb to the backup", async () => {
    const id = await storeWithoutTrack("hk-route-enrich-readers");
    await keepRoutes(true);
    await post([
      workout("hk-route-enrich-readers", { route: { geometry: TRACK } }),
    ]);

    const { GET: detail } = await import("@/app/api/workouts/[id]/route");
    const detailRes = await detail(
      new NextRequest(`http://localhost/api/workouts/${id}?compact=1`),
      { params: Promise.resolve({ id }) },
    );
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as {
      data: { route: { geometry: unknown } | null };
    };
    expect(detailBody.data.route?.geometry).toEqual(TRACK);

    const { GET: list } = await import("@/app/api/workouts/route");
    const listRes = await list(
      new NextRequest("http://localhost/api/workouts"),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      data: { workouts: Array<{ id: string; hasRoute: boolean }> };
    };
    expect(listBody.data.workouts.find((w) => w.id === id)?.hasRoute).toBe(
      true,
    );

    // Tracks do not travel in the account backup (its manifest says so);
    // the climb they filled does, on the workout row.
    const { buildWorkoutsBackupSlice } =
      await import("@/lib/export/workouts-backup");
    const slice = await buildWorkoutsBackupSlice(
      getPrismaClient(),
      TEST_USER_ID,
      true,
    );
    expect(slice.workouts.find((w) => w.id === id)?.elevationM).toBe(25);
  });

  it("keeps a stored track and reports duplicate", async () => {
    await keepRoutes(true);
    const first = await post([
      workout("hk-route-enrich-kept", { route: { geometry: TRACK } }),
    ]);
    expect(first.data.entries[0]?.status).toBe("inserted");
    const row = await getPrismaClient().workout.findFirstOrThrow({
      where: { externalId: "hk-route-enrich-kept" },
      include: { route: true },
    });

    const second = await post([
      workout("hk-route-enrich-kept", { route: { geometry: OTHER_TRACK } }),
    ]);
    expect(second.data.entries).toEqual([{ index: 0, status: "duplicate" }]);
    const route = await getPrismaClient().workoutRoute.findUniqueOrThrow({
      where: { workoutId: row.id },
    });
    expect(route.id).toBe(row.route!.id);
    expect(await decrypt(row.id)).toEqual(TRACK);
  });

  it("writes nothing while the account keeps no tracks", async () => {
    const id = await storeWithoutTrack("hk-route-enrich-off");
    const before = await getPrismaClient().workout.findUniqueOrThrow({
      where: { id },
    });

    const second = await post([
      workout("hk-route-enrich-off", { route: { geometry: TRACK } }),
    ]);
    expect(second.data.entries).toEqual([{ index: 0, status: "duplicate" }]);
    expect(
      await getPrismaClient().workoutRoute.count({ where: { workoutId: id } }),
    ).toBe(0);
    expect(
      await getPrismaClient().workout.findUniqueOrThrow({ where: { id } }),
    ).toEqual(before);
  });

  it("reports one enriched for an entry that attaches series and track", async () => {
    const id = await storeWithoutTrack("hk-route-enrich-both");
    await keepRoutes(true);

    const second = await post([
      workout("hk-route-enrich-both", {
        route: { geometry: TRACK },
        samples: SERIES,
      }),
    ]);
    expect(second.data.entries).toEqual([{ index: 0, status: "enriched" }]);
    const row = await getPrismaClient().workout.findUniqueOrThrow({
      where: { id },
      include: { route: true, samples: true },
    });
    expect(row.route).not.toBeNull();
    expect(row.samples?.sampleCount).toBe(SERIES.length);
  });

  it("leaves one track row when two batches race for the same workout", async () => {
    const id = await storeWithoutTrack("hk-route-enrich-race");
    await keepRoutes(true);

    const [a, b] = await Promise.all([
      post([workout("hk-route-enrich-race", { route: { geometry: TRACK } })]),
      post([
        workout("hk-route-enrich-race", { route: { geometry: OTHER_TRACK } }),
      ]),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const statuses = [a, b].map((r) => r.data.entries[0]?.status).sort();
    expect(statuses).toEqual(["duplicate", "enriched"]);

    expect(
      await getPrismaClient().workoutRoute.count({ where: { workoutId: id } }),
    ).toBe(1);
    const winner =
      a.data.entries[0]?.status === "enriched" ? TRACK : OTHER_TRACK;
    expect(await decrypt(id)).toEqual(winner);
  });
  it("settles as duplicate when a track lands between the probe and the write", async () => {
    const id = await storeWithoutTrack("hk-route-enrich-gap");
    const { prepareWorkouts } =
      await import("@/lib/workouts/batch-ingest/entries");
    const { planWorkoutWrites } =
      await import("@/lib/workouts/batch-ingest/plan");
    const { writeWorkoutPlan } =
      await import("@/lib/workouts/batch-ingest/write");
    const { encryptRouteGeometry } =
      await import("@/lib/workouts/route-geometry-cipher");
    const { createBatchWorkoutSchema } =
      await import("@/lib/validations/workout");

    const { prepared, results } = prepareWorkouts({
      userId: TEST_USER_ID,
      scoped: false,
      keepRoutes: true,
      // Through the route's own schema, so the entry is the validated shape.
      workouts: createBatchWorkoutSchema.parse({
        workouts: [
          workout("hk-route-enrich-gap", { route: { geometry: TRACK } }),
        ],
      }).workouts,
      refusedSampleIndices: new Set(),
    });
    const plan = await planWorkoutWrites(TEST_USER_ID, prepared, results);
    expect(plan.toEnrich).toHaveLength(1);

    // Another writer gets its track in after the probe.
    await getPrismaClient().workoutRoute.create({
      data: {
        workoutId: id,
        geometryEncrypted: encryptRouteGeometry(OTHER_TRACK),
      },
    });

    const outcome = await writeWorkoutPlan(TEST_USER_ID, plan, results);
    expect(outcome.enrichedCount).toBe(0);
    expect(results[0]).toEqual({ index: 0, status: "duplicate" });
    expect(await decrypt(id)).toEqual(OTHER_TRACK);
    const row = await getPrismaClient().workout.findUniqueOrThrow({
      where: { id },
    });
    // The loser fills no climb either.
    expect(row.elevationM).toBeNull();
  });
});
