/**
 * `GET /api/cycle/insights` reads its outcome channels as per-source day
 * aggregates, not as a year of readings.
 *
 * The route compared a year of resting heart rate, heart-rate variability,
 * sleep, steps, weight, temperature and glucose across the cycle phases, and
 * read every reading of it. A sensor reporting glucose every five minutes is
 * over 100 000 readings in that year. The contrast only uses each local day's
 * sum and count after one source and device is picked per day, which is what
 * `readSourceDayAggregates` returns.
 *
 * Two properties on real Postgres: no outcome channel is read as rows, and the
 * response is the one the raw readings give. The second runs the route twice,
 * once over the SQL fold and once over every raw reading handed in as its own
 * one-reading aggregate (exactly the old input), and compares the bodies.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import type { SourceDayAggregateRow } from "@/lib/measurements/day-aggregates";
import { userDayKey } from "@/lib/tz/format";
import { invalidateUserTimezone } from "@/lib/tz/resolver";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

/** When set, the fold is replaced by every raw reading as a one-row group. */
const mode = vi.hoisted(() => ({ raw: false }));

vi.mock("@/lib/measurements/day-aggregates", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/measurements/day-aggregates")>();
  return {
    ...actual,
    readSourceDayAggregates: async (
      opts: Parameters<typeof actual.readSourceDayAggregates>[0],
    ): Promise<SourceDayAggregateRow[]> => {
      if (!mode.raw) return actual.readSourceDayAggregates(opts);
      const { getPrismaClient } = await import("./setup");
      const rows = await getPrismaClient().measurement.findMany({
        where: {
          userId: opts.userId,
          deletedAt: null,
          type: { in: [...opts.types] },
          measuredAt: { gte: opts.since },
        },
        orderBy: { measuredAt: "asc" },
        select: {
          type: true,
          value: true,
          measuredAt: true,
          source: true,
          deviceType: true,
        },
      });
      return rows.map((r) => ({
        type: r.type,
        day: userDayKey(r.measuredAt, opts.timeZone),
        source: r.source,
        deviceType: r.deviceType,
        n: 1,
        sum: r.value,
        firstAt: r.measuredAt,
      }));
    },
  };
});

