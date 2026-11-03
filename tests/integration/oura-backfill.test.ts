/**
 * The Oura history backfill against the real schema.
 *
 * Oura's API is replaced at the `safeFetch` seam by a generator that builds
 * each page on request: a year and a half of daily activity, one workout, and
 * a heart-rate reading every five minutes over the same span (some 160 000
 * samples, in pages of 1 000). The backfill runs slice after slice, each one
 * cut short by its budget, until it stamps its marker. What is pinned:
 *
 *   - it reaches the end: every heart-rate sample is a PULSE row, every day a
 *     steps row, the workout a Workout row, the marker is stamped, and the
 *     legacy equivalent-distance rows are retired with their rollup day;
 *   - it resumes: no window is read twice across slices, apart from the one
 *     window a 429 interrupted, and that slice sends the next one after the
 *     Retry-After the 429 named;
 *   - it does not grow with the history: the collected heap after the first
 *     quarter of heart-rate pages stays inside a budget a collect-everything
 *     walk of the same pages passes several times over;
 *   - discovery offers an existing connection without a reconnect, and an
 *     account that kept only the legacy rows, and nothing already stamped.
 */
import v8 from "node:v8";
import vm from "node:vm";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const USER = "oura-backfill-owner";
const DAY_MS = 24 * 60 * 60 * 1000;
/** The day the backfill begins, and the end of the generated history. */
const ANCHOR = "2026-10-01";
const NOW = Date.parse(`${ANCHOR}T12:00:00Z`);
/** The first day of the generated history. */
const HISTORY_FROM = "2025-04-01";
const HR_FROM = Date.parse(`${HISTORY_FROM}T00:00:00Z`);
const HR_STEP = 5 * 60_000;
const HR_PAGE = 1000;
const HR_TOTAL = Math.floor((NOW - HR_FROM) / HR_STEP);

const GROWTH_BUDGET_BYTES = 24 * 1024 * 1024;

const fake = vi.hoisted(() => ({
  requests: [] as string[],
  heartRatePages: 0,
  /** Answer the next heart-rate page with a 429 once this many have been served. */
  rateLimitAtPage: -1,
  onPage: null as (() => void) | null,
  /** Collections answered with a 401 naming their scope. */
  denied: new Set<string>(),
  sends: [] as Array<{ queue: string; payload: unknown; options: unknown }>,
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({
    send: async (queue: string, payload: unknown, options: unknown) => {
      fake.sends.push({ queue, payload, options });
      return `job-${fake.sends.length}`;
    },
  }),
}));

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  const json = (body: unknown, status = 200, headers = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  return {
    ...actual,
    // A plain function, not `vi.fn`: a mock records every result, and the
    // results here are whole pages.
    safeFetch: async (url: string) => {
      const u = new URL(url);
      const p = u.searchParams;
      const collection = u.pathname.split("/").pop()!;
      const token = p.get("next_token");
      fake.requests.push(
        `${collection}|${p.get("start_date") ?? p.get("start_datetime")}|${p.get("end_date") ?? p.get("end_datetime")}|${token ?? ""}`,
      );
      if (fake.denied.has(collection)) {
        return json(
          { detail: `Token is not authorized access ${collection} scope.` },
          401,
        );
      }
      if (collection === "heartrate") {
        if (fake.rateLimitAtPage === fake.heartRatePages) {
          fake.rateLimitAtPage = -1;
          return json({ detail: "Too many requests" }, 429, {
            "retry-after": "600",
          });
        }
        const start = Date.parse(p.get("start_datetime")!);
        const end = Date.parse(p.get("end_datetime")!);
        const first = Math.max(0, Math.ceil((start - HR_FROM) / HR_STEP));
        const last = Math.min(HR_TOTAL, Math.ceil((end - HR_FROM) / HR_STEP));
        const from = first + Number(token ?? 0) * HR_PAGE;
        const to = Math.min(last, from + HR_PAGE);
        const data = [];
        for (let i = from; i < to; i++) {
          data.push({
            bpm: 52 + (i % 40),
            source: "awake",
            timestamp: new Date(HR_FROM + i * HR_STEP).toISOString(),
          });
        }
        fake.heartRatePages++;
        fake.onPage?.();
        return json({
          data,
          next_token: to < last ? String(Number(token ?? 0) + 1) : null,
        });
      }
      if (collection === "daily_activity") {
        const from =
          p.get("start_date")! < HISTORY_FROM
            ? HISTORY_FROM
            : p.get("start_date")!;
        const to = p.get("end_date")! > ANCHOR ? ANCHOR : p.get("end_date")!;
        const data = [];
        for (
          let t = Date.parse(`${from}T00:00:00Z`);
          dayKey(t) <= to;
          t += DAY_MS
        ) {
          data.push({
            id: `act-${dayKey(t)}`,
            day: dayKey(t),
            steps: 5000,
            active_calories: 300,
            equivalent_walking_distance: 4000,
          });
        }
        return json({ data, next_token: null });
      }
      if (collection === "workout") {
        const day = "2026-02-14";
        const inRange =
          p.get("start_date")! <= day && day <= p.get("end_date")!;
        return json({
          data: inRange
            ? [
                {
                  id: "oura-workout-1",
                  activity: "cycling",
                  calories: 410,
                  distance: 15000,
                  intensity: "moderate",
                  source: "manual",
                  day,
                  start_datetime: `${day}T08:00:00+00:00`,
                  end_datetime: `${day}T09:00:00+00:00`,
                },
              ]
            : [],
          next_token: null,
        });
      }
      return json({ data: [], next_token: null });
    },
  };
});

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

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  fake.requests = [];
  fake.heartRatePages = 0;
  fake.rateLimitAtPage = -1;
  fake.sends = [];
  fake.denied = new Set();
  const { encrypt } = await import("@/lib/crypto");
  await prisma.user.create({
    data: {
      id: USER,
      username: USER,
      timezone: "UTC",
      ouraAccessTokenEncrypted: encrypt("access"),
      ouraRefreshTokenEncrypted: encrypt("refresh"),
    },
  });
}, 120_000);

