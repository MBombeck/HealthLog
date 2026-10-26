/**
 * Parity for `POST /api/measurements/batch` while its ingest moves into
 * `src/lib/measurements/batch-ingest/`.
 *
 * One account walks through the cases the route tells apart, in order, each
 * request seeing what the earlier ones stored: a first sync of mixed
 * entries (fresh samples, a day total, a heart-rate bucket with its spread,
 * sleep stages, hourly sums, and every per-entry refusal), the same sync
 * again, a re-computed day total from the background, a hand-entered
 * reading the phone also mirrored, a history catch-up, the two whole-batch
 * refusals, and a narrow bridge token with and without a `source`. After
 * each request the snapshot holds the response, the request's wide event,
 * the stored measurements and hourly profile, and the account's sync stamps.
 *
 * The clock is pinned (`Date` only), so the snapshot is the same on every
 * day it runs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/measurements/batch/route";
import { MEASUREMENTS_WRITE_SCOPE } from "@/lib/measurements/scopes";

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

// The queue and arrival tails the route hands work to, recorded instead of
// run (see `effectRecorder`).
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
vi.mock("@/lib/daily/morning-refresh-trigger", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/daily/morning-refresh-trigger")
    >();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    maybeEnqueueMorningRefresh: async (...args: unknown[]) => {
      effectRecorder.record("maybeEnqueueMorningRefresh", args);
    },
  };
});
vi.mock("@/lib/jobs/reminder-satisfy", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/jobs/reminder-satisfy")>();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    enqueueReminderSatisfy: async (...args: unknown[]) => {
      effectRecorder.record("enqueueReminderSatisfy", args);
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
const HR = "HKQuantityTypeIdentifierHeartRate";
const STEPS = "HKQuantityTypeIdentifierStepCount";
const MASS = "HKQuantityTypeIdentifierBodyMass";
const SPO2 = "HKQuantityTypeIdentifierOxygenSaturation";
const SLEEP = "HKCategoryTypeIdentifierSleepAnalysis";

type Entry = Record<string, unknown>;

function sample(
  hkIdentifier: string,
  externalId: string,
  at: string,
  value: number,
  unit: string,
  extra: Entry = {},
): Entry {
  return {
    hkIdentifier,
    value,
    unit,
    startDate: at,
    endDate: at,
    externalId,
    ...extra,
  };
}

function dayTotal(day: string, value: number, extra: Entry = {}): Entry {
  return {
    hkIdentifier: STEPS,
    value,
    unit: "count",
    startDate: `${day}T00:00:00.000Z`,
    endDate: `${day}T18:00:00.000Z`,
    externalId: `stats:${STEPS}:${day}`,
    ...extra,
  };
}

function hourSum(day: string, hour: number, value: number): Entry {
  const hh = String(hour).padStart(2, "0");
  const start = `${day}T${hh}:00:00.000Z`;
  return {
    hkIdentifier: STEPS,
    value,
    unit: "count",
    startDate: start,
    endDate: new Date(Date.parse(start) + 3_600_000).toISOString(),
    externalId: `stats:${STEPS}:${day}T${hh}`,
  };
}

function sleep(externalId: string, from: string, to: string, stage: number) {
  return {
    hkIdentifier: SLEEP,
    value: 0,
    unit: "min",
    startDate: from,
    endDate: to,
    externalId,
    sleepStage: stage,
  };
}

const FIRST_SYNC: Entry[] = [
  sample(MASS, "uuid-mass-1", "2026-10-14T06:30:00.000Z", 80.4, "kg", {
    deviceType: "scale",
  }),
  sample(HR, "uuid-hr-1", "2026-10-14T07:00:00.000Z", 62, "count/min", {
    deviceType: "watch",
  }),
  sample(HR, "uuid-hr-2", "2026-10-14T07:05:00.000Z", 64, "count/min"),
  sample(SPO2, "uuid-spo2-1", "2026-10-14T07:10:00.000Z", 0.97, "%"),
  dayTotal("2026-10-13", 8_400, { deviceType: "phone" }),
  dayTotal("2026-10-14", 5_100),
  sample(
    HR,
    `stats:${HR}:2026-10-14T08:10:00.000Z`,
    "2026-10-14T08:10:00.000Z",
    71,
    "count/min",
    { valueMin: 66, valueMax: 79 },
  ),
  // A spread that does not bracket the mean is dropped, the mean kept.
  sample(
    HR,
    `stats:${HR}:2026-10-14T08:20:00.000Z`,
    "2026-10-14T08:20:00.000Z",
    70,
    "count/min",
    { valueMin: 72, valueMax: 75 },
  ),
  sleep(
    "uuid-sleep-1",
    "2026-10-13T22:00:00.000Z",
    "2026-10-14T01:00:00.000Z",
    3,
  ),
  sleep(
    "uuid-sleep-2",
    "2026-10-14T01:00:00.000Z",
    "2026-10-14T02:30:00.000Z",
    4,
  ),
  hourSum("2026-10-14", 8, 900),
  hourSum("2026-10-14", 9, 1_300),
  // Refused per entry.
  sample(
    "HKQuantityTypeIdentifierNotAThing",
    "uuid-x-1",
    "2026-10-14T07:00:00.000Z",
    1,
    "count",
  ),
  sample(HR, "uuid-hr-range", "2026-10-14T07:15:00.000Z", 900, "count/min"),
  sample(HR, "uuid-hr-future", "2027-03-01T07:15:00.000Z", 61, "count/min"),
  sample(
    HR,
    `stats:${HR}:2026-10-14T08:13:00.000Z`,
    "2026-10-14T08:13:00.000Z",
    70,
    "count/min",
  ),
  sample(
    HR,
    "<HKQuantitySample: 0x600003a1c0c0>",
    "2026-10-14T07:20:00.000Z",
    63,
    "count/min",
  ),
  // The same sample twice in one batch, and a day total sent twice.
  sample(HR, "uuid-hr-twice", "2026-10-14T07:25:00.000Z", 65, "count/min"),
  sample(HR, "uuid-hr-twice", "2026-10-14T07:25:00.000Z", 65, "count/min"),
  dayTotal("2026-10-12", 7_000),
  dayTotal("2026-10-12", 7_250),
];

const MEASUREMENT_SELECT = {
  id: true,
  type: true,
  value: true,
  valueMin: true,
  valueMax: true,
  unit: true,
  source: true,
  measuredAt: true,
  externalId: true,
  externalSourceVersion: true,
  sleepStage: true,
  rhythmClassification: true,
  deviceType: true,
  aggregationProvenance: true,
  deletedAt: true,
} as const;

let userId: string;
let session: RouteAuth;

async function state() {
  const [measurements, hours, user, typeSync] = await Promise.all([
    prisma.measurement.findMany({
      where: { userId },
      select: MEASUREMENT_SELECT,
      orderBy: [
        { type: "asc" },
        { measuredAt: "asc" },
        { source: "asc" },
        { externalId: "asc" },
      ],
    }),
    prisma.intradayCumulativeProfile.findMany({
      where: { userId },
      orderBy: [{ type: "asc" }, { dateKey: "asc" }],
    }),
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        lastSyncedAt: true,
        healthKitLastSyncedAt: true,
        healthKitLastSyncTrigger: true,
        healthKitLastBackgroundSyncAt: true,
      },
    }),
    prisma.healthKitTypeSync.findMany({
      where: { userId },
      orderBy: { type: "asc" },
    }),
  ]);
  return { measurements, hours, user, typeSync };
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
    route: "/api/measurements/batch",
    body,
    auth,
  });
  const events = wideEventRecorder.take();
  expect(events.length).toBeGreaterThan(0);
  await expectParity(
    `measurements-batch.${name}`,
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

describe("POST /api/measurements/batch parity", () => {
  it("01 a first sync of mixed entries", async () => {
    await step("01-first-sync", {
      entries: FIRST_SYNC,
      syncTrigger: "foreground",
    });
  });

  it("02 the same sync again", async () => {
    await step("02-same-sync-again", {
      entries: FIRST_SYNC,
      syncTrigger: "foreground",
    });
  });

  it("03 a re-computed day total from the background", async () => {
    await step("03-background-day-total", {
      entries: [
        dayTotal("2026-10-14", 6_300),
        dayTotal("2026-10-13", 8_400, { deviceType: "phone" }),
        hourSum("2026-10-14", 9, 1_450),
      ],
      syncTrigger: "background",
    });
  });

  it("04 a hand-entered reading the phone also mirrored", async () => {
    await step("04-cross-source-merge", {
      entries: [
        sample(MASS, "manual-1", "2026-10-15T06:30:00.000Z", 80.1, "kg", {
          source: "MANUAL",
        }),
        sample(
          MASS,
          "uuid-mass-mirror",
          "2026-10-15T06:30:01.000Z",
          80.1,
          "kg",
        ),
      ],
    });
  });

  it("05 a history catch-up", async () => {
    await step("05-backfill", {
      entries: [
        sample(
          HR,
          "uuid-hr-old-1",
          "2026-09-01T07:00:00.000Z",
          58,
          "count/min",
        ),
        dayTotal("2026-09-01", 11_200),
      ],
      syncTrigger: "backfill",
    });
  });

  it("06 a batch over the entry limit", async () => {
    await step("06-too-large", {
      entries: Array.from({ length: 501 }, (_, i) =>
        sample(
          HR,
          `uuid-bulk-${i}`,
          "2026-10-14T10:00:00.000Z",
          60,
          "count/min",
        ),
      ),
    });
  });

  it("07 a batch the schema refuses", async () => {
    await step("07-invalid", {
      entries: [{ hkIdentifier: HR, value: "fast", unit: "count/min" }],
    });
  });

  it("08 a bridge token naming a source, and one that does not", async () => {
    const bridge = await makeToken(
      { id: userId },
      { permissions: [MEASUREMENTS_WRITE_SCOPE] },
    );
    await step(
      "08a-bridge-with-source",
      {
        entries: [
          sample(MASS, "bridge-1", "2026-10-15T07:00:00.000Z", 80.0, "kg", {
            source: "APPLE_HEALTH",
          }),
        ],
      },
      bridge,
    );
    await step(
      "08b-bridge",
      {
        entries: [
          sample(MASS, "bridge-1", "2026-10-15T07:00:00.000Z", 80.0, "kg"),
          hourSum("2026-10-15", 6, 400),
        ],
        syncTrigger: "foreground",
      },
      bridge,
    );
  });
});
