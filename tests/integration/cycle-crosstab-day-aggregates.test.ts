/**
 * The cycle-phase crosstab reads per-day, per-source aggregates instead of a
 * year of raw readings (#1023). This pins that the day values it tests are
 * the ones the raw readings give: for every crosstab metric, `metricDayMap`
 * over the aggregates equals `metricDayMap` over the raw rows, on a fixture
 * with two sources on the same days, two device types within one source,
 * dense CGM glucose, summed steps and readings next to Berlin midnight.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { readSourceDayAggregates } from "@/lib/measurements/day-aggregates";
import { metricDayMap } from "@/lib/insights/mood-crosstab";
import { PHASE_CROSSTAB_METRIC_TYPES } from "@/lib/cycle/phase-crosstab";
import type { CrossMetricMeasurement } from "@/lib/insights/mood-aggregates";

const prisma = getPrismaClient();
const USER = "cycle-crosstab-agg";
const SINCE = new Date("2026-06-01T00:00:00Z");

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({ data: { id: USER, username: USER } });
  // CGM glucose every 5 minutes for 60 days from two sources.
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at, sync_version)
     SELECT 'cg' || s || g, $1, 'BLOOD_GLUCOSE'::measurement_type, 80 + (g % 60), 'mg/dL',
       (CASE WHEN s = 0 THEN 'APPLE_HEALTH' ELSE 'NIGHTSCOUT' END)::measurement_source,
       timestamp '2026-06-02 00:00:00' + (g * interval '5 minutes') + (s * interval '1 second'),
       now(), now(), 1
     FROM generate_series(0, 60 * 288 - 1) g, generate_series(0, 1) s`,
    USER,
  );
  // Steps every 15 minutes from a watch and a phone, plus Google totals on
  // some days; resting heart rate once a day near Berlin midnight.
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (id, user_id, type, value, unit, source, device_type, measured_at, created_at, updated_at, sync_version)
     SELECT 'st' || d || g, $1, 'ACTIVITY_STEPS'::measurement_type, 10 + (g % 7), 'count',
       'APPLE_HEALTH'::measurement_source, CASE WHEN d = 0 THEN 'watch' ELSE 'phone' END,
       timestamp '2026-06-02 00:00:00' + (g * interval '15 minutes') + (d * interval '2 seconds'),
       now(), now(), 1
     FROM generate_series(0, 60 * 96 - 1) g, generate_series(0, 1) d
     WHERE d = 0 OR g % 3 = 0`,
    USER,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at, sync_version)
     SELECT 'gs' || g, $1, 'ACTIVITY_STEPS'::measurement_type, 5000 + g, 'count',
       'GOOGLE_HEALTH'::measurement_source,
       timestamp '2026-06-02 12:00:00' + (g * interval '1 day'), now(), now(), 1
     FROM generate_series(0, 59, 4) g`,
    USER,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at, sync_version)
     SELECT 'rh' || g, $1, 'RESTING_HEART_RATE'::measurement_type, 55 + (g % 9), 'bpm',
       'WITHINGS'::measurement_source,
       timestamp '2026-06-02 22:30:00' + (g * interval '1 day'), now(), now(), 1
     FROM generate_series(0, 59) g`,
    USER,
  );
}, 120_000);

describe("cycle crosstab day values (#1023)", () => {
  it("per-source day aggregates give the raw rows' day values for every metric", async () => {
    const raw = await prisma.measurement.findMany({
      where: {
        userId: USER,
        deletedAt: null,
        type: { in: PHASE_CROSSTAB_METRIC_TYPES },
        measuredAt: { gte: SINCE },
      },
      select: {
        type: true,
        value: true,
        measuredAt: true,
        source: true,
        deviceType: true,
      },
    });
    const agg = await readSourceDayAggregates({
      userId: USER,
      types: PHASE_CROSSTAB_METRIC_TYPES,
      since: SINCE,
      timeZone: "Europe/Berlin",
    });
    const aggRows: CrossMetricMeasurement[] = agg.map((a) => ({
      type: a.type,
      value: a.sum,
      count: a.n,
      measuredAt: a.firstAt,
      source: a.source,
      deviceType: a.deviceType,
    }));

    expect(raw.length).toBeGreaterThan(40_000);
    expect(aggRows.length).toBeLessThan(500);

    for (const type of PHASE_CROSSTAB_METRIC_TYPES) {
      const expected = metricDayMap(raw, type, null, "Europe/Berlin");
      const actual = metricDayMap(aggRows, type, null, "Europe/Berlin");
      expect([...actual.keys()].sort(), type).toEqual(
        [...expected.keys()].sort(),
      );
      for (const [day, value] of expected) {
        expect(actual.get(day), `${type} ${day}`).toBeCloseTo(value, 9);
      }
    }
  }, 60_000);
});
