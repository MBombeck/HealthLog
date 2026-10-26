/**
 * Parity for `POST /api/workouts/batch` while its ingest moves into
 * `src/lib/workouts/batch/`.
 *
 * One account walks through the cases the route tells apart, each request
 * seeing what the earlier ones stored: a first batch (a HealthKit run with
 * its heart-rate series and a track the account does not keep, a
 * hand-entered ride, one with no external id, the same session from two
 * sources, an unstable id and a series that fails validation), the same
 * batch again with a series for a stored workout that had none, a corrected
 * hand-entered workout, a track kept once the account opts in, the two
 * whole-batch refusals, and a narrow bridge token with and without a
 * `source`. After each request the snapshot holds the response, the wide
 * event, the queue and arrival tails, and the stored workouts with their
 * series and tracks (a sealed track as its presence, since its bytes carry
 * a random nonce).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/workouts/batch/route";
import { WORKOUTS_WRITE_SCOPE } from "@/lib/workouts/scopes";

import { callRoute, type RouteAuth } from "../../../kit/call-route";
import { makeSession, makeToken, makeUser } from "../../../kit/factories";
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

type Workout = Record<string, unknown>;

function workout(
  externalId: string | undefined,
  start: string,
  minutes: number,
  extra: Workout = {},
): Workout {
  const startedAt = new Date(start);
  return {
    sportType: "running",
    startedAt: startedAt.toISOString(),
    endedAt: new Date(startedAt.getTime() + minutes * 60_000).toISOString(),
    source: "APPLE_HEALTH",
    ...(externalId === undefined ? {} : { externalId }),
    ...extra,
  };
}

const SERIES = [
  { t: "2026-10-14T06:30:00.000Z", hr: 121 },
  { t: "2026-10-14T06:30:05.000Z", hr: 128, cadence: 168 },
  { t: "2026-10-14T06:30:10.000Z", hr: 133 },
];

const TRACK = {
  geometry: {
    type: "LineString",
    coordinates: [
      [7.2162, 51.4818, 98],
      [7.2171, 51.4822, 104],
      [7.2183, 51.4829, 101],
    ],
  },
  sampleTimestamps: [
    { t: "2026-10-14T06:30:00.000Z", hr: 120 },
    { t: "2026-10-14T06:31:00.000Z", hr: 131 },
    { t: "2026-10-14T06:32:00.000Z", hr: 137 },
  ],
};

const FIRST_BATCH: Workout[] = [
  workout("hk-run-1", "2026-10-14T06:30:00.000Z", 45, {
    totalDistanceM: 8_200,
    totalEnergyKcal: 610,
    avgHeartRate: 148,
    maxHeartRate: 171,
    samples: SERIES,
    route: TRACK,
    metadata: { HKIndoorWorkout: false },
  }),
  workout("manual:ride-1", "2026-10-13T16:00:00.000Z", 60, {
    sportType: "cycling",
    source: "MANUAL",
    totalDistanceM: 24_000,
  }),
  workout(undefined, "2026-10-12T18:00:00.000Z", 30, {
    sportType: "walking",
    source: "MANUAL",
  }),
  // The same session from the phone and from a hand entry.
  workout("hk-swim-1", "2026-10-11T07:00:00.000Z", 40, {
    sportType: "swimming",
    totalDistanceM: 1_500,
  }),
  workout("manual:swim-1", "2026-10-11T07:00:30.000Z", 40, {
    sportType: "swimming",
    source: "MANUAL",
    totalDistanceM: 1_500,
  }),
  // Refused per entry.
  workout("<HKWorkout: 0x600002f0c1e0>", "2026-10-10T07:00:00.000Z", 30),
  workout("hk-run-bad-series", "2026-10-09T07:00:00.000Z", 30, {
    samples: [{ t: "2026-10-09T07:00:00.000Z", hr: 999 }],
  }),
  workout("hk-run-2", "2026-10-08T07:00:00.000Z", 50),
];

let userId: string;
let session: RouteAuth;

async function state() {
  const workouts = await prisma.workout.findMany({
    where: { userId },
    orderBy: [{ startedAt: "asc" }, { source: "asc" }],
    select: {
      id: true,
      sportType: true,
      startedAt: true,
      endedAt: true,
      durationSec: true,
      totalEnergyKcal: true,
      totalDistanceM: true,
      avgHeartRate: true,
      maxHeartRate: true,
      minHeartRate: true,
      stepCount: true,
      elevationM: true,
      pauseDurationSec: true,
      source: true,
      externalId: true,
      externalSourceVersion: true,
      metadata: true,
      samples: { select: { samples: true, sampleCount: true } },
      route: {
        select: {
          geometry: true,
          geometryEncrypted: true,
          sampleTimestamps: true,
        },
      },
    },
  });
  return workouts.map(({ route, ...w }) => ({
    ...w,
    route: route
      ? {
          geometry: route.geometry,
          sealed: route.geometryEncrypted !== null,
          sampleTimestamps: route.sampleTimestamps,
        }
      : null,
  }));
}

async function step(
  name: string,
  body: unknown,
  auth: RouteAuth = session,
): Promise<void> {
  wideEventRecorder.take();
  effectRecorder.take();
  const res = await callRoute(POST, {
    method: "POST",
    route: "/api/workouts/batch",
    body,
    auth,
  });
  const events = wideEventRecorder.take();
  expect(events.length).toBeGreaterThan(0);
  // Arrivals are handed off without being awaited; let them reach the
  // recorder before the snapshot is taken.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expectParity(
    `workouts-batch.${name}`,
    stable(
      {
        status: res.status,
        body: res.body,
        events: events.map(eventFacts),
        effects: effectRecorder.take(),
        stored: await state(),
      },
      { since: NOW },
    ),
  );
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  const user = await makeUser({ timezone: "UTC" });
  userId = user.id;
  session = await makeSession(user);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("POST /api/workouts/batch parity", () => {
  it("01 a first batch", async () => {
    await step("01-first-batch", { workouts: FIRST_BATCH });
  });

  it("02 the same batch again, with a series for a stored workout", async () => {
    await step("02-same-batch-enrich", {
      workouts: [
        ...FIRST_BATCH.slice(0, -1),
        workout("hk-run-2", "2026-10-08T07:00:00.000Z", 50, {
          samples: SERIES,
        }),
      ],
    });
  });

  it("03 a corrected hand-entered workout", async () => {
    await step("03-manual-correction", {
      workouts: [
        workout("manual:ride-1", "2026-10-13T16:00:00.000Z", 65, {
          sportType: "cycling",
          source: "MANUAL",
          totalDistanceM: 2_400,
        }),
        workout("manual:ride-1", "2026-10-13T16:00:00.000Z", 65, {
          sportType: "cycling",
          source: "MANUAL",
          totalDistanceM: 2_500,
        }),
      ],
    });
  });

  it("04 a track kept once the account opts in", async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { storeWorkoutRoutes: true },
    });
    await step("04-route-kept", {
      workouts: [
        workout("hk-run-3", "2026-10-15T06:30:00.000Z", 45, { route: TRACK }),
      ],
    });
  });

  it("05 a batch over the workout limit", async () => {
    await step("05-too-large", {
      workouts: Array.from({ length: 101 }, (_, i) =>
        workout(`hk-bulk-${i}`, "2026-09-01T07:00:00.000Z", 30),
      ),
    });
  });

  it("06 a batch the schema refuses", async () => {
    await step("06-invalid", {
      workouts: [{ sportType: "running", startedAt: "yesterday" }],
    });
  });

  it("07 a bridge token naming a source, and one that does not", async () => {
    const bridge = await makeToken(
      { id: userId },
      { permissions: [WORKOUTS_WRITE_SCOPE] },
    );
    await step(
      "07a-bridge-with-source",
      { workouts: [workout("bridge-1", "2026-10-15T09:00:00.000Z", 20)] },
      bridge,
    );
    const { source: _source, ...unsourced } = workout(
      "bridge-1",
      "2026-10-15T09:00:00.000Z",
      20,
    );
    await step("07b-bridge", { workouts: [unsourced] }, bridge);
  });
});
