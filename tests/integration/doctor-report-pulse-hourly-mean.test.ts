/**
 * The doctor report's pulse figures use the hourly-mean day: a day is the mean
 * of its local hours' means and the period average is the mean of its days,
 * on both the raw path (a short window) and the day-bucket path (a long one).
 *
 * The account sits in Asia/Kolkata (UTC+05:30), so a local hour starts at half
 * past a UTC hour. The workout runs 04:45Z to 05:14:30Z: one local hour
 * (10:15 to 10:44:30), two UTC hours.
 *
 *   day one  60 readings at 150 in local 10:xx, one at 60 in local 12, 14, 16
 *            hours' means 150, 60, 60, 60, day value 82.5
 *            (plain mean 145.7; UTC hours would give 96)
 *   day two  one reading at 60, day value 60
 *   period   (82.5 + 60) / 2 = 71.25 (plain mean over readings 144.375)
 *
 * Count, min and max stay over every reading.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { collectDoctorReportData } from "@/lib/doctor-report-data";
import { selectionFromLeaves } from "@/lib/report-selection/selection";

import { getPrismaClient, truncateAllTables } from "./setup";

const MODULES = {
  cycle: false,
  mood: false,
  sleep: false,
  glucose: false,
  workouts: false,
  recovery: false,
  labs: false,
  illness: false,
  achievements: true,
  coach: true,
  insights: true,
  medications: true,
  doctorReport: true,
  environment: true,
  mcp: true,
  inboundDocuments: true,
  mentalHealth: true,
  nutrients: true,
  vaccinations: true,
  timeline: true,
} as const;

const SELECTION = selectionFromLeaves(["PULSE"]);
const END = new Date("2026-05-01T00:00:00.000Z");
const LONG = {
  start: new Date("2026-01-01T00:00:00.000Z"),
  end: END,
  days: 120,
};
const SHORT = {
  start: new Date("2026-02-15T00:00:00.000Z"),
  end: END,
  days: 75,
};

let userId = "";

beforeAll(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  const user = await prisma.user.create({
    data: {
      username: "doctor-report-pulse-hourly",
      email: "doctor-report-pulse-hourly@example.test",
      timezone: "Asia/Kolkata",
    },
  });
  userId = user.id;
  const rows: Prisma.MeasurementCreateManyInput[] = [];
  const add = (iso: string, value: number) =>
    rows.push({
      userId,
      type: "PULSE",
      value,
      unit: "bpm",
      source: "APPLE_HEALTH",
      measuredAt: new Date(iso),
    });
  const workoutStart = Date.parse("2026-03-10T04:45:00.000Z");
  for (let i = 0; i < 60; i += 1) {
    add(new Date(workoutStart + i * 30_000).toISOString(), 150);
  }
  add("2026-03-10T06:30:00.000Z", 60);
  add("2026-03-10T08:30:00.000Z", 60);
  add("2026-03-10T10:30:00.000Z", 60);
  add("2026-03-11T03:30:00.000Z", 60);
  await prisma.measurement.createMany({ data: rows });
}, 120_000);

describe.each([
  ["day-bucket path (long window)", LONG],
  ["raw path (short window)", SHORT],
] as const)("doctor report pulse, %s", (_label, range) => {
  it("averages the days, each the mean of its local hours", async () => {
    const data = await collectDoctorReportData(userId, range, SELECTION, {
      moduleMap: { ...MODULES },
    });
    expect(data.stats.PULSE).toMatchObject({ count: 64, min: 60, max: 150 });
    expect(data.stats.PULSE.avg).toBeCloseTo(71.25, 9);
  });
});

it("draws the long window's day points as hourly-mean days", async () => {
  const data = await collectDoctorReportData(userId, LONG, SELECTION, {
    moduleMap: { ...MODULES },
  });
  expect(data.measurements.PULSE.map((p) => p.value)).toEqual([
    expect.closeTo(82.5, 9),
    expect.closeTo(60, 9),
  ]);
});
