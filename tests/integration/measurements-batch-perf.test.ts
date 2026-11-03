/**
 * `POST /api/measurements/batch` under a realistic large batch.
 *
 * Production saw this route take 2 s and more, up to 15 s, on full
 * 500-entry uploads. The cost was one interactive reconciler transaction
 * (about ten round trips) per fresh sample. Since v1.44 fresh samples land
 * through a set-based `INSERT … ON CONFLICT DO NOTHING` and only rows that
 * hit an existing identity reach the reconciler.
 *
 * This suite pins the shape of the work rather than a machine's speed:
 *   - a fresh 500-entry batch opens a handful of transactions, not 500;
 *   - a re-post of the same batch opens none (the duplicate prefilter);
 *   - the rollup leg runs once per request, not once per row;
 *   - the wall-clock bound is generous, a tripwire for a regression back to
 *     per-row work, not a benchmark.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const TEST_USER_ID = "user-batch-perf-test";

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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

const rollupCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/rollups/after-measurement-mutation", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/rollups/after-measurement-mutation")
  >("@/lib/rollups/after-measurement-mutation");
  return {
    ...actual,
    afterMeasurementMutation: (
      ...args: Parameters<typeof actual.afterMeasurementMutation>
    ) => {
      rollupCalls.count += 1;
      return actual.afterMeasurementMutation(...args);
    },
  };
});

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  rollupCalls.count = 0;
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "batch-perf",
      email: "batch-perf@example.test",
      timezone: "Europe/Berlin",
    },
  });
  const session = await getPrismaClient().session.create({
    data: {
      userId: TEST_USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
});

/**
 * What a phone sends after a day offline: dense heart rate, a few HRV and
 * oxygen readings, a night of sleep stages, and the day's cumulative totals.
 */
function realisticBatch(dayOffset = 2): Array<Record<string, unknown>> {
  const day = new Date(Date.now() - dayOffset * 86_400_000);
  day.setUTCHours(0, 0, 0, 0);
  const at = (minutes: number) =>
    new Date(day.getTime() + minutes * 60_000).toISOString();
  const entries: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 400; i++) {
    entries.push({
      hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
      value: 55 + (i % 40),
      unit: "count/min",
      startDate: at(i * 3),
      endDate: at(i * 3),
      externalId: `perf-hr-${dayOffset}-${i}`,
    });
  }
  for (let i = 0; i < 40; i++) {
    entries.push({
      hkIdentifier: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
      value: 30 + i,
      unit: "ms",
      startDate: at(i * 30 + 1),
      endDate: at(i * 30 + 1),
      externalId: `perf-hrv-${dayOffset}-${i}`,
    });
    entries.push({
      hkIdentifier: "HKQuantityTypeIdentifierOxygenSaturation",
      value: 0.96,
      unit: "%",
      startDate: at(i * 30 + 2),
      endDate: at(i * 30 + 2),
      externalId: `perf-spo2-${dayOffset}-${i}`,
    });
  }
  for (let i = 0; i < 16; i++) {
    entries.push({
      hkIdentifier: "HKCategoryTypeIdentifierSleepAnalysis",
      value: 30,
      unit: "min",
      startDate: at(-480 + i * 30),
      endDate: at(-450 + i * 30),
      externalId: `perf-sleep-${dayOffset}-${i}`,
      sleepStage: 3 + (i % 3),
    });
  }
  const dayKey = day.toISOString().slice(0, 10);
  for (const [hk, unit, value] of [
    ["HKQuantityTypeIdentifierStepCount", "count", 9_431],
    ["HKQuantityTypeIdentifierActiveEnergyBurned", "kcal", 512],
    ["HKQuantityTypeIdentifierAppleExerciseTime", "min", 42],
    ["HKQuantityTypeIdentifierAppleStandTime", "min", 180],
  ] as const) {
    entries.push({
      hkIdentifier: hk,
      value,
      unit,
      startDate: at(0),
      endDate: at(18 * 60),
      externalId: `stats:${hk}:${dayKey}`,
    });
  }
  return entries;
}

async function post(entries: Array<Record<string, unknown>>) {
  const { POST } = await import("@/app/api/measurements/batch/route");
  const res = await POST(
    new NextRequest("http://localhost/api/measurements/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries }),
    }),
  );
  expect(res.status).toBe(200);
  return (
    (await res.json()) as {
      data: {
        inserted: number;
        updated: number;
        duplicates: number;
        failed: number;
        skipped: number;
      };
    }
  ).data;
}

describe("POST /api/measurements/batch — large-batch cost (real Postgres)", () => {
  it("writes a fresh 500-entry batch in a handful of transactions", async () => {
    const { prisma } = await import("@/lib/db");
    const entries = realisticBatch();
    expect(entries).toHaveLength(500);

    const transaction = vi.spyOn(prisma, "$transaction");
    const started = performance.now();
    const result = await post(entries);
    const elapsedMs = performance.now() - started;
    const transactions = transaction.mock.calls.length;
    transaction.mockRestore();

    expect(result.failed).toBe(0);
    expect(result.inserted).toBe(500);
    // Two set statements (250 rows each) plus the hour-bucket and checkpoint
    // writes. Before v1.44 this was one transaction per row: 500.
    expect(transactions).toBeLessThanOrEqual(10);
    expect(rollupCalls.count).toBe(1);
    expect(
      await getPrismaClient().measurement.count({
        where: { userId: TEST_USER_ID },
      }),
    ).toBe(500);
    // A tripwire, not a benchmark: per-row work on a local container sits
    // well above this, the set path well below.
    expect(elapsedMs).toBeLessThan(10_000);
    console.info(
      `[batch-perf] fresh 500: ${Math.round(elapsedMs)} ms, ${transactions} transactions`,
    );
  });

  it("answers a re-post of the same batch without a transaction", async () => {
    const { prisma } = await import("@/lib/db");
    const entries = realisticBatch();
    await post(entries);
    rollupCalls.count = 0;

    const transaction = vi.spyOn(prisma, "$transaction");
    const started = performance.now();
    const result = await post(entries);
    const elapsedMs = performance.now() - started;
    const transactions = transaction.mock.calls.length;
    transaction.mockRestore();

    // The four `stats:` rows carry overwrite semantics and reconcile; every
    // sample is an exact duplicate and never reaches a transaction.
    expect(result.inserted).toBe(0);
    expect(result.duplicates + result.updated).toBe(500);
    expect(transactions).toBeLessThanOrEqual(8);
    expect(elapsedMs).toBeLessThan(10_000);
    console.info(
      `[batch-perf] re-post 500: ${Math.round(elapsedMs)} ms, ${transactions} transactions`,
    );
  });

  it("keeps the set path's verdicts when the batch overlaps stored rows", async () => {
    const entries = realisticBatch();
    await post(entries.slice(0, 250));
    // Move half of the stored heart-rate rows: same id, another instant.
    const moved = entries.slice(0, 100).map((e) => ({
      ...e,
      startDate: new Date(
        Date.parse(e.endDate as string) + 1_000,
      ).toISOString(),
      endDate: new Date(Date.parse(e.endDate as string) + 1_000).toISOString(),
    }));
    const result = await post([...moved, ...entries.slice(250)]);
    expect(result.failed).toBe(0);
    expect(result.updated).toBeGreaterThanOrEqual(100);
    expect(result.inserted).toBe(250);
    expect(
      await getPrismaClient().measurement.count({
        where: { userId: TEST_USER_ID, deletedAt: null },
      }),
    ).toBe(500);
  });
});
