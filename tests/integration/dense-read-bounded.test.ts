/**
 * #1023 — a status card over a dense heart-rate stream, measured.
 *
 * A single account syncing heart rate from a watch killed the worker within
 * half an hour: the pulse status card's recent-window read was bounded in
 * time (91 days) but not in rows, so every refresh materialised the whole
 * stream as objects, and the read itself ran past the statement timeout.
 * The read now folds per day in Postgres.
 *
 * The fixture is one reading a minute for 91 days, 131 040 rows, seeded in
 * one `INSERT … generate_series`. Each half of the memory test reads the
 * same window: the per-day fold the card now uses, and the raw `findMany` it
 * used to issue. Without the second half the budget could be any number and
 * the first half would still pass. Every reading of the heap is taken after a
 * forced collection, so what is compared is what each read HOLDS; the
 * transient figure (taken before collecting) is reported alongside.
 *
 * The parity case pins that the SQL fold and the in-memory fold the unit
 * tests use agree on real Postgres: same days in a non-UTC zone, same
 * segment edges, same plausibility filter.
 */
import v8 from "node:v8";
import vm from "node:vm";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { buildGradedSeriesWithRollups } from "@/lib/insights/graded-series";
import { readDayAggregates } from "@/lib/measurements/day-aggregates";
import { foldDayAggregates } from "@/lib/measurements/__tests__/fake-day-aggregates";
import { localHmAsUtc } from "@/lib/tz/local-day";
import { dayValue } from "@/lib/measurements/day-mean";
import { userDayKey } from "@/lib/tz/format";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const prisma = getPrismaClient();
const DENSE_USER = "dense-pulse-owner";
const PARITY_USER = "dense-parity-owner";
const DAYS = 91;
const ROWS = DAYS * 24 * 60;
const NOW = new Date("2026-09-20T18:00:00.000Z");

const forceGc = ((): (() => void) => {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  v8.setFlagsFromString("--no-expose-gc");
  return gc;
})();

function liveHeapBytes(): number {
  forceGc();
  forceGc();
  return process.memoryUsage().heapUsed;
}

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

function report(line: string): void {
  process.stderr.write(`[dense-read] ${line}\n`);
}

