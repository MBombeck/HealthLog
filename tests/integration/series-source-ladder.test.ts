/**
 * The per-kind series follows the source-priority ladder.
 *
 * The rollup tier and sleep resolve every (type, day) to the source the
 * person's ladder picks before they aggregate. The dense and raw reads of
 * `/api/measurements/series` filtered on user and type only, so with a second
 * provider a day's value blended the two, a reading present in both showed
 * twice, and the ladder had no effect on those charts.
 *
 * What is asserted, against a real Postgres:
 *   - the ladder decides which source a day shows, in both directions;
 *   - the rule is per day, so a day only the second source covers still shows;
 *   - a reading mirrored into two sources appears once;
 *   - the day-bucket, hour-bucket and raw reads all follow it, and the stats
 *     strip counts the canonical rows;
 *   - a type with no ladder keeps every source (the collapse would otherwise
 *     break the tie by source name and hide one of two real sources);
 *   - a single-source account reads exactly what is stored.
 */
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import type {
  MeasurementSource,
  MeasurementType,
  Prisma,
} from "@/generated/prisma/client";
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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const prisma = getPrismaClient();
const TZ = "Europe/Berlin";
const DUAL = "ladder-dual";
const DENSE = "ladder-dense";
const SOLO = "ladder-solo";
const BP_MIX = "ladder-bp-mix";
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
const DAY = 86_400_000;

/**
 * Noon UTC of the n-th day back (plus a few minutes), so a reading falls on one
 * UTC day and one Berlin day whenever the suite runs. Anchoring on "now" would
 * let a reading cross midnight and make the per-day source pick depend on the
 * clock.
 */
const TODAY_NOON_UTC = Date.UTC(
  NOW.getUTCFullYear(),
  NOW.getUTCMonth(),
  NOW.getUTCDate(),
  12,
);
const at = (daysBack: number, minuteOffset = 0) =>
  new Date(TODAY_NOON_UTC - daysBack * DAY + minuteOffset * 60_000);

let seq = 0;
const row = (
  userId: string,
  type: MeasurementType,
  unit: string,
  source: MeasurementSource,
  value: number,
  measuredAt: Date,
): Prisma.MeasurementCreateManyInput => ({
  id: `ladder-${++seq}`,
  userId,
  type,
  unit,
  source,
  value,
  measuredAt,
});

async function setLadder(userId: string, ladder: Record<string, string[]>) {
  await prisma.user.update({
    where: { id: userId },
    data: { sourcePriorityJson: ladder },
  });
}

