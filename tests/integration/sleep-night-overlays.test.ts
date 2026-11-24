/**
 * #1419 — the night metrics over the hypnogram, read on real Postgres.
 *
 * The fixture is one account with a dense pulse stream (a watch writing a
 * reading every three seconds for a week, about 200 000 rows), a phone's
 * pulse samples for the night, the phone's uploaded ten-minute buckets, a
 * breathing day total that must not land on the night as a reading, and a
 * nightly HRV average on the wake day's noon anchor. The read has to pick
 * one source per metric, keep the line inside the point budget however dense
 * the stream, and visit only the night's rows, not the week's.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma } from "@/generated/prisma/client";
import { canonicalDailyTimestamp } from "@/lib/measurements/consolidation-tz";
import {
  MAX_POINTS,
  nightOverlaysSql,
  overlayGrid,
  readNightOverlays,
  type NightOverlays,
} from "@/lib/sleep/night-overlays";

import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const USER = "night-overlays";
const TZ = "Europe/Berlin";
const NIGHT = "2026-06-04";
const START = new Date("2026-06-03T21:00:00.000Z");
const END = new Date("2026-06-04T05:00:00.000Z");
const WEEK_START = new Date("2026-05-29T00:00:00.000Z");
const DENSE_STEP_MS = 3_000;

async function seed(): Promise<void> {
  await prisma.user.create({
    data: {
      id: USER,
      username: USER,
      email: `${USER}@example.test`,
      timezone: TZ,
      onboardingCompletedAt: new Date(),
    },
  });
  const rows: Prisma.MeasurementCreateManyInput[] = [];
  // The watch: a reading every three seconds for a week.
  const weekEnd = WEEK_START.getTime() + 7 * 86_400_000;
  for (
    let t = WEEK_START.getTime(), i = 0;
    t < weekEnd;
    t += DENSE_STEP_MS, i++
  ) {
    rows.push({
      userId: USER,
      type: "PULSE",
      unit: "bpm",
      source: "GARMIN",
      measuredAt: new Date(t),
      value: 70 + (i % 9),
      externalId: `garmin-hr-${t}`,
    });
  }
  // The phone: a sample every five minutes through the night.
  for (let t = START.getTime(); t <= END.getTime(); t += 5 * 60_000) {
    rows.push({
      userId: USER,
      type: "PULSE",
      unit: "bpm",
      source: "APPLE_HEALTH",
      measuredAt: new Date(t + 60_000),
      value: 55,
      externalId: `apple-hr-${t}`,
    });
  }
  // An uploaded ten-minute bucket: an aggregate, and part of the line.
  const bucketAt = new Date("2026-06-04T02:00:00.000Z");
  rows.push({
    userId: USER,
    type: "PULSE",
    unit: "bpm",
    source: "APPLE_HEALTH",
    measuredAt: bucketAt,
    value: 52,
    externalId: `stats:HKQuantityTypeIdentifierHeartRate:${bucketAt.toISOString()}`,
  });
  // Breathing: two samples in the night, and a day total stamped inside it.
  for (const [at, value] of [
    ["2026-06-03T23:00:00.000Z", 14],
    ["2026-06-04T03:00:00.000Z", 13],
  ] as const) {
    rows.push({
      userId: USER,
      type: "RESPIRATORY_RATE",
      unit: "breaths/min",
      source: "APPLE_HEALTH",
      measuredAt: new Date(at),
      value,
      externalId: `apple-rr-${at}`,
    });
  }
  rows.push({
    userId: USER,
    type: "RESPIRATORY_RATE",
    unit: "breaths/min",
    source: "APPLE_HEALTH",
    measuredAt: new Date("2026-06-04T01:00:00.000Z"),
    value: 99,
    externalId: "stats:HKQuantityTypeIdentifierRespiratoryRate:2026-06-04",
  });
  // Garmin's HRV: one average for the night, on the wake day's anchor.
  rows.push({
    userId: USER,
    type: "HRV_RMSSD",
    unit: "ms",
    source: "GARMIN",
    measuredAt: canonicalDailyTimestamp(NIGHT, TZ),
    value: 44,
    externalId: `hrv:${NIGHT}:hrv_rmssd`,
  });
  for (let i = 0; i < rows.length; i += 20_000) {
    await prisma.measurement.createMany({ data: rows.slice(i, i + 20_000) });
  }
  await prisma.$executeRawUnsafe("ANALYZE measurements");
}

function read(source: "APPLE_HEALTH" | "GARMIN"): Promise<NightOverlays> {
  return readNightOverlays({
    userId: USER,
    session: { night: NIGHT, timeZone: TZ, source, start: START, end: END },
    priorityJson: null,
    visibleTypes: new Set([
      "PULSE",
      "RESPIRATORY_RATE",
      "HRV_RMSSD",
      "HEART_RATE_VARIABILITY",
    ]),
  });
}

describe("night overlays (real Postgres)", () => {
  beforeAll(async () => {
    await truncateAllTables(prisma);
    await seed();
  }, 120_000);

  afterAll(async () => {
    await truncateAllTables(prisma);
  });

  it("reads the pulse of the source that recorded the night", async () => {
    const overlays = await read("APPLE_HEALTH");
    const pulse = overlays.metrics.find((m) => m.kind === "pulse")!;
    expect(pulse.source).toBe("APPLE_HEALTH");
    expect(pulse.points.every((p) => p.value <= 55)).toBe(true);
    // The uploaded bucket is part of the line.
    expect(pulse.summary!.min).toBe(52);
  });

  it("keeps a dense stream inside the point budget", async () => {
    const overlays = await read("GARMIN");
    const pulse = overlays.metrics.find((m) => m.kind === "pulse")!;
    expect(pulse.source).toBe("GARMIN");
    expect(pulse.points.length).toBeLessThanOrEqual(MAX_POINTS);
    // Eight and a half hours of five-minute buckets, each one full.
    expect(pulse.points).toHaveLength(102);
    expect(pulse.summary).toMatchObject({ min: 70, max: 78 });
    expect(pulse.summary!.avg).toBeCloseTo(74, 0);
  });

  it("leaves a day total off the night", async () => {
    const overlays = await read("APPLE_HEALTH");
    const breathing = overlays.metrics.find((m) => m.kind === "respiration")!;
    expect(breathing.points.map((p) => p.value)).toEqual([14, 13]);
  });

  it("serves a nightly average on the wake day's anchor as the night's value", async () => {
    const overlays = await read("GARMIN");
    expect(overlays.metrics.find((m) => m.kind === "hrv")).toMatchObject({
      type: "HRV_RMSSD",
      source: "GARMIN",
      nightValue: 44,
      points: [],
    });
  });

  it("visits the night's rows, not the week's", async () => {
    const sql = nightOverlaysSql({
      userId: USER,
      types: ["PULSE", "RESPIRATORY_RATE", "HRV_RMSSD"],
      anchorTypes: ["RESPIRATORY_RATE", "HRV_RMSSD"],
      grid: overlayGrid(START, END),
      anchor: canonicalDailyTimestamp(NIGHT, TZ),
    });
    const [{ "QUERY PLAN": plan }] = await prisma.$queryRaw<
      Array<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>
    >(Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`);
    const visited = measurementRowsVisited(plan[0]!.Plan);
    const nightRows =
      (END.getTime() - START.getTime() + 30 * 60_000) / DENSE_STEP_MS;
    const weekRows = (7 * 86_400_000) / DENSE_STEP_MS;
    expect(visited).toBeGreaterThan(0);
    expect(visited).toBeLessThan(nightRows * 1.2);
    expect(visited).toBeLessThan(weekRows / 10);
  });
});

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: PlanNode[];
}

/** Rows the plan's scans of `measurements` touched, filtered ones included. */
function measurementRowsVisited(node: PlanNode): number {
  const own =
    node["Relation Name"] === "measurements"
      ? (node["Actual Rows"] +
          (node["Rows Removed by Filter"] ?? 0) +
          (node["Rows Removed by Index Recheck"] ?? 0)) *
        node["Actual Loops"]
      : 0;
  return (
    own + (node.Plans ?? []).reduce((n, p) => n + measurementRowsVisited(p), 0)
  );
}