/** Seed the rows an earlier sync wrote from the equivalent distance. */
async function seedLegacyDistance(userId: string): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.measurement.createMany({
    data: [
      {
        userId,
        type: "WALKING_RUNNING_DISTANCE",
        source: "OURA",
        value: 4000,
        unit: "m",
        measuredAt: new Date("2026-09-01T12:00:00Z"),
        externalId: "activity:2026-09-01:distance",
      },
      {
        userId,
        type: "WALKING_RUNNING_DISTANCE",
        source: "OURA",
        value: 5200,
        unit: "m",
        measuredAt: new Date("2026-09-02T12:00:00Z"),
        externalId: "activity:2026-09-02:distance",
      },
      // Another source's distance on the same day stays.
      {
        userId,
        type: "WALKING_RUNNING_DISTANCE",
        source: "APPLE_HEALTH",
        value: 3100,
        unit: "m",
        measuredAt: new Date("2026-09-01T18:00:00Z"),
        externalId: "hk-dist-1",
      },
    ],
  });
}

describe("retireOuraEquivalentDistance", () => {
  it("soft-deletes only the OURA equivalent-distance rows and refolds the day", async () => {
    const prisma = getPrismaClient();
    await seedLegacyDistance(USER);
    const { recomputeBucketsForMeasurement } =
      await import("@/lib/rollups/measurement-rollups");
    await recomputeBucketsForMeasurement(
      USER,
      "WALKING_RUNNING_DISTANCE",
      new Date("2026-09-01T12:00:00Z"),
    );
    const ouraDay = () =>
      prisma.measurementRollup.findFirst({
        where: {
          userId: USER,
          type: "WALKING_RUNNING_DISTANCE",
          granularity: "DAY",
          source: "OURA",
          bucketStart: new Date("2026-09-01T00:00:00Z"),
        },
      });
    expect((await ouraDay())?.count).toBe(1);

    const { retireOuraEquivalentDistance } =
      await import("@/lib/oura/retire-distance");
    expect(await retireOuraEquivalentDistance(USER)).toBe(2);
    expect(await retireOuraEquivalentDistance(USER)).toBe(0);

    const live = await prisma.measurement.findMany({
      where: { userId: USER, deletedAt: null },
      select: { source: true, externalId: true },
    });
    expect(live).toEqual([{ source: "APPLE_HEALTH", externalId: "hk-dist-1" }]);
    const after = await ouraDay();
    expect(after?.count ?? 0).toBe(0);
  });
});

