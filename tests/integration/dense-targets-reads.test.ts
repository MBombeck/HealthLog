/**
 * The targets page on a dense account: a glucose sensor reporting every five
 * minutes and a watch recording heart rate once a minute.
 *
 * `buildTargetsResponse` read a year of raw glucose readings to keep the
 * newest one per meal context, and thirty days of raw heart rate to derive one
 * resting figure per day. Both now fold in SQL. These cases pin that neither
 * stream is read as rows any more, and that the cards come out exactly as the
 * in-memory fold over the raw readings makes them, on a dense account and on
 * a sparse one with readings next to the local midnight.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { deriveRestingProxyFromPulse } from "@/lib/analytics/resting-pulse";
import {
  computeSummariesSlice,
  readSevenDayMeans,
} from "@/lib/analytics/summaries-slice";
import { buildTargetsResponse } from "@/lib/targets/build-response";
import { buildGlucoseTargets } from "@/lib/targets/glucose-builder";
import {
  foldGlucoseTargetRows,
  readGlucoseTargetSummaries,
} from "@/lib/targets/glucose-read";
import { buildVitalTargets } from "@/lib/targets/vitals-builder";
import { userDayKey } from "@/lib/tz/format";
import { invalidateUserTimezone } from "@/lib/tz/resolver";

const prisma = getPrismaClient();
const TZ = "America/New_York";
const DENSE = "dense-targets-owner";
const SPARSE = "sparse-targets-owner";
const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
const DAY = 86_400_000;

beforeAll(async () => {
  await truncateAllTables(prisma);
  for (const id of [DENSE, SPARSE]) {
    await prisma.user.create({
      data: {
        id,
        username: id,
        timezone: TZ,
        dateOfBirth: new Date("1980-05-01T00:00:00Z"),
        gender: "FEMALE",
        heightCm: 170,
      },
    });
    invalidateUserTimezone(id);
  }
  // 200 days of a sensor every five minutes, untagged, with every 37th
  // reading tagged fasting so two contexts are present.
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (
       id, user_id, type, value, unit, source, glucose_context, measured_at,
       created_at, updated_at, sync_version)
     SELECT 'dg' || lpad(g::text, 7, '0'), $1, 'BLOOD_GLUCOSE'::measurement_type,
       70 + (g % 110) + (g % 3) * 0.25, 'mg/dL', 'NIGHTSCOUT'::measurement_source,
       CASE WHEN g % 37 = 0 THEN 'FASTING'::glucose_context ELSE NULL END,
       ($2::timestamptz AT TIME ZONE 'UTC') - (g * interval '5 minutes'),
       now(), now(), 1
     FROM generate_series(0, 200 * 288 - 1) g`,
    DENSE,
    NOW.toISOString(),
  );
  // Ten days of heart rate once a minute.
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (
       id, user_id, type, value, unit, source, measured_at,
       created_at, updated_at, sync_version)
     SELECT 'dp' || lpad(g::text, 7, '0'), $1, 'PULSE'::measurement_type,
       55 + (g % 50), 'bpm', 'GOOGLE_HEALTH'::measurement_source,
       ($2::timestamptz AT TIME ZONE 'UTC') - (g * interval '1 minute'),
       now(), now(), 1
     FROM generate_series(0, 10 * 24 * 60 - 1) g`,
    DENSE,
    NOW.toISOString(),
  );

  // Sparse: fingerstick readings in three contexts, a few a day, some older
  // than thirty days, some within minutes of the New York midnight; a cuff a
  // few times a day; a resting heart rate on alternate days.
  const contexts = ["FASTING", "POSTPRANDIAL", null] as const;
  const sparse: Array<{
    type: "BLOOD_GLUCOSE" | "PULSE" | "RESTING_HEART_RATE";
    value: number;
    at: Date;
    ctx?: (typeof contexts)[number];
  }> = [];
  for (let day = 0; day < 60; day++) {
    for (let i = 0; i < 1 + (day % 3); i++) {
      sparse.push({
        type: "BLOOD_GLUCOSE",
        value: 85 + ((day * 13 + i * 29) % 90) + (i % 2 ? 0.5 : 0),
        at: new Date(NOW.getTime() - day * DAY - (i * 311 + 7) * 60_000),
        ctx: contexts[(day + i) % 3],
      });
    }
    if (day < 25) {
      for (let i = 0; i < 2 + (day % 4); i++) {
        sparse.push({
          type: "PULSE",
          value: 54 + ((day * 7 + i * 11) % 40),
          at: new Date(NOW.getTime() - day * DAY - (i * 173 + 3) * 60_000),
        });
      }
    }
    if (day % 2 === 0 && day < 30) {
      sparse.push({
        type: "RESTING_HEART_RATE",
        value: 58 + (day % 6),
        at: new Date(NOW.getTime() - day * DAY - 4 * 3_600_000),
      });
    }
  }
  await prisma.measurement.createMany({
    data: sparse.map((r, i) => ({
      id: `st${String(i).padStart(5, "0")}`,
      userId: SPARSE,
      type: r.type,
      value: r.value,
      unit: r.type === "BLOOD_GLUCOSE" ? "mg/dL" : "bpm",
      source: "MANUAL" as const,
      glucoseContext: r.ctx ?? null,
      measuredAt: r.at,
    })),
  });
  await prisma.$executeRawUnsafe(`ANALYZE measurements`);
}, 180_000);

function readsDenseRows(args: unknown): boolean {
  const type = (args as { where?: { type?: unknown } } | undefined)?.where
    ?.type;
  if (type === "BLOOD_GLUCOSE" || type === "PULSE") return true;
  const list = (type as { in?: unknown } | undefined)?.in;
  return (
    Array.isArray(list) &&
    (list.includes("PULSE") || list.includes("BLOOD_GLUCOSE"))
  );
}

describe("targets on a dense account", () => {
  it("never reads the glucose or heart-rate stream as rows", async () => {
    const spy = vi.spyOn(prisma.measurement, "findMany");
    try {
      const started = performance.now();
      const res = await buildTargetsResponse({ id: DENSE, timezone: TZ });
      const elapsed = performance.now() - started;
      process.stderr.write(
        `[dense-targets] buildTargetsResponse ${elapsed.toFixed(0)} ms\n`,
      );
      expect(res.targets.length).toBeGreaterThan(0);
      const denseReads = spy.mock.calls.filter(([args]) =>
        readsDenseRows(args),
      );
      expect(denseReads).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("targets fold equals the raw-reading fold", () => {
  for (const userId of [SPARSE, DENSE]) {
    it(`glucose summaries match the in-memory fold (${userId})`, async () => {
      const since = new Date(NOW.getTime() - 365 * DAY);
      const recentSince = new Date(NOW.getTime() - 30 * DAY);
      const raw = await prisma.measurement.findMany({
        where: {
          userId,
          type: "BLOOD_GLUCOSE",
          deletedAt: null,
          measuredAt: { gte: since },
        },
        orderBy: [{ measuredAt: "desc" }, { id: "desc" }],
        select: { value: true, measuredAt: true, glucoseContext: true },
      });
      const expected = foldGlucoseTargetRows(raw, recentSince, TZ);
      const actual = await readGlucoseTargetSummaries({
        userId,
        since,
        recentSince,
        timeZone: TZ,
      });
      const byCtx = <T extends { glucoseContext: string | null }>(xs: T[]) =>
        [...xs].sort((a, b) =>
          (a.glucoseContext ?? "").localeCompare(b.glucoseContext ?? ""),
        );
      expect(actual.length).toBeGreaterThanOrEqual(2);
      const exp = byCtx(expected);
      const act = byCtx(actual);
      expect(act.map((s) => s.glucoseContext)).toEqual(
        exp.map((s) => s.glucoseContext),
      );
      for (let i = 0; i < exp.length; i++) {
        expect(act[i].latest).toBe(exp[i].latest);
        expect(act[i].latestAt).toEqual(exp[i].latestAt);
        expect(act[i].recentCount).toBe(exp[i].recentCount);
        expect([...act[i].recentByDay.keys()].sort()).toEqual(
          [...exp[i].recentByDay.keys()].sort(),
        );
        for (const [day, bucket] of exp[i].recentByDay) {
          const got = act[i].recentByDay.get(day)!;
          expect(got.count, day).toBe(bucket.count);
          expect(got.sum, day).toBeCloseTo(bucket.sum, 6);
        }
      }
    });

    it(`glucose and resting-pulse cards equal the raw path (${userId})`, async () => {
      const res = await buildTargetsResponse({ id: userId, timezone: TZ });
      // The builder takes its own clock after the reads; rebuild the raw
      // expectation against the same thirty-day cut.
      const now = new Date();
      const recentSince = new Date(now.getTime() - 30 * DAY);
      const raw = await prisma.measurement.findMany({
        where: {
          userId,
          type: "BLOOD_GLUCOSE",
          deletedAt: null,
          measuredAt: { gte: new Date(now.getTime() - 365 * DAY) },
        },
        orderBy: [{ measuredAt: "desc" }, { id: "desc" }],
        select: { value: true, measuredAt: true, glucoseContext: true },
      });
      const expectedGlucose = buildGlucoseTargets({
        summaries: foldGlucoseTargetRows(raw, recentSince, TZ),
        profile: {
          heightCm: 170,
          dateOfBirth: new Date("1980-05-01T00:00:00Z"),
          gender: "FEMALE",
          glucoseUnit: null,
          hasDiabetes: false,
          thresholdsJson: null,
        },
        timezone: TZ,
        now,
      });
      const glucose = res.targets.filter((t) =>
        t.type.startsWith("BLOOD_GLUCOSE_"),
      );
      expect(glucose.length).toBe(expectedGlucose.length);
      for (let i = 0; i < glucose.length; i++) {
        // The direction verdict is resolved by the route on top of the card
        // (v1.43); the fold under comparison does not produce it.
        const {
          average30,
          direction: _direction,
          trendSentiment: _trendSentiment,
          ...rest
        } = glucose[i];
        const { average30: expAvg, ...expRest } = expectedGlucose[i];
        expect(rest).toEqual(expRest);
        if (expAvg === null) expect(average30).toBeNull();
        else expect(average30).toBeCloseTo(expAvg, 6);
      }

      const recent = await prisma.measurement.findMany({
        where: {
          userId,
          type: { in: ["PULSE", "RESTING_HEART_RATE"] },
          deletedAt: null,
          measuredAt: { gte: recentSince },
        },
        select: { type: true, value: true, measuredAt: true },
      });
      const expectedPulse = buildVitalTargets({
        recentMeasurements: recent.filter(
          (r) => r.type === "RESTING_HEART_RATE",
        ),
        restingPulseProxy: deriveRestingProxyFromPulse(
          recent.filter((r) => r.type === "PULSE"),
          (d) => userDayKey(d, TZ),
        ),
        latestByType: {},
        average30ByType: {},
        heightCm: 170,
        age: res.profile.age,
        gender: "FEMALE",
        timezone: TZ,
        now,
        weightTargetOverride: null,
      }).targets.find((t) => t.type === "PULSE");
      const pulseTarget = res.targets.find((t) => t.type === "PULSE");
      expect(pulseTarget?.current).not.toBeNull();
      expect(pulseTarget?.direction).toBeDefined();
      const {
        direction: _direction,
        trendSentiment: _trendSentiment,
        ...pulse
      } = pulseTarget!;
      expect(pulse).toEqual(expectedPulse);
    });
  }
});

// The target verdict is placed with the dashboard tile's basis. Proven on
// the database, not assumed: the seven-day means the targets read equal the
// `avg7` the dashboard slice serves, type for type, on both accounts.
describe("target verdict basis equals the dashboard's", () => {
  for (const userId of [SPARSE, DENSE]) {
    it(`reads the slice's seven-day mean (${userId})`, async () => {
      const [means, slice] = await Promise.all([
        readSevenDayMeans(userId),
        computeSummariesSlice(userId),
      ]);
      const withData = Object.keys(means);
      expect(withData.length).toBeGreaterThan(0);
      for (const type of withData) {
        expect(means[type], type).toBe(slice.summaries[type]?.avg7 ?? null);
      }
    });
  }
});
