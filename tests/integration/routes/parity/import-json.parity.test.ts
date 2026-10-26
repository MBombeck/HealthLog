/**
 * Parity for `POST /api/import` while its writers move into
 * `src/lib/import/json/`.
 *
 * A first file of mixed rows (measurements with and without an external id,
 * with a note and a glucose context, an unstable id; mood entries with and
 * without a logged instant, a twin pair that has to land on two distinct
 * fallback instants, an external id, an unstable id), the same file again,
 * and the whole-file refusals. After each request the snapshot holds the
 * response, the wide event, the recorded arrival and refresh tails, and the
 * stored measurements, mood entries, rollups and audit rows.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/import/route";

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

vi.mock("@/lib/insights/status-invalidation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/insights/status-invalidation")>();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    // Detached from the request but inside its context: run for real, its
    // annotate can land on the request's wide event or miss it, depending on
    // timing. Recorded instead, like the other tails.
    invalidateStatusInsightsForTypes: async (...args: unknown[]) => {
      effectRecorder.record("invalidateStatusInsightsForTypes", args);
    },
  };
});

const prisma = getPrismaClient();
const NOW = new Date("2026-10-15T12:00:00.000Z");

let userId: string;
let owner: RouteAuth;

async function stored() {
  const [measurements, mood, measurementRollups, moodRollups, audit] =
    await Promise.all([
      prisma.measurement.findMany({
        where: { userId },
        orderBy: [{ measuredAt: "asc" }, { type: "asc" }, { value: "asc" }],
        select: {
          type: true,
          value: true,
          unit: true,
          source: true,
          externalId: true,
          measuredAt: true,
          notes: true,
          notesEncrypted: true,
          glucoseContext: true,
        },
      }),
      prisma.moodEntry.findMany({
        where: { userId },
        orderBy: [{ moodLoggedAt: "asc" }, { mood: "asc" }],
        select: {
          date: true,
          mood: true,
          score: true,
          moodA1: true,
          tags: true,
          source: true,
          externalId: true,
          moodLoggedAt: true,
        },
      }),
      prisma.measurementRollup.findMany({
        where: { userId },
        orderBy: [
          { type: "asc" },
          { granularity: "asc" },
          { bucketStart: "asc" },
        ],
        select: {
          type: true,
          granularity: true,
          bucketStart: true,
          source: true,
          count: true,
          mean: true,
        },
      }),
      prisma.moodEntryRollup.findMany({
        where: { userId },
        orderBy: [{ granularity: "asc" }, { bucketStart: "asc" }],
        select: {
          granularity: true,
          bucketStart: true,
          count: true,
          mean: true,
        },
      }),
      prisma.auditLog.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: { action: true, details: true },
      }),
    ]);
  return { measurements, mood, measurementRollups, moodRollups, audit };
}

async function step(name: string, body: unknown): Promise<void> {
  wideEventRecorder.take();
  effectRecorder.take();
  const res = await callRoute(POST, {
    method: "POST",
    route: "/api/import",
    body,
    auth: owner,
  });
  const events = wideEventRecorder.take();
  expect(events.length).toBeGreaterThan(0);
  await expectParity(
    `import-json.${name}`,
    stable(
      {
        status: res.status,
        body: res.body,
        events: events.map(eventFacts),
        effects: effectRecorder.take(),
        stored: await stored(),
      },
      { since: NOW },
    ),
  );
}

const FILE = {
  measurements: [
    {
      type: "WEIGHT",
      value: 81.4,
      unit: "kg",
      measuredAt: "2026-10-10T06:30:00.000Z",
      notes: "after the run",
      externalId: "exp-w-1",
    },
    {
      type: "WEIGHT",
      value: 81.9,
      unit: "kg",
      measuredAt: "2026-10-11T06:30:00.000Z",
    },
    {
      type: "BLOOD_GLUCOSE",
      value: 104,
      unit: "mg/dL",
      measuredAt: "2026-10-11T08:00:00.000Z",
      glucoseContext: "FASTING",
      externalId: "exp-g-1",
    },
    {
      type: "SLEEP_DURATION",
      value: 412,
      unit: "min",
      measuredAt: "2026-10-12T06:00:00.000Z",
      externalId: "exp-s-1",
    },
    {
      type: "PULSE",
      value: 64,
      unit: "bpm",
      measuredAt: "2026-10-12T07:00:00.000Z",
      externalId: "<HKQuantitySample: 0x600001b4c2a0>",
    },
  ],
  moodEntries: [
    {
      date: "2026-10-10",
      mood: "GUT",
      score: 4,
      tags: "slept well",
      loggedAt: "2026-10-10T07:00:00.000Z",
      externalId: "daylio-1",
    },
    { date: "2026-10-11", mood: "OKAY", score: 3 },
    { date: "2026-10-11", mood: "OKAY", score: 3 },
    {
      date: "2026-10-12",
      mood: "SCHLECHT",
      score: 2,
      loggedAt: "2026-10-12T20:00:00.000Z",
    },
    {
      date: "2026-10-13",
      mood: "GUT",
      score: 5,
      externalId: "<MoodEntry: 0x600001b4c2a0>",
    },
  ],
};

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  const user = await makeUser({ timezone: "Europe/Berlin" });
  userId = user.id;
  owner = await makeSession(user);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("POST /api/import parity", () => {
  it("01 a first file", async () => {
    await step("01-first-file", FILE);
  });

  it("02 the same file again", async () => {
    await step("02-same-file", FILE);
  });

  it("03 the whole-file refusals", async () => {
    await step("03-out-of-range", {
      measurements: [
        {
          type: "WEIGHT",
          value: 4_000,
          unit: "kg",
          measuredAt: "2026-10-10T06:30:00.000Z",
        },
      ],
    });
    await step("04-forward-dated", {
      moodEntries: [
        {
          date: "2026-10-20",
          mood: "GUT",
          score: 4,
          loggedAt: "2026-10-20T07:00:00.000Z",
        },
      ],
    });
  });
});
