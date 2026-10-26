/**
 * pg-boss queue registration for the nightly drain of per-sample
 * APPLE_HEALTH cumulative rows. The drain helper once ran only via the admin
 * endpoint / CLI; the scheduled wrapper closes the loop so the list view
 * stops painting hundreds of step chunks per day.
 *
 * Reads the worker registry (the queue, its cron and its binding) and runs
 * the bound handler against mocked passes, so pg-boss and Prisma never boot.
 */
import { describe, expect, it, vi } from "vitest";

const drainPerSampleCumulative = vi.hoisted(() =>
  vi.fn(async () => ({
    stoppedEarly: false,
    totals: {
      usersScanned: 0,
      bucketsCollapsed: 0,
      perSampleRowsDeleted: 0,
      dailyRowsUpserted: 0,
    },
  })),
);
vi.mock(
  "@/lib/measurements/drain-per-sample-cumulative",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/measurements/drain-per-sample-cumulative")
    >()),
    drainPerSampleCumulative,
  }),
);
vi.mock(
  "@/lib/measurements/consolidate-daily-mean",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/measurements/consolidate-daily-mean")
    >()),
    consolidateDailyMean: vi.fn(async () => ({
      stoppedEarly: false,
      totals: {
        usersScanned: 0,
        daysConsolidated: 0,
        perSampleRowsSoftDeleted: 0,
        dailyRowsUpserted: 0,
        daysFailed: 0,
      },
    })),
  }),
);
vi.mock(
  "@/lib/measurements/dense-intraday-retention",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/measurements/dense-intraday-retention")
    >()),
    runDenseIntradayRetention: vi.fn(async () => ({
      stoppedEarly: false,
      totals: {
        usersScanned: 0,
        daysConsolidated: 0,
        perSampleRowsSoftDeleted: 0,
        hourlyRowsUpserted: 0,
        dailyRowsRetired: 0,
      },
    })),
  }),
);
vi.mock("@/lib/jobs/reminder/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/reminder/shared")>()),
  getWorkerPrisma: () => ({}),
}));

import {
  DRAIN_CUMULATIVE_CRON,
  DRAIN_CUMULATIVE_QUEUE,
} from "@/lib/jobs/drain-cumulative-queue";
import { cronIsTheRetry } from "@/lib/jobs/reminder/registrar-shared";
import {
  groupOf,
  jobOf,
  recordingBoss,
} from "@/lib/jobs/registry/__tests__/registry-helpers";
import { DRAIN_CUMULATIVE_CUTOFF_HOURS } from "@/lib/measurements/drain-per-sample-cumulative";

describe("drainPerSampleCumulative nightly schedule", () => {
  it("declares the drain queue at the documented Berlin cadence", () => {
    expect(DRAIN_CUMULATIVE_QUEUE).toBe("drain-per-sample-cumulative");
    // 03:45 Europe/Berlin — between audit-log cleanup (03:15) and the
    // feedback aggregator (04:00). Keep the slot stable so an operator
    // staring at the cron table can find the job easily.
    expect(DRAIN_CUMULATIVE_CRON).toBe("45 3 * * *");
  });

  it("passes the 36 hour grace window into the drain helper", async () => {
    // The literal `36` lives in the helper module so the worker, the admin
    // route, and the CLI all read one source of truth.
    expect(DRAIN_CUMULATIVE_CUTOFF_HOURS).toBe(36);
    const { boss, sends } = recordingBoss();
    const handler = await jobOf(DRAIN_CUMULATIVE_QUEUE).load({ boss });
    await handler([
      {
        id: "j1",
        name: DRAIN_CUMULATIVE_QUEUE,
        data: { triggeredAt: "2026-01-01T03:45:00.000Z" },
        expireInSeconds: 900,
        heartbeatSeconds: null,
        retryCount: 0,
        signal: new AbortController().signal,
      },
    ]);
    expect(drainPerSampleCumulative).toHaveBeenCalledTimes(1);
    expect(drainPerSampleCumulative).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        dryRun: false,
        cutoffHours: DRAIN_CUMULATIVE_CUTOFF_HOURS,
      }),
    );
    // A tick that finished inside its budget hands nothing on.
    expect(sends).toEqual([]);
  });

  it("schedules the drain cron with the cron as the retry", () => {
    const job = jobOf(DRAIN_CUMULATIVE_QUEUE);
    expect(job.cron).toBe(DRAIN_CUMULATIVE_CRON);
    expect(job.scheduleOptions).toBe(cronIsTheRetry);
    expect(job.work).toEqual({ localConcurrency: 1 });
  });

  it("declares the drain queue in the rollup group", () => {
    // pg-boss v12 requires explicit createQueue before scheduling; a queue
    // the registry does not declare is never created and its schedule
    // silently no-ops.
    expect(groupOf(DRAIN_CUMULATIVE_QUEUE).name).toBe("rollup");
  });
});