/** Run `read`, returning what it holds, its transient peak and its time. */
async function measure<T>(read: () => Promise<T>): Promise<{
  result: T;
  heldBytes: number;
  transientBytes: number;
  ms: number;
}> {
  const before = liveHeapBytes();
  const t0 = performance.now();
  const result = await read();
  const ms = performance.now() - t0;
  const transientBytes = process.memoryUsage().heapUsed - before;
  const heldBytes = liveHeapBytes() - before;
  return { result, heldBytes, transientBytes, ms };
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: DENSE_USER,
      username: DENSE_USER,
      timezone: "Europe/Berlin",
    },
  });
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (
       id, user_id, type, value, unit, source, measured_at,
       created_at, updated_at, sync_version)
     SELECT
       'dp' || lpad(g::text, 8, '0'),
       $1,
       'PULSE'::measurement_type,
       55 + (g % 50),
       'bpm',
       'GOOGLE_HEALTH'::measurement_source,
       ($2::timestamptz AT TIME ZONE 'UTC') - (g * interval '1 minute'),
       now(), now(), 1
     FROM generate_series(1, $3::int) g`,
    DENSE_USER,
    NOW.toISOString(),
    ROWS,
  );
  await prisma.$executeRawUnsafe(`ANALYZE measurements`);
}, 300_000);

afterAll(async () => {
  await truncateAllTables(prisma);
});

describe("pulse status over a dense stream (#1023)", () => {
  it("builds the graded series without materialising the stream", async () => {
    const graded = await measure(() =>
      buildGradedSeriesWithRollups(DENSE_USER, "PULSE", NOW, "Europe/Berlin"),
    );
    const series = graded.result;
    // Every reading in the 91-day window is accounted for, one bucket per day
    // or week, not one object per reading. The oldest reading sits exactly 91
    // days back, which the graded split files under the older slice.
    const counted = [...series.recent, ...series.weekly].reduce(
      (sum, b) => sum + b.n,
      0,
    );
    expect(counted).toBe(ROWS - 1);
    expect(series.recent.length).toBeLessThanOrEqual(22);
    expect(series.weekly.length).toBeLessThanOrEqual(12);

    const raw = await measure(() =>
      prisma.measurement.findMany({
        where: {
          userId: DENSE_USER,
          type: "PULSE",
          deletedAt: null,
          measuredAt: { gte: new Date(NOW.getTime() - DAYS * 86_400_000) },
        },
        orderBy: { measuredAt: "asc" },
        select: { measuredAt: true, value: true },
      }),
    );
    expect(raw.result.length).toBe(ROWS);

    report(
      `graded series (per-day fold, cold tier): held ${mb(graded.heldBytes)} MB, ` +
        `transient ${mb(graded.transientBytes)} MB, ${graded.ms.toFixed(0)} ms`,
    );
    report(
      `raw 91-day findMany (the old read): held ${mb(raw.heldBytes)} MB, ` +
        `transient ${mb(raw.transientBytes)} MB, ${raw.ms.toFixed(0)} ms, ` +
        `${raw.result.length} rows`,
    );

    // The fold holds a few kilobytes; the raw read holds the stream. The
    // transient figure is the one that killed the worker: the old builder
    // held little once it returned but allocated the whole stream on the
    // way (62 MB on this fixture, against 1.6 MB for the fold).
    expect(graded.heldBytes).toBeLessThan(2 * 1024 * 1024);
    expect(graded.transientBytes).toBeLessThan(12 * 1024 * 1024);
    expect(raw.heldBytes).toBeGreaterThan(20 * Math.max(graded.heldBytes, 1));
  }, 120_000);

  it("the SQL fold agrees with the in-memory fold on real Postgres", async () => {
    const tz = "Asia/Kolkata";
    await prisma.user.create({
      data: { id: PARITY_USER, username: PARITY_USER, timezone: tz },
    });
    const day = new Date("2026-09-10T12:00:00Z");
    const edge = new Date(NOW.getTime() - 21 * 86_400_000);
    const rows = [
      { at: localHmAsUtc(day, tz, 0, 5), value: 61 },
      { at: localHmAsUtc(day, tz, 23, 55), value: 99 },
      { at: localHmAsUtc(day, tz, 12, 0), value: 111_287_531 }, // impossible
      { at: edge, value: 70 },
      { at: new Date(edge.getTime() + 1), value: 72 },
      { at: new Date(NOW.getTime() - 200 * 86_400_000), value: 58 },
    ];
    await prisma.measurement.createMany({
      data: rows.map((r, i) => ({
        id: `parity-${i}`,
        userId: PARITY_USER,
        type: "PULSE" as const,
        value: r.value,
        unit: "bpm",
        source: "MANUAL" as const,
        measuredAt: r.at,
      })),
    });
    const opts = {
      since: new Date(NOW.getTime() - 400 * 86_400_000),
      until: NOW,
      timeZone: tz,
      valueRange: { min: 20, max: 300 },
      segmentStarts: [edge, new Date(NOW.getTime() - 91 * 86_400_000)],
    };
    const sql = await readDayAggregates({
      userId: PARITY_USER,
      type: "PULSE",
      ...opts,
    });
    const memory = foldDayAggregates(
      rows.map((r) => ({ measuredAt: r.at, value: r.value })),
      opts,
    );
    // Pulse rows also carry the hourly-mean day (`day-mean.ts`); the plain
    // fold fields agree with the in-memory fold, and each row's day value is
    // the mean of its local hours' means over the same readings.
    expect(
      sql.map(
        ({ dayMean: _d, weightedSum: _w, weightSum: _s, ...plain }) => plain,
      ),
    ).toEqual(memory);
    for (const row of sql) {
      const members = rows.filter(
        (r) =>
          r.value >= 20 &&
          r.value <= 300 &&
          userDayKey(r.at, tz) === row.day &&
          opts.segmentStarts.filter((s) => r.at < s).length === row.segment,
      );
      expect(row.dayMean).toBeCloseTo(
        dayValue(
          "PULSE",
          members.map((r) => ({ value: r.value, measuredAt: r.at })),
          tz,
        )!,
        9,
      );
    }
    // Sanity: the impossible value was dropped and the edge row split off.
    expect(sql.reduce((n, r) => n + r.n, 0)).toBe(5);
  });
});
