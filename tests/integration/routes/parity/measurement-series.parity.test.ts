/**
 * Parity for `GET /api/measurements/series` while its readers move into
 * `src/lib/measurements/series/`.
 *
 * One account holds weight, blood pressure from two sources (with a corrupt
 * systolic row), pulse with hourly spreads, a stream of per-minute pulse
 * dense enough to be bucketed per hour, glucose in mmol/L preference, sleep
 * stages and steps. The walk asks for each kind it reads differently: the
 * plain readers, the paired blood pressure, the sleep nights, a dense kind
 * inside the raw window, the hour buckets, the day buckets of a long window,
 * a refused query, and a delegate reading the record in another language.
 *
 * The clock is NOT pinned here: the series readers cut their windows in SQL
 * against the database's own `now()`, which a pinned `Date` would disagree
 * with. The record is laid out relative to the start of the current UTC day
 * instead, no reading sits on a window's edge day, and every instant and day
 * key in the snapshot is written relative to that start, so the snapshot is
 * the same on every day it runs.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/measurements/series/route";
import type { Prisma } from "@/generated/prisma/client";

import { callRoute, type RouteAuth } from "../../../kit/call-route";
import { makeGrant, makeSession, makeUser } from "../../../kit/factories";
import {
  eventFacts,
  expectParity,
  relativeToAnchor,
  stable,
  startOfUtcToday,
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

const prisma = getPrismaClient();
const DAY = 86_400_000;
/** The start of the current UTC day: the anchor the record is laid out from. */
const ANCHOR = startOfUtcToday();
/**
 * Days back the daily readings sit. The windows asked for are 7, 14, 30 and
 * 365 days; a reading on exactly that many days back would fall in or out of
 * the window with the time of day the test runs, so those days are skipped.
 */
const READING_DAYS = Array.from({ length: 20 }, (_, i) => i + 1).filter(
  (d) => d !== 7 && d !== 14,
);

let userId: string;
let owner: RouteAuth;
let delegate: { auth: RouteAuth & { sessionId: string } };

function at(daysAgo: number, hour: number, minute = 0): Date {
  return new Date(
    ANCHOR.getTime() - daysAgo * DAY + (hour * 60 + minute) * 60_000,
  );
}

function seedRows(): Prisma.MeasurementCreateManyInput[] {
  const rows: Prisma.MeasurementCreateManyInput[] = [];
  const add = (row: Omit<Prisma.MeasurementCreateManyInput, "userId">) =>
    rows.push({ userId, ...row });
  for (const d of READING_DAYS) {
    add({
      type: "WEIGHT",
      value: 80 - d * 0.1,
      unit: "kg",
      measuredAt: at(d, 6, 30),
      source: d % 2 ? "MANUAL" : "WITHINGS",
      externalId: d % 2 ? null : `w-${d}`,
    });
    for (const [source, offset] of [
      ["MANUAL", 0],
      ["WITHINGS", 1],
    ] as const) {
      add({
        type: "BLOOD_PRESSURE_SYS",
        value: 125 + (d % 5) + offset,
        unit: "mmHg",
        measuredAt: at(d, 7, offset),
        source,
        externalId: source === "WITHINGS" ? `bp-s-${d}` : null,
      });
      add({
        type: "BLOOD_PRESSURE_DIA",
        value: 80 + (d % 3) + offset,
        unit: "mmHg",
        measuredAt: at(d, 7, offset + 2),
        source,
        externalId: source === "WITHINGS" ? `bp-d-${d}` : null,
      });
    }
    add({
      type: "BLOOD_GLUCOSE",
      value: 95 + d,
      unit: "mg/dL",
      measuredAt: at(d, 8),
      source: "MANUAL",
    });
    add({
      type: "ACTIVITY_STEPS",
      value: 6_000 + d * 100,
      unit: "steps",
      measuredAt: at(d, 12),
      source: "APPLE_HEALTH",
      externalId: `stats:steps:${d}`,
      aggregationProvenance: "HEALTHKIT_STATISTICS",
    });
    for (const [stage, start, minutes] of [
      ["CORE", 23, 180],
      ["DEEP", 2, 60],
      ["REM", 3, 90],
      ["AWAKE", 4, 10],
    ] as const) {
      const begin = at(d, start);
      if (start === 23) begin.setTime(begin.getTime() - DAY);
      add({
        type: "SLEEP_DURATION",
        value: minutes,
        unit: "min",
        measuredAt: new Date(begin.getTime() + minutes * 60_000),
        source: "APPLE_HEALTH",
        sleepStage: stage,
        externalId: `sleep-${d}-${stage}`,
      });
    }
    for (const hour of [9, 14, 20]) {
      add({
        type: "PULSE",
        value: 60 + hour,
        valueMin: 55 + hour,
        valueMax: 70 + hour,
        unit: "bpm",
        measuredAt: at(d, hour),
        source: "APPLE_HEALTH",
        externalId: `stats:hr:${d}:${hour}`,
        aggregationProvenance: "HEALTHKIT_STATISTICS",
      });
    }
  }
  // A seed-era corrupt systolic the series must never surface.
  add({
    type: "BLOOD_PRESSURE_SYS",
    value: 0,
    unit: "mmHg",
    measuredAt: at(2, 9),
    source: "MANUAL",
  });
  // Two months back, so a long window has more than the raw window holds.
  for (let d = 60; d <= 70; d++) {
    add({
      type: "BLOOD_GLUCOSE",
      value: 110,
      unit: "mg/dL",
      measuredAt: at(d, 8),
      source: "MANUAL",
    });
  }
  return rows;
}

