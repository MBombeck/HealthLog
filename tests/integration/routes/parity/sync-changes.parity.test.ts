/**
 * Parity for `GET /api/sync/changes` while its domain pages move into
 * `src/lib/sync/`.
 *
 * One account holds live and deleted rows in all five domains (a sealed note
 * on a measurement and a mood entry, a mood context, a recorded and an
 * auto-recorded intake, cycle days and cycles), plus a raw sample that a live
 * hourly row folded away. The walk drains the feed in small pages to the
 * end, pulls once caught up, then asks with a cursor past retention, a
 * cursor from before a reset, the cycle module switched off, and a refused
 * query. Every row carries a fixed id and `updatedAt`, so the keyset order
 * and the opaque cursor are the same on every run.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/sync/changes/route";
import { encryptNote } from "@/lib/crypto/note-cipher";
import { encodeCursor } from "@/lib/sync/cursor";

import { callRoute, type RouteAuth } from "../../../kit/call-route";
import { makeMedication, makeSession, makeUser } from "../../../kit/factories";
import {
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

const prisma = getPrismaClient();
const NOW = new Date("2026-10-15T12:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;

let userId: string;
let owner: RouteAuth;

/** An `updatedAt` some minutes before the clock, one per row. */
function touched(minutesAgo: number): Date {
  return new Date(NOW.getTime() - minutesAgo * MIN);
}

async function seed(): Promise<void> {
  const deletedAt = touched(30);
  await prisma.measurement.createMany({
    data: [
      {
        id: "m-01",
        userId,
        type: "WEIGHT",
        value: 81.2,
        unit: "kg",
        measuredAt: new Date("2026-10-14T06:30:00.000Z"),
        source: "MANUAL",
        notesEncrypted: encryptNote("after the run"),
        updatedAt: touched(300),
      },
      {
        id: "m-02",
        userId,
        type: "PULSE",
        value: 61,
        unit: "bpm",
        measuredAt: new Date("2026-10-14T07:00:00.000Z"),
        source: "WITHINGS",
        externalId: "w-pulse-1",
        updatedAt: touched(290),
      },
      {
        id: "m-03",
        userId,
        type: "WEIGHT",
        value: 81.6,
        unit: "kg",
        measuredAt: new Date("2026-10-13T06:30:00.000Z"),
        source: "WITHINGS",
        externalId: "w-weight-2",
        deletedAt,
        updatedAt: touched(280),
      },
      // The hourly row and a raw sample it folded away, four months back:
      // the sample's tombstone is the fold's, not a deletion anyone made.
      {
        id: "m-04",
        userId,
        type: "PULSE",
        value: 64,
        unit: "bpm",
        measuredAt: new Date("2026-06-17T09:30:00.000Z"),
        source: "APPLE_HEALTH",
        externalId: "stats:HKQuantityTypeIdentifierHeartRate:2026-06-17T09",
        updatedAt: touched(270),
      },
      {
        id: "m-05",
        userId,
        type: "PULSE",
        value: 66,
        unit: "bpm",
        measuredAt: new Date("2026-06-17T09:12:00.000Z"),
        source: "APPLE_HEALTH",
        externalId: "uuid-raw-pulse-1",
        deletedAt: touched(260),
        updatedAt: touched(260),
      },
      {
        id: "m-06",
        userId,
        type: "BLOOD_PRESSURE_SYS",
        value: 128,
        unit: "mmHg",
        measuredAt: new Date("2026-10-14T08:00:00.000Z"),
        source: "MANUAL",
        updatedAt: touched(250),
      },
    ],
  });
  await prisma.moodEntry.createMany({
    data: [
      {
        id: "mood-01",
        userId,
        date: "2026-10-14",
        tz: "Europe/Berlin",
        mood: "GUT",
        score: 4,
        moodA1: 7,
        stressA2: 3,
        tags: JSON.stringify(["slept well"]),
        noteEncrypted: encryptNote("a calm morning"),
        moodLoggedAt: new Date("2026-10-14T07:00:00.000Z"),
        source: "MANUAL",
        updatedAt: touched(240),
      },
      {
        id: "mood-02",
        userId,
        date: "2026-10-13",
        tz: "Europe/Berlin",
        mood: "SCHLECHT",
        score: 2,
        moodA1: 3,
        moodLoggedAt: new Date("2026-10-13T20:00:00.000Z"),
        source: "MANUAL",
        deletedAt,
        updatedAt: touched(230),
      },
    ],
  });
  await prisma.moodContext.create({
    data: {
      moodEntryId: "mood-01",
      userId,
      workStatus: "regular",
      workMinutes: 480,
    },
  });
  const medication = await makeMedication({ id: userId });
  await prisma.medicationIntakeEvent.createMany({
    data: [
      {
        id: "in-01",
        userId,
        medicationId: medication.id,
        scheduledFor: new Date("2026-10-14T06:00:00.000Z"),
        takenAt: new Date("2026-10-14T06:10:00.000Z"),
        source: "WEB",
        updatedAt: touched(220),
      },
      {
        id: "in-02",
        userId,
        medicationId: medication.id,
        scheduledFor: new Date("2026-10-13T06:00:00.000Z"),
        takenAt: new Date("2026-10-13T06:00:00.000Z"),
        autoRecorded: true,
        source: "WEB",
        updatedAt: touched(210),
      },
      {
        id: "in-03",
        userId,
        medicationId: medication.id,
        scheduledFor: new Date("2026-10-12T06:00:00.000Z"),
        skipped: true,
        source: "WEB",
        deletedAt,
        updatedAt: touched(200),
      },
    ],
  });
  await prisma.menstrualCycle.createMany({
    data: [
      {
        id: "cy-01",
        userId,
        startDate: "2026-09-12",
        endDate: "2026-10-09",
        lengthDays: 28,
        periodEndDate: "2026-09-16",
        updatedAt: touched(190),
      },
      {
        id: "cy-02",
        userId,
        startDate: "2026-10-10",
        updatedAt: touched(180),
      },
      {
        id: "cy-03",
        userId,
        startDate: "2026-08-01",
        deletedAt,
        updatedAt: touched(170),
      },
    ],
  });
  await prisma.cycleDayLog.createMany({
    data: [
      {
        id: "cd-01",
        userId,
        date: "2026-10-10",
        cycleId: "cy-02",
        flow: "MEDIUM",
        updatedAt: touched(160),
      },
      {
        id: "cd-02",
        userId,
        date: "2026-10-11",
        cycleId: "cy-02",
        flow: "LIGHT",
        basalBodyTempC: 36.4,
        externalId: "hk-cycle-1",
        updatedAt: touched(150),
      },
      {
        id: "cd-03",
        userId,
        date: "2026-10-09",
        externalId: "hk-cycle-0",
        deletedAt,
        updatedAt: touched(140),
      },
    ],
  });
}

