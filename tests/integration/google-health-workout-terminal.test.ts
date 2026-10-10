/**
 * RED real-PostgreSQL contract: a committed Google workout must be visible
 * through the existing server caches before the sync reports completion.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const mocks = vi.hoisted(() => ({
  fetchDataPoints: vi.fn(),
  mapWorkout: vi.fn(),
  getValidToken: vi.fn(),
  handleCollectionFetchError: vi.fn(),
  noteHardFailure: vi.fn(),
}));

vi.mock("@/lib/google-health/client", () => ({
  GOOGLE_HEALTH_ACTIVITY_PAGE_SIZE: 25,
  GOOGLE_HEALTH_DATA_TYPES: {
    exercise: { key: "exercise", dataType: "exercise" },
  },
  fetchDataPoints: mocks.fetchDataPoints,
  mapWorkout: mocks.mapWorkout,
}));

vi.mock("@/lib/google-health/sync-core", () => ({
  getValidToken: mocks.getValidToken,
  handleCollectionFetchError: mocks.handleCollectionFetchError,
  noteHardFailure: mocks.noteHardFailure,
  googleHealthTokenSource:
    (_userId: string, info: { accessToken: string }) => async () =>
      info.accessToken,
  runGoogleHealthCollection: (_key: string, fn: () => Promise<number>) => fn(),
}));

vi.mock("@/lib/arrivals/workout-emit", () => ({
  emitInsertedWorkoutArrival: vi.fn(async () => undefined),
}));

vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn(async () => "Europe/Berlin"),
}));

import {
  __resetAllCachesForTests,
  cached,
  caches,
} from "@/lib/cache/server-cache";
import { syncUserWorkout } from "@/lib/google-health/sync-workout";
import { readWorkoutsListCached } from "@/lib/workouts/list-read";

const USER_ID = "google-workout-owner";
const LIST_PARAMS = {
  limit: 20,
  offset: 0,
  since: null,
  until: null,
  sportType: null,
} as const;

async function seedUser(): Promise<void> {
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: USER_ID,
      email: `${USER_ID}@example.test`,
    },
  });
}

function mappedWorkout(sportType = "running") {
  return {
    externalId: "google-exercise-1",
    sportType,
    sportTypeRaw: "RUNNING",
    startedAt: new Date("2026-07-29T08:00:00.000Z"),
    endedAt: new Date("2026-07-29T08:30:00.000Z"),
    durationSec: 1800,
    totalEnergyKcal: 280,
    totalDistanceM: 5_000,
    avgHeartRate: 151,
    maxHeartRate: 178,
    minHeartRate: 104,
  };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  __resetAllCachesForTests();
  vi.clearAllMocks();
  mocks.getValidToken.mockResolvedValue({
    accessToken: "test-token",
    connection: { id: "connection-1", googleUserId: "google-owner" },
  });
  mocks.fetchDataPoints.mockResolvedValue([{ name: "exercise-1" }]);
  mocks.mapWorkout.mockReturnValue(mappedWorkout());
  await seedUser();
});

describe("Google Health workout terminal cache visibility (real Postgres)", () => {
  it("exposes a newly committed workout immediately and invalidates dependent server cells", async () => {
    expect(
      (await readWorkoutsListCached(USER_ID, LIST_PARAMS)).workouts,
    ).toEqual([]);
    await cached(caches.analytics, `${USER_ID}|default`, async () => ({
      marker: "analytics-before",
    }));
    await cached(
      caches.analytics,
      `${USER_ID}|dashboard-snapshot|en`,
      async () => ({ marker: "dashboard-before" }),
    );

    await expect(syncUserWorkout(USER_ID)).resolves.toBe(1);

    const row = await getPrismaClient().workout.findUnique({
      where: {
        userId_source_externalId: {
          userId: USER_ID,
          source: "GOOGLE_HEALTH",
          externalId: "google-exercise-1",
        },
      },
    });
    expect(row).toMatchObject({ sportType: "running", durationSec: 1800 });
    await expect(
      readWorkoutsListCached(USER_ID, LIST_PARAMS),
    ).resolves.toMatchObject({
      workouts: [
        {
          externalId: "google-exercise-1",
          sportType: "running",
          source: "GOOGLE_HEALTH",
        },
      ],
    });
    expect(caches.analytics.get(`${USER_ID}|default`)).toBeNull();
    expect(caches.analytics.get(`${USER_ID}|dashboard-snapshot|en`)).toBeNull();
  });

  it("exposes an updated committed workout instead of the primed pre-sync projection", async () => {
    await getPrismaClient().workout.create({
      data: {
        userId: USER_ID,
        source: "GOOGLE_HEALTH",
        externalId: "google-exercise-1",
        sportType: "walking",
        startedAt: new Date("2026-07-29T08:00:00.000Z"),
        endedAt: new Date("2026-07-29T08:20:00.000Z"),
        durationSec: 1200,
      },
    });
    const primed = await readWorkoutsListCached(USER_ID, LIST_PARAMS);
    expect(primed.workouts[0]).toMatchObject({
      sportType: "walking",
      durationSec: 1200,
    });

    mocks.mapWorkout.mockReturnValue(mappedWorkout("running"));
    await expect(syncUserWorkout(USER_ID)).resolves.toBe(1);

    await expect(
      readWorkoutsListCached(USER_ID, LIST_PARAMS),
    ).resolves.toMatchObject({
      workouts: [
        {
          externalId: "google-exercise-1",
          sportType: "running",
          durationSec: 1800,
        },
      ],
    });
  });
});