describe("Oura history backfill", () => {
  it("walks the whole history in resumable slices with bounded memory", async () => {
    const prisma = getPrismaClient();
    await seedLegacyDistance(USER);
    const { runOuraBackfillForUser } = await import("@/lib/jobs/oura-backfill");

    // A rate limit in the middle of the heart-rate walk.
    fake.rateLimitAtPage = 40;

    let clock = NOW;
    const now = () => (clock += 1000);
    const quarter = Math.ceil(HR_TOTAL / HR_PAGE / 4);
    let anchor: number | null = null;
    let peak = 0;
    let samples = 0;
    fake.onPage = () => {
      if (fake.heartRatePages % 5 !== 0) return;
      const live = liveHeapBytes();
      if (anchor === null) {
        if (fake.heartRatePages >= quarter) anchor = peak = live;
        return;
      }
      samples++;
      peak = Math.max(peak, live);
    };

    let slice = 0;
    let continued = true;
    let slices = 0;
    try {
      while (continued) {
        const run = await runOuraBackfillForUser(USER, () => false, slice, {
          sliceMs: 40_000,
          now,
        });
        continued = run.continued;
        slice += 1;
        slices += 1;
        expect(slices).toBeLessThan(200);
      }
    } finally {
      fake.onPage = null;
    }
    process.stderr.write(
      `[oura-backfill] slices=${slices} hrPages=${fake.heartRatePages} growth=${((peak - (anchor ?? 0)) / 1024 / 1024).toFixed(1)} MB over ${samples} samples\n`,
    );

    // It ran in many slices, and finished.
    expect(slices).toBeGreaterThan(5);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: USER },
      select: { ouraBackfillCompletedAt: true, ouraBackfillProgress: true },
    });
    expect(user.ouraBackfillCompletedAt).not.toBeNull();
    const progress = user.ouraBackfillProgress as {
      historyStart: string;
      distanceRetired: boolean;
    };
    expect(progress.historyStart).toBe(HISTORY_FROM);
    expect(progress.distanceRetired).toBe(true);

    // Every heart-rate sample, every day, the workout.
    expect(
      await prisma.measurement.count({
        where: { userId: USER, type: "PULSE", source: "OURA" },
      }),
    ).toBe(HR_TOTAL);
    const days =
      (Date.parse(`${ANCHOR}T00:00:00Z`) -
        Date.parse(`${HISTORY_FROM}T00:00:00Z`)) /
        DAY_MS +
      1;
    expect(
      await prisma.measurement.count({
        where: { userId: USER, type: "ACTIVITY_STEPS", source: "OURA" },
      }),
    ).toBe(days);
    const workouts = await prisma.workout.findMany({
      where: { userId: USER, source: "OURA" },
      select: { externalId: true, sportType: true, totalDistanceM: true },
    });
    expect(workouts).toEqual([
      {
        externalId: "oura-workout-1",
        sportType: "cycling",
        totalDistanceM: 15000,
      },
    ]);
    // No equivalent distance written, and the legacy rows retired.
    expect(
      await prisma.measurement.count({
        where: {
          userId: USER,
          source: "OURA",
          type: "WALKING_RUNNING_DISTANCE",
          deletedAt: null,
        },
      }),
    ).toBe(0);

    // Resumed, never restarted: every first page of a window was asked for
    // once, apart from the heart-rate window the 429 interrupted.
    const firstPages = fake.requests.filter((r) => r.endsWith("|"));
    const repeated = firstPages.filter((r, i) => firstPages.indexOf(r) !== i);
    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatch(/^heartrate\|/);
    // The slice the 429 ended sent the next one after the wait it named.
    const delays = fake.sends.map(
      (s) => (s.options as { startAfter?: number }).startAfter ?? 0,
    );
    expect(delays).toContain(600);

    // Bounded: the heap after the first quarter of the stream stays flat.
    expect(samples).toBeGreaterThan(5);
    expect(peak - anchor!).toBeLessThan(GROWTH_BUDGET_BYTES);
  }, 900_000);

  it("leaves an existing connection's history to discovery, no reconnect needed", async () => {
    const prisma = getPrismaClient();
    // An account whose Oura connection is gone but whose legacy rows stay.
    await prisma.user.create({
      data: { id: "oura-legacy-only", username: "oura-legacy-only" },
    });
    await seedLegacyDistance("oura-legacy-only");
    // An account already backfilled.
    await prisma.user.create({
      data: {
        id: "oura-done",
        username: "oura-done",
        ouraAccessTokenEncrypted: "x",
        ouraRefreshTokenEncrypted: "y",
        ouraBackfillCompletedAt: new Date(),
      },
    });
    const { enqueueBootTimeOuraBackfill, runOuraBackfillForUser } =
      await import("@/lib/jobs/oura-backfill");

    const result = await enqueueBootTimeOuraBackfill(30);
    expect(result).toEqual({ enqueued: 2, skipped: 0, error: null });
    expect(
      fake.sends.map((s) => (s.payload as { userId: string }).userId).sort(),
    ).toEqual(["oura-backfill-owner", "oura-legacy-only"]);

    // The legacy-only account retires its rows and is stamped at once.
    await runOuraBackfillForUser("oura-legacy-only");
    const legacy = await prisma.user.findUniqueOrThrow({
      where: { id: "oura-legacy-only" },
      select: { ouraBackfillCompletedAt: true },
    });
    expect(legacy.ouraBackfillCompletedAt).not.toBeNull();
    expect(
      await prisma.measurement.count({
        where: { userId: "oura-legacy-only", source: "OURA", deletedAt: null },
      }),
    ).toBe(0);
  });

  it("finishes past a collection the grant refuses, and asks again after a reconnect", async () => {
    const prisma = getPrismaClient();
    const { OURA_BACKFILL_ORDER, runOuraBackfillForUser } =
      await import("@/lib/jobs/oura-backfill");
    // Everything but workouts already walked.
    await prisma.user.update({
      where: { id: USER },
      data: {
        ouraBackfillProgress: {
          anchor: ANCHOR,
          historyStart: "2026-01-01",
          distanceRetired: true,
          collections: Object.fromEntries(
            OURA_BACKFILL_ORDER.filter((n) => n !== "workout").map((n) => [
              n,
              { before: "2015-01-01", done: true },
            ]),
          ),
        },
      },
    });
    fake.denied.add("workout");

    expect(await runOuraBackfillForUser(USER)).toEqual({
      imported: 0,
      continued: false,
    });
    let user = await prisma.user.findUniqueOrThrow({
      where: { id: USER },
      select: { ouraBackfillCompletedAt: true, ouraBackfillProgress: true },
    });
    expect(user.ouraBackfillCompletedAt).not.toBeNull();
    expect(
      (user.ouraBackfillProgress as { collections: Record<string, unknown> })
        .collections.workout,
    ).toEqual({ before: ANCHOR, denied: true });
    // One request found it out; nothing was recorded as a failure.
    expect(fake.requests.filter((r) => r.startsWith("workout|"))).toHaveLength(
      1,
    );
    expect(await prisma.integrationStatus.count()).toBe(0);

    // A reconnect that grants the scope clears the stamp; the next chain
    // reads workouts and nothing else.
    fake.denied.clear();
    fake.requests = [];
    await prisma.user.update({
      where: { id: USER },
      data: { ouraBackfillCompletedAt: null },
    });
    await runOuraBackfillForUser(USER);
    user = await prisma.user.findUniqueOrThrow({
      where: { id: USER },
      select: { ouraBackfillCompletedAt: true, ouraBackfillProgress: true },
    });
    expect(user.ouraBackfillCompletedAt).not.toBeNull();
    expect(new Set(fake.requests.map((r) => r.split("|")[0]))).toEqual(
      new Set(["workout"]),
    );
    expect(
      await prisma.workout.count({ where: { userId: USER, source: "OURA" } }),
    ).toBe(1);
  });
});
