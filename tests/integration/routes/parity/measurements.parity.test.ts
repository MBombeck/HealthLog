/**
 * Parity for `GET` and `POST /api/measurements` while their logic moves into
 * `src/lib/measurements/`.
 *
 * The POST walk covers each arm the handler tells apart: a single reading,
 * its duplicate, a refused one; a combined two-value reading, its duplicate,
 * a refused one; a named sleep-stage segment, its re-post and its mirror
 * from the other source; a narrow bridge token with and without a `source`;
 * and a delegate writing into a record shared with them. The GET walk then
 * reads the stored rows back through every list mode: the plain page with
 * filters, the sleep list, the cumulative day drill-down, the day-grouped
 * list, the rollup series, a live aggregate, and a refused query.
 *
 * After each request the snapshot holds the response, the wide event, the
 * fire-and-forget tails the route handed work to, and (for writes) the
 * account's stored measurements, a sealed note as its presence.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/measurements/route";
import { MEASUREMENTS_WRITE_SCOPE } from "@/lib/measurements/scopes";

import { callRoute, type RouteAuth } from "../../../kit/call-route";
import {
  makeGrant,
  makeSession,
  makeToken,
  makeUser,
} from "../../../kit/factories";
import {
  effectRecorder,
  eventFacts,
  expectParity,
  stable,
  wideEventRecorder,
} from "../../../kit/parity";
import {
  getPrismaClient,
  switchSessionTo,
  truncateAllTables,
} from "../../setup";

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
vi.mock("@/lib/arrivals/measurement-emit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/arrivals/measurement-emit")>();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    emitInsertedMeasurementArrivals: async (...args: unknown[]) => {
      effectRecorder.record("emitInsertedMeasurementArrivals", args);
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
vi.mock("@/lib/insights/status-invalidation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/insights/status-invalidation")>();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    invalidateStatusInsightsForTypes: async (...args: unknown[]) => {
      effectRecorder.record("invalidateStatusInsightsForTypes", args);
    },
  };
});
vi.mock("@/lib/illness/safety-floor-check", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/illness/safety-floor-check")>();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    runSafetyFloorCheck: async (...args: unknown[]) => {
      effectRecorder.record("runSafetyFloorCheck", args);
    },
  };
});

const prisma = getPrismaClient();
const NOW = new Date("2026-10-15T12:00:00.000Z");
const STEPS = "HKQuantityTypeIdentifierStepCount";

let ownerId: string;
let owner: RouteAuth;

async function stored(userId: string) {
  const rows = await prisma.measurement.findMany({
    where: { userId },
    orderBy: [
      { type: "asc" },
      { measuredAt: "asc" },
      { source: "asc" },
      { externalId: "asc" },
    ],
    select: {
      id: true,
      type: true,
      value: true,
      unit: true,
      source: true,
      measuredAt: true,
      notes: true,
      notesEncrypted: true,
      glucoseContext: true,
      deviceType: true,
      externalId: true,
      sleepStage: true,
      deletedAt: true,
    },
  });
  return rows.map(({ notesEncrypted, ...row }) => ({
    ...row,
    sealedNote: notesEncrypted !== null,
  }));
}

async function step(
  name: string,
  call: {
    handler: typeof GET | typeof POST;
    method: "GET" | "POST";
    body?: unknown;
    query?: Record<string, string | number>;
    auth?: RouteAuth;
    readBack?: string;
    contract?: { skip: string };
  },
): Promise<void> {
  wideEventRecorder.take();
  effectRecorder.take();
  const res = await callRoute(call.handler, {
    method: call.method,
    route: "/api/measurements",
    body: call.body,
    query: call.query,
    auth: call.auth ?? owner,
    contract: call.contract,
  });
  const events = wideEventRecorder.take();
  expect(events.length).toBeGreaterThan(0);
  // The tails are handed off without being awaited; let them reach the
  // recorder before the snapshot is taken.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expectParity(
    `measurements.${name}`,
    stable(
      {
        status: res.status,
        body: res.body,
        events: events.map(eventFacts),
        effects: effectRecorder.take(),
        ...(call.readBack ? { stored: await stored(call.readBack) } : {}),
      },
      { since: NOW },
    ),
  );
}

const post = (
  name: string,
  body: unknown,
  auth?: RouteAuth,
  readBack?: string,
) =>
  step(name, {
    handler: POST,
    method: "POST",
    body,
    auth,
    readBack: readBack ?? ownerId,
  });
const get = (
  name: string,
  query: Record<string, string | number>,
  contract?: { skip: string },
) => step(name, { handler: GET, method: "GET", query, contract });

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  const user = await makeUser({ timezone: "UTC" });
  ownerId = user.id;
  owner = await makeSession(user);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("POST /api/measurements parity", () => {
  it("a single reading, its duplicate, a refused one", async () => {
    const weight = {
      type: "WEIGHT",
      value: 80.4,
      measuredAt: "2026-10-14T06:30:00.000Z",
      notes: "after the run",
      deviceType: "scale",
    };
    await post("post-01-single", weight);
    await post("post-02-single-duplicate", weight);
    await post("post-03-single-invalid", {
      type: "WEIGHT",
      value: "heavy",
      measuredAt: "2026-10-14T06:30:00.000Z",
    });
    await post("post-04-single-glucose", {
      type: "BLOOD_GLUCOSE",
      value: 104,
      measuredAt: "2026-10-14T07:00:00.000Z",
      glucoseContext: "FASTING",
      symptomsPresent: false,
    });
  });

  it("a combined two-value reading, its duplicate, a refused one", async () => {
    const reading = [
      {
        type: "BLOOD_PRESSURE_SYS",
        value: 128,
        measuredAt: "2026-10-14T08:00:00.000Z",
      },
      {
        type: "BLOOD_PRESSURE_DIA",
        value: 82,
        measuredAt: "2026-10-14T08:00:00.000Z",
      },
      {
        type: "PULSE",
        value: 66,
        measuredAt: "2026-10-14T08:00:00.000Z",
        notes: "seated",
        symptomsPresent: true,
      },
    ];
    await post("post-05-batch", reading);
    await post("post-06-batch-duplicate", reading);
    await post("post-07-batch-invalid", [{ type: "PULSE", value: -1 }]);
  });

  it("a named sleep-stage segment, its re-post and its mirror", async () => {
    const segment = {
      type: "SLEEP_DURATION",
      sleepStage: "DEEP",
      startDate: "2026-10-14T01:00:00.000Z",
      endDate: "2026-10-14T02:30:00.000Z",
      externalId: "bridge-sleep-1",
    };
    await post("post-08-sleep-stage", segment);
    await post("post-09-sleep-stage-again", segment);
    await post("post-10-sleep-stage-mirror", {
      ...segment,
      externalId: "hk-sleep-1",
      source: "APPLE_HEALTH",
    });
    await post("post-11-sleep-stage-invalid", {
      type: "SLEEP_DURATION",
      sleepStage: "DEEP",
    });
  });

  it("a narrow bridge token with and without a source", async () => {
    const bridge = await makeToken(
      { id: ownerId },
      { permissions: [MEASUREMENTS_WRITE_SCOPE] },
    );
    await post(
      "post-12-bridge-with-source",
      {
        type: "WEIGHT",
        value: 80.1,
        measuredAt: "2026-10-15T06:30:00.000Z",
        source: "MANUAL",
      },
      bridge,
    );
    await post(
      "post-13-bridge",
      {
        type: "WEIGHT",
        value: 80.1,
        measuredAt: "2026-10-15T06:30:00.000Z",
      },
      bridge,
    );
  });

  it("a delegate writing into a shared record", async () => {
    const delegateUser = await makeUser({ timezone: "UTC" });
    await makeGrant({ id: ownerId }, delegateUser, { access: "WRITE" });
    const delegate = await makeSession(delegateUser);
    await switchSessionTo(delegate.sessionId, ownerId);
    await post(
      "post-14-delegated",
      {
        type: "PULSE",
        value: 71,
        measuredAt: "2026-10-15T07:00:00.000Z",
      },
      delegate,
    );
    await switchSessionTo(delegate.sessionId, null);
  });
});

describe("GET /api/measurements parity", () => {
  beforeAll(async () => {
    // Day totals for the cumulative list modes, from the phone.
    for (const [day, value] of [
      ["2026-10-12", 7_100],
      ["2026-10-13", 8_400],
      ["2026-10-14", 5_100],
    ] as const) {
      await prisma.measurement.create({
        data: {
          userId: ownerId,
          type: "ACTIVITY_STEPS",
          value,
          unit: "steps",
          source: "APPLE_HEALTH",
          measuredAt: new Date(`${day}T12:00:00.000Z`),
          externalId: `stats:${STEPS}:${day}`,
          aggregationProvenance: "HEALTHKIT_STATISTICS",
        },
      });
    }
  });

  it("the plain page and its filters", async () => {
    await get("get-01-page", { limit: 50 });
    await get("get-02-type-sorted", {
      type: "PULSE",
      sortBy: "value",
      sortDir: "asc",
    });
    await get("get-03-filtered", {
      sourceEq: "MANUAL",
      valueMin: 70,
      valueMax: 130,
      from: "2026-10-14T00:00:00.000Z",
      to: "2026-10-15T23:59:59.000Z",
      limit: 2,
      offset: 1,
    });
  });

  it("the list modes", async () => {
    await get("get-04-sleep", { type: "SLEEP_DURATION" });
    await get("get-05-drill-down", {
      type: "ACTIVITY_STEPS",
      dayKey: "2026-10-13",
    });
    await get("get-06-day-grouped", { type: "ACTIVITY_STEPS", groupBy: "day" });
    await get("get-07-rollup-series", {
      type: "ACTIVITY_STEPS",
      source: "rollup",
      aggregate: "daily",
      from: "2026-10-10T00:00:00.000Z",
      to: "2026-10-15T23:59:59.000Z",
    });
    await get("get-08-live-aggregate", {
      type: "PULSE",
      aggregate: "weekly",
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-10-15T23:59:59.000Z",
    });
  });

  it("a refused query", async () => {
    await get("get-09-invalid", { limit: 0, sortDir: "sideways" });
  });
});