type Feed = { cursor: string | null; hasMore: boolean };

async function pull(
  name: string,
  query: Record<string, string | number>,
): Promise<Feed> {
  wideEventRecorder.take();
  const res = await callRoute<Feed>(GET, {
    method: "GET",
    route: "/api/sync/changes",
    query,
    auth: owner,
  });
  const events = wideEventRecorder.take();
  expect(events.length).toBeGreaterThan(0);
  await expectParity(
    `sync-changes.${name}`,
    stable(
      { status: res.status, body: res.body, events: events.map(eventFacts) },
      { since: NOW },
    ),
  );
  return res.data;
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  const user = await makeUser({ gender: "FEMALE", timezone: "UTC" });
  userId = user.id;
  owner = await makeSession(user);
  await prisma.cycleProfile.create({ data: { userId } });
  await seed();
});

afterAll(() => {
  vi.useRealTimers();
});

describe("GET /api/sync/changes parity", () => {
  let firstCursor: string;

  it("drains the feed in small pages to the end", async () => {
    const first = await pull("01-first-page", { limit: 2 });
    expect(first.hasMore).toBe(true);
    firstCursor = first.cursor!;
    const second = await pull("02-second-page", {
      limit: 2,
      cursor: first.cursor!,
    });
    const rest = await pull("03-the-rest", {
      limit: 500,
      cursor: second.cursor!,
    });
    expect(rest.hasMore).toBe(false);
    await pull("04-caught-up", { cursor: rest.cursor! });
  });

  it("a cursor past retention, and one from before a reset", async () => {
    await pull("05-past-retention", {
      cursor: encodeCursor(
        {
          measurements: { updatedAtMs: NOW.getTime() - 200 * DAY, id: "m-01" },
        },
        NOW.getTime(),
      ),
    });
    await prisma.user.update({
      where: { id: userId },
      data: { syncResetAt: new Date(NOW.getTime() + MIN) },
    });
    await pull("06-before-reset", { cursor: firstCursor });
    await prisma.user.update({
      where: { id: userId },
      data: { syncResetAt: null },
    });
  });

  it("the cycle module switched off", async () => {
    await prisma.cycleProfile.update({
      where: { userId },
      data: { cycleTrackingEnabled: false },
    });
    await pull("07-cycle-off", { limit: 500 });
    await prisma.cycleProfile.update({
      where: { userId },
      data: { cycleTrackingEnabled: null },
    });
  });

  it("a refused query", async () => {
    await pull("08-invalid", { limit: 0 });
  });
});
