/**
 * Correlation-discovery rollup read-swap — DB round trip.
 *
 * The unit battery
 * (`src/lib/insights/__tests__/correlation-channel-series-rollup-swap.test.ts`)
 * derives rollup fixtures in JS; this suite proves the SAME parity through
 * the real pipe: seed raw measurements, fold them with the real rollup
 * writer (`recomputeUserRollups` — the Postgres `AVG` / `SUM` / `COUNT`
 * grouped per `(type, day, source)`), then read the tiered fetch twice —
 * once BEFORE the fold (coverage probe misses → raw path) and once AFTER
 * (DAY buckets serve) — and assert the two daily series are equivalent.
 * A drifted writer projection, coverage-probe SQL, or bucket compose all
 * surface here instead of in production.
 *
 * Fixtures are now-anchored (never fixed calendar dates) and pinned to
 * mid-day UTC wall times, so the UTC bucket day and the Europe/Berlin
 * profile day agree by construction and the suite cannot age out.
 *
 * Watched-red record: skewing `composeRollupDailyMeans` (`acc.sum += sum
 * + 1`) failed the post-fold parity assertions here naming the composed
 * values; restored green.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";
import { fetchMeasurementDailySeriesTiered } from "@/lib/insights/correlation-channel-series";

// The DAY-only recompute never touches pg-boss; leave the boss detached for
// parity with the sibling rollup suites (`isolate: false` shares the mock).
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

/** Now-anchored instant: `daysAgo` days back, pinned to a UTC wall time. */
function at(daysAgo: number, hourUtc: number, minute = 0): Date {
  const d = new Date(Date.now() - daysAgo * DAY_MS);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d;
}

let seq = 0;
async function seedUser(prisma: ReturnType<typeof getPrismaClient>) {
  seq += 1;
  return prisma.user.create({
    data: {
      username: `corr-rollup-swap-${seq}`,
      email: `corr-rollup-swap-${seq}@example.test`,
      role: "USER",
      timezone: "Europe/Berlin",
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("correlations rollup swap — real writer round trip", () => {
  it("serves the same daily series from the folded DAY buckets as from the raw rows", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser(prisma);
    const since = new Date(Date.now() - 30 * DAY_MS);
    const types = [
      "RESTING_HEART_RATE",
      "WEIGHT",
      "BLOOD_GLUCOSE",
    ] as const satisfies readonly string[];

    await prisma.measurement.createMany({
      data: [
        // RHR — two readings on one day (day-mean collapse), one on another.
        {
          userId: user.id,
          type: "RESTING_HEART_RATE",
          value: 55,
          unit: "bpm",
          source: "APPLE_HEALTH",
          measuredAt: at(10, 8),
        },
        {
          userId: user.id,
          type: "RESTING_HEART_RATE",
          value: 61,
          unit: "bpm",
          source: "APPLE_HEALTH",
          measuredAt: at(10, 18),
        },
        {
          userId: user.id,
          type: "RESTING_HEART_RATE",
          value: 58,
          unit: "bpm",
          source: "APPLE_HEALTH",
          measuredAt: at(8, 9),
        },
        // WEIGHT — a dual-source day: the discovery series is the ALL-source
        // mean (81.0), which the reader must compose across the two
        // per-source rollup rows the writer mints.
        {
          userId: user.id,
          type: "WEIGHT",
          value: 80.4,
          unit: "kg",
          source: "APPLE_HEALTH",
          measuredAt: at(7, 7),
        },
        {
          userId: user.id,
          type: "WEIGHT",
          value: 81.6,
          unit: "kg",
          source: "WITHINGS",
          measuredAt: at(7, 7, 30),
        },
        // GLUCOSE — several readings across a day.
        {
          userId: user.id,
          type: "BLOOD_GLUCOSE",
          value: 92,
          unit: "mg/dL",
          source: "MANUAL",
          measuredAt: at(5, 8),
        },
        {
          userId: user.id,
          type: "BLOOD_GLUCOSE",
          value: 118,
          unit: "mg/dL",
          source: "MANUAL",
          measuredAt: at(5, 13),
        },
        {
          userId: user.id,
          type: "BLOOD_GLUCOSE",
          value: 101,
          unit: "mg/dL",
          source: "MANUAL",
          measuredAt: at(5, 19),
        },
      ],
    });

    // BEFORE the fold: the coverage probe finds no DAY buckets, so every
    // channel takes the raw path — this is the pre-swap behaviour baseline.
    const viaRaw = await fetchMeasurementDailySeriesTiered(
      user.id,
      "Europe/Berlin",
      since,
      [...types],
    );
    expect(viaRaw.rollupTypes).toEqual([]);

    // Fold with the REAL writer (per-source DAY rows via Postgres AVG/SUM).
    await recomputeUserRollups(user.id, { granularities: ["DAY"] });

    const viaRollup = await fetchMeasurementDailySeriesTiered(
      user.id,
      "Europe/Berlin",
      since,
      [...types],
    );
    expect(viaRollup.rollupTypes.sort()).toEqual([...types].sort());

    for (const type of types) {
      const rawSeries = viaRaw.byType.get(type)!;
      const rollupSeries = viaRollup.byType.get(type)!;
      expect(rollupSeries.map((p) => p.day)).toEqual(
        rawSeries.map((p) => p.day),
      );
      rollupSeries.forEach((p, i) =>
        expect(p.value).toBeCloseTo(rawSeries[i].value, 10),
      );
    }

    // Anchor the dual-source WEIGHT day explicitly: all-source mean, never
    // a ladder-collapsed single source's value.
    const weightDay = viaRollup.byType.get("WEIGHT")!;
    expect(weightDay).toHaveLength(1);
    expect(weightDay[0].value).toBeCloseTo(81.0, 10);
  });
});