async function series(userId: string, kind: string, days: number) {
  const s = await prisma.session.create({
    data: { userId, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.clear();
  cookieJar.set("healthlog_session", s.id);
  const { GET } = await import("@/app/api/measurements/series/route");
  const res = await GET(
    new NextRequest(
      `http://localhost/api/measurements/series?kind=${kind}&days=${days}`,
    ),
  );
  expect(res.status).toBe(200);
  return (
    (await res.json()) as {
      data: {
        points: Array<{
          id: string;
          at: string;
          value: number;
          secondary: number | null;
        }>;
        stats: { count: number; mean: number; min: number; max: number };
      };
    }
  ).data;
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  for (const id of [DUAL, DENSE, SOLO, BP_MIX]) {
    await prisma.user.create({ data: { id, username: id, timezone: TZ } });
    invalidateUserTimezone(id);
  }

  // Pulse: Apple Health (60-64) covers days 1-3, Fitbit (90-94) covers days 3-5,
  // so day 3 has both sources and days 4-5 only Fitbit.
  const dual: Prisma.MeasurementCreateManyInput[] = [];
  for (const d of [1, 2, 3]) {
    [60, 62, 64].forEach((v, i) =>
      dual.push(row(DUAL, "PULSE", "bpm", "APPLE_HEALTH", v, at(d, i))),
    );
  }
  for (const d of [3, 4, 5]) {
    [90, 92, 94].forEach((v, i) =>
      dual.push(row(DUAL, "PULSE", "bpm", "FITBIT", v, at(d, i + 3))),
    );
  }
  // Weight: the same weighing recorded by hand AND by the scale, three days.
  for (const d of [1, 2, 3]) {
    dual.push(row(DUAL, "WEIGHT", "kg", "MANUAL", 80 + d, at(d)));
    dual.push(row(DUAL, "WEIGHT", "kg", "WITHINGS", 80 + d, at(d)));
  }
  // Blood pressure: Apple Health (120/80, 122/82) on days 1-2, Withings
  // (140/90, 142/92) on days 2-3. Day 2 has both sources; day 1 only Apple,
  // day 3 only Withings. A sub-floor systolic (0) on day 1 must stay out.
  const bp = (
    source: MeasurementSource,
    d: number,
    sys: number,
    dia: number,
  ) => {
    dual.push(row(DUAL, "BLOOD_PRESSURE_SYS", "mmHg", source, sys, at(d, 10)));
    dual.push(row(DUAL, "BLOOD_PRESSURE_DIA", "mmHg", source, dia, at(d, 10)));
  };
  bp("APPLE_HEALTH", 1, 120, 80);
  bp("APPLE_HEALTH", 2, 122, 82);
  bp("WITHINGS", 2, 142, 92);
  bp("WITHINGS", 3, 140, 90);
  dual.push(
    row(DUAL, "BLOOD_PRESSURE_SYS", "mmHg", "APPLE_HEALTH", 0, at(1, 20)),
  );
  // Glucose has no ladder: both sources must stay.
  for (const d of [1, 2]) {
    dual.push(row(DUAL, "BLOOD_GLUCOSE", "mg/dL", "APPLE_HEALTH", 100, at(d)));
    dual.push(row(DUAL, "BLOOD_GLUCOSE", "mg/dL", "NIGHTSCOUT", 110, at(d, 1)));
  }
  await prisma.measurement.createMany({ data: dual });

  // A dense two-source pulse stream: past the 10 000-row cap, so it is read
  // as hour buckets. Apple is a steady 70, Fitbit a steady 100.
  for (const [source, value] of [
    ["APPLE_HEALTH", 70],
    ["FITBIT", 100],
  ] as const) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO measurements (
         id, user_id, type, value, unit, source, measured_at,
         created_at, updated_at, sync_version)
       SELECT $4 || lpad(g::text, 7, '0'), $1, 'PULSE'::measurement_type,
         $5, 'bpm', $6::measurement_source,
         ($2::timestamptz AT TIME ZONE 'UTC') - (g * interval '1 minute'),
         now(), now(), 1
       FROM generate_series(0, $3::int - 1) g`,
      DENSE,
      NOW.toISOString(),
      6_000,
      `dn-${source}-`,
      value,
      source,
    );
  }

  // Blood pressure where one source holds only half of a reading. Day 1: the
  // cuff's systolic 150 is live but its diastolic was deleted, while Apple
  // Health holds the same moment as a full 125/85. Day 2: the cuff's only
  // systolic that day is a sub-floor 0 next to a diastolic 80, while Apple
  // Health holds 126/86. A per-type pick takes the cuff's systolic and Apple's
  // diastolic on day 1 and pairs them across sources, and on day 2 picks the
  // cuff for a systolic the floor then removes, which empties the day.
  await prisma.measurement.createMany({
    data: [
      row(BP_MIX, "BLOOD_PRESSURE_SYS", "mmHg", "WITHINGS", 150, at(1, 10)),
      {
        ...row(BP_MIX, "BLOOD_PRESSURE_DIA", "mmHg", "WITHINGS", 95, at(1, 10)),
        deletedAt: new Date(),
      },
      row(BP_MIX, "BLOOD_PRESSURE_SYS", "mmHg", "APPLE_HEALTH", 125, at(1, 10)),
      row(BP_MIX, "BLOOD_PRESSURE_DIA", "mmHg", "APPLE_HEALTH", 85, at(1, 10)),
      row(BP_MIX, "BLOOD_PRESSURE_SYS", "mmHg", "WITHINGS", 0, at(2, 10)),
      row(BP_MIX, "BLOOD_PRESSURE_DIA", "mmHg", "WITHINGS", 80, at(2, 10)),
      row(BP_MIX, "BLOOD_PRESSURE_SYS", "mmHg", "APPLE_HEALTH", 126, at(2, 12)),
      row(BP_MIX, "BLOOD_PRESSURE_DIA", "mmHg", "APPLE_HEALTH", 86, at(2, 12)),
    ],
  });

  // A single-source account.
  await prisma.measurement.createMany({
    data: [1, 2, 3, 4].map((d) =>
      row(SOLO, "WEIGHT", "kg", "MANUAL", 70 + d, at(d)),
    ),
  });
  await prisma.$executeRawUnsafe(`ANALYZE measurements`);
}, 120_000);

describe("pulse follows the ladder (raw read, 30 days)", () => {
  it("shows Apple Health when it ranks first, and fills the days only Fitbit covers", async () => {
    await setLadder(DUAL, { pulse: ["APPLE_HEALTH", "FITBIT"] });
    const data = await series(DUAL, "pulse", 30);
    // Days 1-3: Apple (60-64). Day 3 is shared, so Fitbit's day-3 rows are out.
    // Days 4-5: only Fitbit exists, so Fitbit shows.
    const values = data.points.map((p) => p.value).sort((a, b) => a - b);
    expect(values).toEqual([
      60, 60, 60, 62, 62, 62, 64, 64, 64, 90, 90, 92, 92, 94, 94,
    ]);
    expect(data.stats.count).toBe(15);
  });

  it("shows Fitbit when it ranks first, and fills the days only Apple covers", async () => {
    await setLadder(DUAL, { pulse: ["FITBIT", "APPLE_HEALTH"] });
    const data = await series(DUAL, "pulse", 30);
    const values = data.points.map((p) => p.value).sort((a, b) => a - b);
    // Days 3-5: Fitbit. Days 1-2: only Apple exists.
    expect(values).toEqual([
      60, 60, 62, 62, 64, 64, 90, 90, 90, 92, 92, 92, 94, 94, 94,
    ]);
    expect(data.stats.count).toBe(15);
  });

  it("does not blend the two on a shared day (day-bucket read, 365 days)", async () => {
    await setLadder(DUAL, { pulse: ["APPLE_HEALTH", "FITBIT"] });
    const data = await series(DUAL, "pulse", 365);
    const byDay = data.points.map((p) => p.value).sort((a, b) => a - b);
    // One mean per local day: Apple's days 1-3 are 62, Fitbit's days 4-5 are 92.
    expect(byDay).toEqual([62, 62, 62, 92, 92]);
    expect(data.stats.count).toBe(15);
  });
});

describe("blood pressure follows the ladder", () => {
  const bpSeries = async () => (await series(DUAL, "bloodPressure", 30)).points;

  it("shows the ladder's source on a day both cover, and the other where only it exists", async () => {
    await setLadder(DUAL, { bloodPressure: ["APPLE_HEALTH", "WITHINGS"] });
    const points = await bpSeries();
    // Day 1 Apple, day 2 Apple (Withings' 142/92 is out), day 3 only Withings.
    expect(points.map((p) => [p.value, p.secondary])).toEqual([
      [140, 90],
      [122, 82],
      [120, 80],
    ]);
  });

  it("flips with the ladder", async () => {
    await setLadder(DUAL, { bloodPressure: ["WITHINGS", "APPLE_HEALTH"] });
    const points = await bpSeries();
    expect(points.map((p) => [p.value, p.secondary])).toEqual([
      [140, 90],
      [142, 92],
      [120, 80],
    ]);
  });

  it("keeps a non-physiological systolic out of the series", async () => {
    await setLadder(DUAL, { bloodPressure: ["APPLE_HEALTH", "WITHINGS"] });
    expect((await bpSeries()).every((p) => p.value >= 40)).toBe(true);
  });
});

describe("blood pressure keeps a reading's two halves from one source", () => {
  it("never pairs one source's systolic with another source's diastolic", async () => {
    await setLadder(BP_MIX, { bloodPressure: ["WITHINGS", "APPLE_HEALTH"] });
    const points = (await series(BP_MIX, "bloodPressure", 30)).points;
    // Day 1 is the cuff's day: its systolic stands alone rather than borrowing
    // Apple's diastolic. Day 2 is Apple's, because the cuff has no systolic
    // that passes the floor there.
    expect(points.map((p) => [p.value, p.secondary])).toEqual([
      [126, 86],
      [150, null],
    ]);
  });
});

describe("a reading mirrored into two sources", () => {
  it("appears once", async () => {
    await setLadder(DUAL, { weight: ["WITHINGS", "MANUAL"] });
    const data = await series(DUAL, "weight", 30);
    expect(data.points).toHaveLength(3);
    expect(data.points.map((p) => p.value).sort()).toEqual([81, 82, 83]);
    expect(data.stats.count).toBe(3);
  });

  it("follows the ladder for which copy it keeps", async () => {
    await setLadder(DUAL, { weight: ["MANUAL", "WITHINGS"] });
    const manual = await series(DUAL, "weight", 30);
    const rows = await prisma.measurement.findMany({
      where: { userId: DUAL, type: "WEIGHT", source: "MANUAL" },
      select: { id: true },
    });
    expect(new Set(manual.points.map((p) => p.id))).toEqual(
      new Set(rows.map((r) => r.id)),
    );
  });
});

describe("an hour-bucket read (past the 10 000-row cap)", () => {
  it("shows only the ladder's source in every bucket", async () => {
    await setLadder(DENSE, { pulse: ["APPLE_HEALTH", "FITBIT"] });
    const apple = await series(DENSE, "pulse", 30);
    expect(apple.points.length).toBeGreaterThan(50);
    expect(apple.points.every((p) => p.id.startsWith("hour:"))).toBe(true);
    expect(apple.points.every((p) => p.value === 70)).toBe(true);
    expect(apple.stats.count).toBe(6_000);

    await setLadder(DENSE, { pulse: ["FITBIT", "APPLE_HEALTH"] });
    const fitbit = await series(DENSE, "pulse", 30);
    expect(fitbit.points.every((p) => p.value === 100)).toBe(true);
    expect(fitbit.stats.count).toBe(6_000);
  });
});

describe("a type with no ladder", () => {
  it("keeps every source (glucose)", async () => {
    const data = await series(DUAL, "glucose", 30);
    expect(data.points).toHaveLength(4);
    expect(data.stats.count).toBe(4);
  });
});

describe("a single-source account", () => {
  it("reads exactly what is stored", async () => {
    const data = await series(SOLO, "weight", 30);
    const raw = await prisma.measurement.findMany({
      where: { userId: SOLO, type: "WEIGHT" },
      orderBy: { measuredAt: "asc" },
      select: { id: true, value: true, measuredAt: true },
    });
    expect(data.points).toEqual(
      raw.map((r) => ({
        id: r.id,
        at: r.measuredAt.toISOString(),
        value: r.value,
        secondary: null,
      })),
    );
  });
});
