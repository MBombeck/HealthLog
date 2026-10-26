/**
 * Parity for `GET` and `DELETE /api/workouts/{id}` while their logic moves
 * into `src/lib/workouts/`.
 *
 * Workouts land through the real batch ingest (a HealthKit run with its
 * heart-rate series and a kept track, the same run entered by hand, an
 * earlier run, a ride), then the detail read walks the cases it tells apart:
 * the canonical row, its hidden twin, the compact body, another account's
 * row, and the module switched off. The delete walk covers a hand-entered
 * workout with the record it set, a synced workout and a missing one. Each
 * snapshot holds the response, the wide event, the recorded queue tail and,
 * for the deletes, the workouts and records read back.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DELETE, GET } from "@/app/api/workouts/[id]/route";
import { POST as postBatch } from "@/app/api/workouts/batch/route";

import { callRoute, type RouteAuth } from "../../../kit/call-route";
import { makeSession, makeUser } from "../../../kit/factories";
import {
  effectRecorder,
  eventFacts,
  expectParity,
  stable,
  wideEventRecorder,
} from "../../../kit/parity";
import { getPrismaClient, truncateAllTables } from "../../setup";

vi.mock("@/lib/logging/transports", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/logging/transports")>();
  const { wideEventRecorder: recorder } = await import("../../../kit/parity");
  return {
    ...actual,
    emitIfSampled: (event: (typeof recorder.events)[number]) => {
      recorder.events.push(event);
    },
  };
});
vi.mock("@/lib/arrivals/emit-shared", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/arrivals/emit-shared")>();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    emitDataArrival: async (...args: unknown[]) => {
      effectRecorder.record("emitDataArrival", args);
    },
  };
});
vi.mock("@/lib/jobs/pr-detection", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/jobs/pr-detection")>();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    enqueuePrDetection: async (...args: unknown[]) => {
      effectRecorder.record("enqueuePrDetection", args);
    },
  };
});

const prisma = getPrismaClient();
const NOW = new Date("2026-10-15T12:00:00.000Z");

let userId: string;
let owner: RouteAuth;
let stranger: RouteAuth;
const ids: Record<string, string> = {};

const SERIES = [
  { t: "2026-10-14T06:30:00.000Z", hr: 121 },
  { t: "2026-10-14T06:35:00.000Z", hr: 142 },
  { t: "2026-10-14T06:40:00.000Z", hr: 151 },
  { t: "2026-10-14T06:45:00.000Z", hr: 147 },
];

const TRACK = {
  geometry: {
    type: "LineString",
    coordinates: [
      [7.2162, 51.4818, 98],
      [7.2262, 51.4868, 104],
      [7.2383, 51.4929, 101],
    ],
  },
  sampleTimestamps: [
    { t: "2026-10-14T06:30:00.000Z", hr: 120 },
    { t: "2026-10-14T06:38:00.000Z", hr: 141 },
    { t: "2026-10-14T06:46:00.000Z", hr: 150 },
  ],
};

function workout(
  externalId: string,
  start: string,
  minutes: number,
  extra: Record<string, unknown> = {},
) {
  const startedAt = new Date(start);
  return {
    sportType: "running",
    startedAt: startedAt.toISOString(),
    endedAt: new Date(startedAt.getTime() + minutes * 60_000).toISOString(),
    source: "APPLE_HEALTH",
    externalId,
    ...extra,
  };
}

async function idOf(externalId: string): Promise<string> {
  const row = await prisma.workout.findFirstOrThrow({
    where: { userId, externalId },
    select: { id: true },
  });
  return row.id;
}

async function stored() {
  const [workouts, records] = await Promise.all([
    prisma.workout.findMany({
      where: { userId },
      orderBy: [{ startedAt: "asc" }, { source: "asc" }],
      select: { id: true, source: true, externalId: true, sportType: true },
    }),
    prisma.personalRecord.findMany({
      where: { userId },
      orderBy: { metricSlot: "asc" },
      select: { metricSlot: true, value: true, externalId: true, source: true },
    }),
  ]);
  return { workouts, records };
}

async function step(
  name: string,
  call: {
    method: "GET" | "DELETE";
    id: string;
    query?: Record<string, string>;
    auth?: RouteAuth;
    readBack?: boolean;
  },
): Promise<void> {
  wideEventRecorder.take();
  effectRecorder.take();
  const res = await callRoute(call.method === "GET" ? GET : DELETE, {
    method: call.method,
    route: "/api/workouts/{id}",
    params: { id: call.id },
    query: call.query,
    auth: call.auth ?? owner,
  });
  const events = wideEventRecorder.take();
  expect(events.length).toBeGreaterThan(0);
  await expectParity(
    `workout-detail.${name}`,
    stable(
      {
        status: res.status,
        body: res.body,
        events: events.map(eventFacts),
        effects: effectRecorder.take(),
        ...(call.readBack ? { stored: await stored() } : {}),
      },
      { since: NOW },
    ),
  );
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  const user = await makeUser({
    timezone: "Europe/Berlin",
    dateOfBirth: new Date("1980-05-01T00:00:00.000Z"),
    storeWorkoutRoutes: true,
  });
  userId = user.id;
  owner = await makeSession(user);
  stranger = await makeSession(await makeUser({ timezone: "UTC" }));

  const res = await callRoute(postBatch, {
    method: "POST",
    route: "/api/workouts/batch",
    auth: owner,
    body: {
      workouts: [
        workout("hk-run-1", "2026-10-14T06:30:00.000Z", 16, {
          totalDistanceM: 3_200,
          totalEnergyKcal: 260,
          avgHeartRate: 146,
          maxHeartRate: 158,
          samples: SERIES,
          route: TRACK,
        }),
        workout("hk-run-0", "2026-10-07T06:30:00.000Z", 30, {
          totalDistanceM: 5_000,
          avgHeartRate: 140,
        }),
        workout("hk-ride-1", "2026-10-12T16:00:00.000Z", 60, {
          sportType: "cycling",
          totalDistanceM: 24_000,
        }),
        workout("manual:walk-1", "2026-10-10T18:00:00.000Z", 40, {
          sportType: "walking",
          source: "MANUAL",
          totalDistanceM: 3_000,
        }),
      ],
    },
  });
  expect(res.status).toBe(200);
  // The same run typed in by hand: a twin the canonical picker hides.
  const twin = await prisma.workout.create({
    data: {
      userId,
      sportType: "running",
      startedAt: new Date("2026-10-14T06:30:20.000Z"),
      endedAt: new Date("2026-10-14T06:46:20.000Z"),
      durationSec: 960,
      source: "MANUAL",
      externalId: "manual:run-twin",
      totalDistanceM: 3_150,
    },
  });
  ids.twin = twin.id;
  ids.run = await idOf("hk-run-1");
  ids.ride = await idOf("hk-ride-1");
  ids.walk = await idOf("manual:walk-1");
  await prisma.personalRecord.create({
    data: {
      userId,
      metricType: "WALKING_RUNNING_DISTANCE",
      metricSlot: "longest_distance_run",
      direction: "MAX",
      value: 3_000,
      unit: "m",
      achievedAt: new Date("2026-10-10T18:00:00.000Z"),
      source: "MANUAL",
      externalId: "manual:walk-1",
    },
  });
});

afterAll(() => {
  vi.useRealTimers();
});

describe("GET /api/workouts/{id} parity", () => {
  it("the detail reads", async () => {
    await step("get-01-canonical", { method: "GET", id: ids.run });
    await step("get-02-compact", {
      method: "GET",
      id: ids.run,
      query: { compact: "1" },
    });
    await step("get-03-hidden-twin", { method: "GET", id: ids.twin });
    await step("get-04-ride", { method: "GET", id: ids.ride });
    await step("get-05-other-account", {
      method: "GET",
      id: ids.run,
      auth: stranger,
    });
    await step("get-06-missing", {
      method: "GET",
      id: "cmissingworkout000000000",
    });
  });

  it("the module switched off", async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { modulePreferencesJson: { workouts: false } },
    });
    await step("get-07-module-off", { method: "GET", id: ids.run });
    await prisma.user.update({
      where: { id: userId },
      data: { modulePreferencesJson: {} },
    });
  });
});

describe("DELETE /api/workouts/{id} parity", () => {
  it("a synced workout, a missing one, another account's", async () => {
    await step("delete-01-synced", {
      method: "DELETE",
      id: ids.ride,
      readBack: true,
    });
    await step("delete-02-missing", {
      method: "DELETE",
      id: "cmissingworkout000000000",
    });
    await step("delete-03-other-account", {
      method: "DELETE",
      id: ids.walk,
      auth: stranger,
      readBack: true,
    });
  });

  it("a hand-entered workout and the record it set", async () => {
    await step("delete-04-manual", {
      method: "DELETE",
      id: ids.walk,
      readBack: true,
    });
  });
});
