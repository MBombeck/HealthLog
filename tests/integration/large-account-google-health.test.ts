/**
 * A large Google Health account end to end (#1297, #1298).
 *
 * One account with a dense heart-rate history, written through the real
 * Google Health backfill (Google's API replaced at the `safeFetch` seam, as in
 * `google-health-dense-backfill-memory.test.ts`), then taken through what a
 * self-hosted instance with such an account went through:
 *
 *   1. The account's DAY rollups lose their reading extremes, as rows folded
 *      before migration 0417 have them. The boot discovery finds the account,
 *      and the full backfill, a calendar year per pass with every statement
 *      under its own limit, refills every bucket inside the fold window.
 *   2. The dense fold thins the heart rate older than the retention window to
 *      hourly `stats:` rows of Google Health, and the DAY rollups keep the
 *      figures they had from the raw samples.
 *   3. A second full-history backfill over the same samples inserts nothing:
 *      the folded hours are not written again.
 *
 * Each step reports its duration on stderr (`[large-account]`); the size is
 * `POINTS` readings, one every five minutes, about four years.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Job } from "pg-boss";

import { Prisma } from "@/generated/prisma/client";

import { getPrismaClient, truncateAllTables } from "./setup";

const USER = "large-account-google-health";
const POINTS = 420_000;
const STEP_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

const fake = vi.hoisted(() => ({ total: 0, now: 0 }));

vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return {
    ...actual,
    safeFetch: async (url: string) => {
      const u = new URL(url);
      let body: unknown = {};
      if (u.pathname.endsWith("/dataTypes/heart-rate/dataPoints")) {
        const pageSize = Number(u.searchParams.get("pageSize") ?? 1000);
        const page = Number(u.searchParams.get("pageToken") ?? 0);
        const end = Math.min(fake.total, (page + 1) * pageSize);
        const dataPoints = [];
        for (let g = page * pageSize; g < end; g++) {
          dataPoints.push({
            name: `users/me/dataTypes/heart-rate/dataPoints/${8_000_000_000_000 + g}`,
            dataSource: {
              recordingMethod: "PASSIVE_MEASUREMENT",
              device: { manufacturer: "Google", displayName: "Watch" },
              platform: "FITBIT",
            },
            heartRate: {
              beatsPerMinute: String(52 + ((g * 7) % 61)),
              sampleTime: {
                physicalTime: new Date(fake.now - g * STEP_MS).toISOString(),
              },
            },
          });
        }
        body = {
          dataPoints,
          ...(end < fake.total ? { nextPageToken: String(page + 1) } : {}),
        };
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

import { getGlobalBoss } from "@/lib/jobs/boss-instance";

const prisma = getPrismaClient();

function report(line: string): void {
  process.stderr.write(`[large-account] ${line}\n`);
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const result = await fn();
  report(`${label}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return result;
}

async function backfillToTheEnd(): Promise<number> {
  const { runGoogleHealthBackfillForUser } =
    await import("@/lib/jobs/google-health-backfill");
  let imported = 0;
  for (let slice = 0; slice < 20; slice++) {
    // One slice for the whole stream: Google's API is faked here, and
    // the slice budget is not what this file is about.
    const result = await runGoogleHealthBackfillForUser(
      USER,
      () => false,
      slice,
      { sliceMs: 1_800_000, slicePages: 100_000 },
    );
    imported += result.imported;
    const connection = await prisma.googleHealthConnection.findUniqueOrThrow({
      where: { userId: USER },
      select: { backfillCompletedAt: true },
    });
    if (connection.backfillCompletedAt !== null) return imported;
  }
  throw new Error("the backfill never completed");
}

function pulseRows(where: Prisma.MeasurementWhereInput = {}) {
  return prisma.measurement.count({
    where: {
      userId: USER,
      type: "PULSE",
      source: "GOOGLE_HEALTH",
      deletedAt: null,
      ...where,
    },
  });
}

async function dayPulseRollups() {
  return prisma.measurementRollup.findMany({
    where: { userId: USER, type: "PULSE", granularity: "DAY" },
    select: {
      bucketStart: true,
      source: true,
      count: true,
      minValue: true,
      maxValue: true,
      mean: true,
      readingMinValue: true,
      readingMaxValue: true,
    },
    orderBy: [{ bucketStart: "asc" }, { source: "asc" }],
  });
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  const { encrypt } = await import("@/lib/crypto");
  await prisma.user.create({
    data: { id: USER, username: USER, timezone: "Europe/Berlin" },
  });
  await prisma.googleHealthConnection.create({
    data: {
      userId: USER,
      googleUserId: `google-${USER}`,
      accessToken: encrypt("access"),
      refreshToken: encrypt("refresh"),
      tokenExpiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  fake.total = POINTS;
  fake.now = Date.now() - 3_600_000;
}, 120_000);

afterAll(async () => {
  await truncateAllTables(prisma);
});

describe("a large Google Health account (#1297, #1298)", () => {
  it("backfills, refills the reading extremes, folds, and does not take folded samples back", async () => {
    // ── The history arrives ───────────────────────────────────────────
    const imported = await timed("backfill", backfillToTheEnd);
    expect(imported).toBe(POINTS);
    expect(await pulseRows()).toBe(POINTS);

    // ── Rows folded before 0417 ───────────────────────────────────────
    await prisma.$executeRaw`
      UPDATE measurement_rollups
      SET reading_min_value = NULL, reading_max_value = NULL
      WHERE user_id = ${USER}
    `;
    const { enqueueBootTimeRollupBackfill, ROLLUP_FULL_BACKFILL_QUEUE } =
      await import("@/lib/rollups/full-backfill");
    const send = vi.fn(async () => "job-id");
    vi.mocked(getGlobalBoss).mockReturnValue({ send } as never);
    const discovery = await timed("discovery", () =>
      enqueueBootTimeRollupBackfill(),
    );
    vi.mocked(getGlobalBoss).mockReturnValue(null as never);
    expect(discovery).toMatchObject({ enqueued: 1, error: null });

    const { handleRollupFullBackfill } =
      await import("@/lib/jobs/reminder/rollup-handlers");
    const job = {
      id: "full-backfill",
      name: ROLLUP_FULL_BACKFILL_QUEUE,
      data: { userId: USER, enqueuedAt: new Date().toISOString() },
      expireInSeconds: 3600,
      signal: new AbortController().signal,
    } as unknown as Job<{ userId: string; enqueuedAt: string }>;
    const outcome = await timed("full backfill", () =>
      handleRollupFullBackfill([job]),
    );
    expect(outcome.ok).toBe(true);

    const { ROLLUP_FOLD_WINDOW_MS } =
      await import("@/lib/rollups/measurement-rollups");
    const floor = new Date(Date.now() - ROLLUP_FOLD_WINDOW_MS);
    const before = await dayPulseRollups();
    expect(before.length).toBeGreaterThan(1000);
    expect(
      before.filter(
        (r) =>
          r.bucketStart >= floor &&
          (r.readingMinValue === null || r.readingMaxValue === null),
      ),
    ).toEqual([]);
    // The extremes are the raw readings' own.
    const raw = await prisma.$queryRaw<
      Array<{ day: Date; min: number; max: number }>
    >`
      SELECT date_trunc('day', measured_at) AS day,
             MIN(value)::double precision AS min,
             MAX(value)::double precision AS max
      FROM measurements
      WHERE user_id = ${USER} AND type = 'PULSE' AND deleted_at IS NULL
      GROUP BY 1
    `;
    const rawByDay = new Map(raw.map((r) => [r.day.getTime(), r]));
    for (const row of before) {
      const day = rawByDay.get(row.bucketStart.getTime());
      expect(day).toBeDefined();
      expect(row.readingMinValue).toBe(day!.min);
      expect(row.readingMaxValue).toBe(day!.max);
    }

    // ── The fold thins the old samples ────────────────────────────────
    const { runDenseIntradayRetention, DENSE_INTRADAY_RETENTION_DAYS } =
      await import("@/lib/measurements/dense-intraday-retention");
    const summary = await timed("dense fold", () =>
      runDenseIntradayRetention(prisma, { userId: USER, log: () => {} }),
    );
    expect(summary.stoppedEarly).toBe(false);
    const retained = new Date(
      Date.now() - (DENSE_INTRADAY_RETENTION_DAYS + 2) * DAY_MS,
    );
    const rawOld = await pulseRows({
      measuredAt: { lt: retained },
      NOT: { externalId: { startsWith: "stats:" } },
    });
    const hourlyOld = await pulseRows({
      measuredAt: { lt: retained },
      externalId: { startsWith: "stats:" },
    });
    const afterFold = await pulseRows();
    report(
      `rows: ${POINTS} raw → ${afterFold} after the fold (${hourlyOld} hourly rows before the window)`,
    );
    expect(rawOld).toBe(0);
    // At most one hourly row per hour, twelve samples an hour before.
    expect(hourlyOld).toBeGreaterThan(0);
    expect(afterFold).toBeLessThan(POINTS / 5);

    // The DAY tier keeps the figures it took from the raw samples.
    const after = await dayPulseRollups();
    expect(after.map((r) => r.bucketStart.getTime())).toEqual(
      before.map((r) => r.bucketStart.getTime()),
    );
    after.forEach((row, i) => {
      expect(row.count).toBe(before[i].count);
      expect(row.minValue).toBe(before[i].minValue);
      expect(row.maxValue).toBe(before[i].maxValue);
      expect(row.readingMinValue).toBe(before[i].readingMinValue);
      expect(row.mean).toBeCloseTo(before[i].mean, 6);
    });

    // ── A second full-history backfill over the same samples ──────────
    await prisma.googleHealthConnection.update({
      where: { userId: USER },
      data: {
        backfillCompletedAt: null,
        backfillProgress: Prisma.DbNull,
      },
    });
    const again = await timed("second backfill", backfillToTheEnd);
    expect(again).toBe(0);
    expect(await pulseRows()).toBe(afterFold);
  }, 1_800_000);
});
