/**
 * Integration suite for the heart-rate series enrichment path of
 * `POST /api/workouts/batch`, against a real Postgres in a testcontainer.
 *
 * The case: the native client posted a workout before it learned to send
 * the per-workout HR series. The row exists, the curve does not. A later
 * re-post of the SAME `(source, externalId)` carrying a `samples` array
 * attaches the series to the stored workout and reports the entry as
 * `enriched`.
 *
 * What the suite pins:
 *   - The attach happens once and reports `enriched`
 *   - A second re-post over an existing series is a no-op and never
 *     reports `enriched` twice
 *   - The workout row is byte-identical across the enrichment — every
 *     column, `updatedAt` included, compared as a whole row
 *   - A malformed `samples` array is refused per entry; the rest of the
 *     batch still lands
 *   - A batch mixing insert / enrich / duplicate / skip reports each
 *     entry with its own status
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-workout-enrich-integration-32-bytes-min-1234567890";
process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const TEST_USER_ID = "user-workout-enrich-test";

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
      username: "workout-enrich",
      email: "workout-enrich@example.test",
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
  source?: string;
  externalId?: string;
  metadata?: Record<string, unknown>;
  samples?: unknown;
}

interface BatchResponse {
  processed: number;
  inserted: number;
  duplicates: number;
  skipped: Array<{ index: number; reason: string }>;
  entries: Array<{ index: number; status: string; reason?: string }>;
}

function makeRequest(body: { workouts: WorkoutFixture[] }): NextRequest {
  return new NextRequest("http://localhost/api/workouts/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

const SERIES = [
  { t: "2026-05-14T06:30:00.000Z", hr: 121 },
  { t: "2026-05-14T06:30:05.000Z", hr: 128, cadence: 168 },
  { t: "2026-05-14T06:30:10.000Z", hr: 133 },
];

async function post(body: {
  workouts: WorkoutFixture[];
}): Promise<{ status: number; data: BatchResponse }> {
  const { POST } = await import("@/app/api/workouts/batch/route");
  const res = await POST(makeRequest(body));
  const json = (await res.json()) as { data: BatchResponse };
  return { status: res.status, data: json.data };
}

describe("POST /api/workouts/batch — HR series enrichment (real Postgres)", () => {
  it("attaches the series to a stored workout that has none and reports enriched", async () => {
    const first = await post({
      workouts: [baseWorkout("hk-uuid-enrich-001")],
    });
    expect(first.status).toBe(200);
    expect(first.data.inserted).toBe(1);
    expect(
      await getPrismaClient().workoutSamples.count({
        where: { workout: { userId: TEST_USER_ID } },
      }),
    ).toBe(0);

    const second = await post({
      workouts: [baseWorkout("hk-uuid-enrich-001", { samples: SERIES })],
    });
    expect(second.status).toBe(200);
    expect(second.data.inserted).toBe(0);
    expect(second.data.entries).toEqual([{ index: 0, status: "enriched" }]);

    const stored = await getPrismaClient().workout.findFirst({
      where: { userId: TEST_USER_ID, externalId: "hk-uuid-enrich-001" },
      include: { samples: true },
    });
    expect(stored?.samples).not.toBeNull();
    expect(stored?.samples?.sampleCount).toBe(3);
    expect(stored?.samples?.samples).toEqual(SERIES);

    // The workout row count is unchanged — enrichment never mints a row.
    expect(
      await getPrismaClient().workout.count({
        where: { userId: TEST_USER_ID },
      }),
    ).toBe(1);
  });

  it("treats a re-post over an existing series as a no-op and never reports enriched twice", async () => {
    await post({ workouts: [baseWorkout("hk-uuid-enrich-002")] });
    const enriching = await post({
      workouts: [baseWorkout("hk-uuid-enrich-002", { samples: SERIES })],
    });
    expect(enriching.data.entries[0]?.status).toBe("enriched");

    const storedSeries = await getPrismaClient().workoutSamples.findFirst({
      where: { workout: { externalId: "hk-uuid-enrich-002" } },
    });
    expect(storedSeries).not.toBeNull();

    const again = await post({
      workouts: [
        baseWorkout("hk-uuid-enrich-002", {
          samples: [
            ...SERIES,
            { t: "2026-05-14T06:30:15.000Z", hr: 141 },
            { t: "2026-05-14T06:30:20.000Z", hr: 145 },
          ],
        }),
      ],
    });
    expect(again.status).toBe(200);
    expect(again.data.entries[0]?.status).toBe("duplicate");
    expect(again.data.duplicates).toBe(1);

    // The stored series is the first one, untouched — the no-op does not
    // overwrite a curve the server already holds.
    const afterSeries = await getPrismaClient().workoutSamples.findFirst({
      where: { workout: { externalId: "hk-uuid-enrich-002" } },
    });
    expect(afterSeries).toEqual(storedSeries);
    expect(
      await getPrismaClient().workoutSamples.count({
        where: { workout: { userId: TEST_USER_ID } },
      }),
    ).toBe(1);
  });

  it("hands the attach to exactly one of two concurrent enrichments", async () => {
    await post({ workouts: [baseWorkout("hk-uuid-enrich-008")] });

    // Both requests probe a workout with no series, so both mean to
    // attach one. The unique index on `workout_id` decides: one write
    // lands, the other conflicts and is skipped. The loser must report
    // the duplicate it turned out to be rather than claim an attach the
    // database never made — that is the arm this case exists for, and
    // the outcome is deterministic even though the winner is not.
    const { POST } = await import("@/app/api/workouts/batch/route");
    const body = {
      workouts: [baseWorkout("hk-uuid-enrich-008", { samples: SERIES })],
    };
    const [resA, resB] = await Promise.all([
      POST(makeRequest(body)),
      POST(makeRequest(body)),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const [jsonA, jsonB] = (await Promise.all([resA.json(), resB.json()])) as [
      { data: BatchResponse },
      { data: BatchResponse },
    ];
    const statuses = [
      jsonA.data.entries[0]?.status,
      jsonB.data.entries[0]?.status,
    ].sort();
    expect(statuses).toEqual(["duplicate", "enriched"]);
    // Both responses still count the entry as a duplicate row.
    expect(jsonA.data.duplicates).toBe(1);
    expect(jsonB.data.duplicates).toBe(1);
    expect(jsonA.data.inserted + jsonB.data.inserted).toBe(0);

    const series = await getPrismaClient().workoutSamples.findMany({
      where: { workout: { userId: TEST_USER_ID } },
    });
    expect(series).toHaveLength(1);
    expect(series[0]?.sampleCount).toBe(3);
    expect(
      await getPrismaClient().workout.count({
        where: { userId: TEST_USER_ID },
      }),
    ).toBe(1);
  });

  it("reports one enrichment when two entries in one batch aim at the same workout", async () => {
    await post({ workouts: [baseWorkout("hk-uuid-enrich-007")] });

    // Same external id twice, far enough apart in time that the
    // write-time twin dedup keeps both entries. Only one series can land.
    const res = await post({
      workouts: [
        baseWorkout("hk-uuid-enrich-007", { samples: SERIES }),
        baseWorkout("hk-uuid-enrich-007", {
          startedAt: "2026-05-14T09:00:00.000Z",
          endedAt: "2026-05-14T09:45:00.000Z",
          samples: [{ t: "2026-05-14T09:00:00.000Z", hr: 155 }],
        }),
      ],
    });

    expect(res.status).toBe(200);
    expect(
      res.data.entries.filter((e) => e.status === "enriched"),
    ).toHaveLength(1);
    expect(
      await getPrismaClient().workoutSamples.count({
        where: { workout: { userId: TEST_USER_ID } },
      }),
    ).toBe(1);
  });

  it("leaves every workout column byte-identical across an enrichment", async () => {
    await post({
      workouts: [
        baseWorkout("hk-uuid-enrich-003", {
          totalEnergyKcal: 388,
          totalDistanceM: 7100,
          avgHeartRate: 141,
          maxHeartRate: 169,
          minHeartRate: 96,
          metadata: { device: "watch" },
        }),
      ],
    });

    const before = await getPrismaClient().workout.findFirstOrThrow({
      where: { userId: TEST_USER_ID, externalId: "hk-uuid-enrich-003" },
    });

    // A re-post whose every field contradicts the stored row. First-write-
    // wins still governs the workout itself; only the series is attached.
    const enriched = await post({
      workouts: [
        baseWorkout("hk-uuid-enrich-003", {
          sportType: "cycling",
          startedAt: "2026-05-14T09:00:00.000Z",
          endedAt: "2026-05-14T10:30:00.000Z",
          totalEnergyKcal: 999,
          totalDistanceM: 42000,
          avgHeartRate: 111,
          maxHeartRate: 198,
          minHeartRate: 55,
          metadata: { device: "phone" },
          samples: SERIES,
        }),
      ],
    });
    expect(enriched.data.entries[0]?.status).toBe("enriched");

    const after = await getPrismaClient().workout.findFirstOrThrow({
      where: { userId: TEST_USER_ID, externalId: "hk-uuid-enrich-003" },
    });
    // Whole-row comparison — a spot check would miss a column nobody
    // thought to name, and `updatedAt` proves no write touched the row.
    expect(after).toEqual(before);
  });

  it("refuses a malformed samples array per entry without failing the batch", async () => {
    await post({ workouts: [baseWorkout("hk-uuid-enrich-004")] });

    const mixed = await post({
      workouts: [
        baseWorkout("hk-uuid-enrich-004", {
          samples: [{ t: "not-a-timestamp", hr: 4000 }],
        }),
        baseWorkout("hk-uuid-enrich-005", {
          startedAt: "2026-05-15T06:30:00.000Z",
          endedAt: "2026-05-15T07:15:00.000Z",
        }),
      ],
    });

    expect(mixed.status).toBe(200);
    expect(mixed.data.entries[0]?.status).toBe("skipped");
    expect(mixed.data.entries[0]?.reason).toBe("invalid_samples");
    expect(mixed.data.entries[1]?.status).toBe("inserted");
    expect(mixed.data.inserted).toBe(1);
    expect(mixed.data.skipped).toEqual([
      { index: 0, reason: "invalid_samples" },
    ]);

    // Nothing attached to the workout the bad entry addressed.
    expect(
      await getPrismaClient().workoutSamples.count({
        where: { workout: { userId: TEST_USER_ID } },
      }),
    ).toBe(0);
    // And the second entry did land.
    expect(
      await getPrismaClient().workout.count({
        where: { userId: TEST_USER_ID },
      }),
    ).toBe(2);
  });

  it("refuses an over-cap samples array per entry rather than the whole batch", async () => {
    await post({ workouts: [baseWorkout("hk-uuid-enrich-006")] });

    const oversized = Array.from({ length: 30_001 }, (_v, i) => ({
      t: new Date(Date.UTC(2026, 4, 14, 6, 30, 0) + i * 1000).toISOString(),
      hr: 120,
    }));

    const res = await post({
      workouts: [baseWorkout("hk-uuid-enrich-006", { samples: oversized })],
    });
    expect(res.status).toBe(200);
    expect(res.data.entries[0]?.status).toBe("skipped");
    expect(res.data.entries[0]?.reason).toBe("invalid_samples");
    expect(
      await getPrismaClient().workoutSamples.count({
        where: { workout: { userId: TEST_USER_ID } },
      }),
    ).toBe(0);
  });

  it("reports insert, enrich, duplicate and skip side by side in one batch", async () => {
    await post({
      workouts: [
        baseWorkout("hk-uuid-mix-known-series", {
          startedAt: "2026-05-10T06:00:00.000Z",
          endedAt: "2026-05-10T06:45:00.000Z",
        }),
        baseWorkout("hk-uuid-mix-known-plain", {
          startedAt: "2026-05-11T06:00:00.000Z",
          endedAt: "2026-05-11T06:45:00.000Z",
        }),
      ],
    });

    const mixed = await post({
      workouts: [
        // 0 — new workout, inserts
        baseWorkout("hk-uuid-mix-new", {
          startedAt: "2026-05-12T06:00:00.000Z",
          endedAt: "2026-05-12T06:45:00.000Z",
        }),
        // 1 — known workout with a series in the payload, enriches
        baseWorkout("hk-uuid-mix-known-series", {
          startedAt: "2026-05-10T06:00:00.000Z",
          endedAt: "2026-05-10T06:45:00.000Z",
          samples: SERIES,
        }),
        // 2 — known workout, no series in the payload, unchanged
        baseWorkout("hk-uuid-mix-known-plain", {
          startedAt: "2026-05-11T06:00:00.000Z",
          endedAt: "2026-05-11T06:45:00.000Z",
        }),
        // 3 — unusable external id, refused per entry
        baseWorkout("   ", {
          startedAt: "2026-05-13T06:00:00.000Z",
          endedAt: "2026-05-13T06:45:00.000Z",
        }),
      ],
    });

    expect(mixed.status).toBe(200);
    expect(mixed.data.processed).toBe(4);
    expect(mixed.data.entries.map((e) => e.status)).toEqual([
      "inserted",
      "enriched",
      "duplicate",
      "skipped",
    ]);
    expect(mixed.data.inserted).toBe(1);
    // An enriched entry is still a duplicate of the workout row itself —
    // the counters keep counting rows, the entry status carries the detail.
    expect(mixed.data.duplicates).toBe(2);
    expect(mixed.data.skipped).toHaveLength(1);

    const series = await getPrismaClient().workoutSamples.findMany({
      where: { workout: { userId: TEST_USER_ID } },
      include: { workout: { select: { externalId: true } } },
    });
    expect(series).toHaveLength(1);
    expect(series[0]?.workout.externalId).toBe("hk-uuid-mix-known-series");
    expect(
      await getPrismaClient().workout.count({
        where: { userId: TEST_USER_ID },
      }),
    ).toBe(3);
  });
});