const prisma = getPrismaClient();
const OWNER = "cycle-dense-owner";
const TZ = "Europe/Berlin";
const CYCLE_LENGTH = 28;
const OBSERVED_CYCLES = 5;
const DAY = 86_400_000;

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: OWNER, username: OWNER, gender: "FEMALE", timezone: TZ },
  });
  invalidateUserTimezone(OWNER);
  await prisma.cycleProfile.create({
    data: {
      userId: OWNER,
      cycleTrackingEnabled: true,
      predictionEnabled: false,
      lutealPhaseLength: 14,
    },
  });
  for (let i = OBSERVED_CYCLES; i >= 1; i--) {
    await prisma.menstrualCycle.create({
      data: {
        userId: OWNER,
        startDate: isoDay(-i * CYCLE_LENGTH),
        endDate: i > 1 ? isoDay(-(i - 1) * CYCLE_LENGTH - 1) : null,
        periodEndDate: isoDay(-i * CYCLE_LENGTH + 4),
        tz: "UTC",
      },
    });
  }
  const start = `${isoDay(-OBSERVED_CYCLES * CYCLE_LENGTH)} 00:00:00`;
  // Sensor glucose every five minutes from two sources, higher in the second
  // half of each cycle; heart-rate variability every twenty minutes from a
  // watch, lower in the second half; steps every fifteen minutes from a watch
  // and a phone; weight once a day next to the Berlin midnight.
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at, sync_version)
     SELECT 'cg' || s || '-' || g, $1, 'BLOOD_GLUCOSE'::measurement_type,
       (CASE WHEN (g / 288) % 28 >= 14 THEN 120 ELSE 95 END) + (g % 23) + s * 0.5, 'mg/dL',
       (CASE WHEN s = 0 THEN 'APPLE_HEALTH' ELSE 'NIGHTSCOUT' END)::measurement_source,
       $2::timestamp + (g * interval '5 minutes') + (s * interval '1 second'),
       now(), now(), 1
     FROM generate_series(0, ${OBSERVED_CYCLES * CYCLE_LENGTH} * 288 - 1) g, generate_series(0, 1) s`,
    OWNER,
    start,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at, sync_version)
     SELECT 'hv' || g, $1, 'HEART_RATE_VARIABILITY'::measurement_type,
       (CASE WHEN (g / 72) % 28 >= 14 THEN 38 ELSE 52 END) + (g % 11) * 0.7, 'ms',
       'APPLE_HEALTH'::measurement_source,
       $2::timestamp + (g * interval '20 minutes'), now(), now(), 1
     FROM generate_series(0, ${OBSERVED_CYCLES * CYCLE_LENGTH} * 72 - 1) g`,
    OWNER,
    start,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (id, user_id, type, value, unit, source, device_type, measured_at, created_at, updated_at, sync_version)
     SELECT 'st' || d || '-' || g, $1, 'ACTIVITY_STEPS'::measurement_type, 10 + (g % 7), 'count',
       'APPLE_HEALTH'::measurement_source, CASE WHEN d = 0 THEN 'watch' ELSE 'phone' END,
       $2::timestamp + (g * interval '15 minutes') + (d * interval '2 seconds'),
       now(), now(), 1
     FROM generate_series(0, ${OBSERVED_CYCLES * CYCLE_LENGTH} * 96 - 1) g, generate_series(0, 1) d
     WHERE d = 0 OR g % 3 = 0`,
    OWNER,
    start,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, created_at, updated_at, sync_version)
     SELECT 'wt' || g, $1, 'WEIGHT'::measurement_type,
       (CASE WHEN g % 28 >= 14 THEN 71.2 ELSE 70.1 END) + (g % 5) * 0.1, 'kg',
       'WITHINGS'::measurement_source,
       $2::timestamp + (g * interval '1 day') + interval '22 hours 50 minutes', now(), now(), 1
     FROM generate_series(0, ${OBSERVED_CYCLES * CYCLE_LENGTH} - 1) g`,
    OWNER,
    start,
  );
  await prisma.$executeRawUnsafe(`ANALYZE measurements`);
  const session = await prisma.session.create({
    data: { userId: OWNER, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.clear();
  cookieJar.set("healthlog_session", session.id);
}, 180_000);

async function readInsights(): Promise<{ status: number; body: unknown }> {
  const { GET } = await import("@/app/api/cycle/insights/route");
  const handler = GET as unknown as (request: Request) => Promise<Response>;
  const res = await handler(new Request("http://localhost/api/cycle/insights"));
  return { status: res.status, body: await res.json() };
}

function readsOutcomeRows(args: unknown): boolean {
  const type = (args as { where?: { type?: unknown } } | undefined)?.where
    ?.type;
  const list = (type as { in?: unknown } | undefined)?.in;
  return (
    type === "BLOOD_GLUCOSE" ||
    type === "HEART_RATE_VARIABILITY" ||
    (Array.isArray(list) &&
      (list.includes("BLOOD_GLUCOSE") ||
        list.includes("HEART_RATE_VARIABILITY")))
  );
}

function expectSameUpToRounding(
  actual: unknown,
  expected: unknown,
  path: string,
): void {
  if (typeof expected === "number" && typeof actual === "number") {
    const scale = Math.max(Math.abs(expected), Math.abs(actual));
    expect(
      Math.abs(actual - expected) <= scale * 1e-9,
      `${path}: ${actual} vs ${expected}`,
    ).toBe(true);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect((actual as unknown[]).length, path).toBe(expected.length);
    expected.forEach((e, i) =>
      expectSameUpToRounding((actual as unknown[])[i], e, `${path}[${i}]`),
    );
    return;
  }
  if (expected !== null && typeof expected === "object") {
    expect(actual !== null && typeof actual === "object", path).toBe(true);
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    expect(Object.keys(a).sort(), path).toEqual(Object.keys(e).sort());
    for (const key of Object.keys(e)) {
      expectSameUpToRounding(a[key], e[key], `${path}.${key}`);
    }
    return;
  }
  expect(actual, path).toEqual(expected);
}

describe("cycle insights on a dense account", () => {
  it("reads no outcome channel as rows", async () => {
    mode.raw = false;
    const spy = vi.spyOn(prisma.measurement, "findMany");
    try {
      const started = performance.now();
      const { status } = await readInsights();
      process.stderr.write(
        `[cycle-insights-dense] ${(performance.now() - started).toFixed(0)} ms\n`,
      );
      expect(status).toBe(200);
      expect(spy.mock.calls.filter(([a]) => readsOutcomeRows(a))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it("answers exactly what the raw readings give", async () => {
    mode.raw = false;
    const folded = await readInsights();
    mode.raw = true;
    const raw = await readInsights();
    mode.raw = false;
    expect(folded.status).toBe(200);
    const rows = (folded.body as { data: { rows: unknown[] } }).data.rows;
    // The fixture is built so the contrast has something to say.
    expect(rows.length).toBeGreaterThan(0);
    // A day's sum is added in another order in SQL than in JavaScript, so a
    // p-value can differ in its last bits; every figure is otherwise equal.
    expectSameUpToRounding(folded.body, raw.body, "body");
  }, 120_000);
});