/** A per-minute heart-rate stream dense enough to be bucketed per hour. */
function denseHeartRate(): Prisma.MeasurementCreateManyInput[] {
  return Array.from({ length: 10_200 }, (_, i) => ({
    userId,
    type: "HEART_RATE_VARIABILITY",
    value: 40 + (i % 17),
    unit: "ms",
    measuredAt: new Date(ANCHOR.getTime() - (i + 1) * 60_000),
    source: "APPLE_HEALTH",
    externalId: `hrv-${i}`,
  }));
}

async function step(
  name: string,
  query: Record<string, string | number>,
  auth: RouteAuth = owner,
): Promise<void> {
  wideEventRecorder.take();
  const res = await callRoute(GET, {
    method: "GET",
    route: "/api/measurements/series",
    query,
    auth,
  });
  const events = wideEventRecorder.take();
  expect(events.length).toBeGreaterThan(0);
  await expectParity(
    `measurement-series.${name}`,
    stable(
      relativeToAnchor(
        {
          status: res.status,
          body: res.body,
          events: events.map(eventFacts),
        },
        ANCHOR,
      ),
      { since: new Date() },
    ),
  );
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  const user = await makeUser({
    // UTC, so a daylight-saving change between two runs cannot move a local
    // day boundary relative to the anchor.
    timezone: "UTC",
    glucoseUnit: "mmol/L",
    dateOfBirth: new Date("1970-01-01T00:00:00.000Z"),
    locale: "en",
  });
  userId = user.id;
  owner = await makeSession(user);
  await prisma.measurement.createMany({ data: seedRows() });
  await prisma.measurement.createMany({ data: denseHeartRate() });
  const reader = await makeUser({ timezone: "UTC", locale: "de" });
  await makeGrant(user, reader);
  const session = await makeSession(reader);
  delegate = { auth: session };
});

describe("GET /api/measurements/series parity", () => {
  it("the plain readers", async () => {
    await step("01-weight", { kind: "weight" });
    await step("02-steps", { kind: "steps", days: 14 });
    await step("03-pulse-spread", { kind: "pulse", days: 7 });
  });

  it("the paired blood pressure and the sleep nights", async () => {
    await step("04-blood-pressure", { kind: "bloodPressure" });
    await step("05-sleep", { kind: "sleep", days: 14 });
  });

  it("glucose raw, and day-bucketed past the raw window", async () => {
    await step("06-glucose-raw", { kind: "glucose" });
    await step("07-glucose-long", { kind: "glucose", days: 365 });
  });

  it("a dense stream bucketed per hour", async () => {
    await step("08-hrv-hour-buckets", {
      kind: "heartRateVariability",
      days: 30,
    });
  });

  it("a refused query", async () => {
    await step("09-invalid", { kind: "temperature", days: 0 });
  });

  it("a delegate reading the record in another language", async () => {
    await switchSessionTo(delegate.auth.sessionId, userId);
    await step(
      "10-delegated",
      { kind: "bloodPressure", days: 7 },
      delegate.auth,
    );
    await switchSessionTo(delegate.auth.sessionId, null);
  });
});
