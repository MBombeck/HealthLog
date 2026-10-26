/**
 * Computed scores: queue-registration guards for the Stress + Strain nightly
 * score jobs and the dense intra-day retention drain.
 *
 * Reads the worker registry: each queue is declared in its group, scheduled
 * (the two cron-driven score jobs), bound to its handler, and offered again by
 * boot discovery where it has one — without booting pg-boss + Prisma. An
 * unregistered queue silently never drains (the recurring past bug this
 * guards against). The retention handler and the nightly drain run against
 * mocked passes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Job } from "pg-boss";
import { describe, expect, it, vi } from "vitest";

const {
  runDenseIntradayRetention,
  runDenseIntradayRetentionForUser,
  workerLog,
} = vi.hoisted(() => ({
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
  runDenseIntradayRetentionForUser: vi.fn(async () => ({
    daysConsolidated: 1,
    perSampleRowsSoftDeleted: 2,
    derivedRestingRowsUpserted: 3,
    stoppedEarly: false,
  })),
  workerLog: vi.fn(),
}));
vi.mock(
  "@/lib/measurements/dense-intraday-retention",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/measurements/dense-intraday-retention")
    >()),
    runDenseIntradayRetention,
  }),
);
vi.mock("@/lib/jobs/dense-intraday-retention", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/jobs/dense-intraday-retention")
  >()),
  runDenseIntradayRetentionForUser,
}));
vi.mock(
  "@/lib/measurements/drain-per-sample-cumulative",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/measurements/drain-per-sample-cumulative")
    >()),
    drainPerSampleCumulative: vi.fn(async () => ({
      stoppedEarly: false,
      totals: {
        usersScanned: 0,
        bucketsCollapsed: 0,
        perSampleRowsDeleted: 0,
        dailyRowsUpserted: 0,
      },
    })),
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
vi.mock("@/lib/jobs/reminder/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/reminder/shared")>()),
  getWorkerPrisma: () => ({}),
  workerLog,
}));

import { DENSE_INTRADAY_HOURLY_REBUILD_QUEUE } from "@/lib/jobs/dense-intraday-hourly-rebuild-queue";
import { DENSE_INTRADAY_RETENTION_QUEUE } from "@/lib/jobs/dense-intraday-retention-queue";
import { DRAIN_CUMULATIVE_QUEUE } from "@/lib/jobs/drain-cumulative-queue";
import {
  handleDenseIntradayHourlyRebuild,
  handleDenseIntradayRetention,
} from "@/lib/jobs/reminder/rollup-handlers";
import {
  handleStrainScore,
  handleStressScore,
} from "@/lib/jobs/reminder/status-handlers";
import {
  discoveryOf,
  groupOf,
  jobOf,
  loadedHandler,
  recordingBoss,
} from "@/lib/jobs/registry/__tests__/registry-helpers";
import {
  STRAIN_SCORE_CRON,
  STRAIN_SCORE_QUEUE,
} from "@/lib/jobs/strain-score-queue";
import {
  STRESS_SCORE_CRON,
  STRESS_SCORE_QUEUE,
} from "@/lib/jobs/stress-score-queue";

const DENSE_RETENTION_PATH = join(
  __dirname,
  "..",
  "dense-intraday-retention.ts",
);
const denseRetentionSource = readFileSync(DENSE_RETENTION_PATH, "utf8");

function job<T>(name: string, data: T): Job<T> {
  return {
    id: "j1",
    name,
    data,
    expireInSeconds: 900,
    heartbeatSeconds: null,
    retryCount: 0,
    signal: new AbortController().signal,
  };
}

describe("stress-score registration", () => {
  it("declares the stress-score queue in the status group", () => {
    expect(groupOf(STRESS_SCORE_QUEUE).name).toBe("status");
  });

  it("schedules the stress-score cron", () => {
    expect(jobOf(STRESS_SCORE_QUEUE).cron).toBe(STRESS_SCORE_CRON);
  });

  it("binds the handler that runs the stress-score pass", async () => {
    expect(await loadedHandler(STRESS_SCORE_QUEUE)).toBe(handleStressScore);
  });
});

describe("strain-score registration", () => {
  it("declares the strain-score queue in the status group", () => {
    expect(groupOf(STRAIN_SCORE_QUEUE).name).toBe("status");
  });

  it("schedules the strain-score cron", () => {
    expect(jobOf(STRAIN_SCORE_QUEUE).cron).toBe(STRAIN_SCORE_CRON);
  });

  it("binds the handler that runs the strain-score pass", async () => {
    expect(await loadedHandler(STRAIN_SCORE_QUEUE)).toBe(handleStrainScore);
  });
});

describe("dense intra-day retention registration", () => {
  it("declares the dense-intraday-retention queue in the rollup group", () => {
    expect(groupOf(DENSE_INTRADAY_RETENTION_QUEUE).name).toBe("rollup");
    expect(jobOf(DENSE_INTRADAY_RETENTION_QUEUE).policy?.policy).toBe(
      "exclusive",
    );
  });

  it("binds the per-user retention handler", async () => {
    expect(await loadedHandler(DENSE_INTRADAY_RETENTION_QUEUE)).toBe(
      handleDenseIntradayRetention,
    );
  });

  it("fires the boot-discovery pass", () => {
    expect(discoveryOf("rollup")).toContain("dense-intraday-retention");
  });

  it("defers the boot-discovery drain past the startup storm (P2028 guard)", () => {
    // The boot-time per-user retention jobs MUST carry a startAfter delay so
    // the transaction-per-day drain never contends with the deploy storm +
    // migration + other boot backfills + foreground health-checks for the
    // shared connection pool. Dropping this re-opens the pool-exhaustion
    // (P2028) restart loop on a data-heavy tenant.
    expect(denseRetentionSource).toMatch(
      /DENSE_INTRADAY_RETENTION_BOOT_DELAY_SECONDS\s*=\s*\d+/,
    );
    expect(denseRetentionSource).toMatch(
      /boss\.send\([\s\S]{0,400}startAfter:\s*DENSE_INTRADAY_RETENTION_BOOT_DELAY_SECONDS/,
    );
  });

  it("folds the nightly dense-retention walk onto the drain-cumulative tick", async () => {
    // The steady-state nightly walk runs the global (no-userId) pass on the
    // same tick as the cumulative + mean drains.
    const { boss } = recordingBoss();
    const drain = await jobOf(DRAIN_CUMULATIVE_QUEUE).load({ boss });
    await drain([job(DRAIN_CUMULATIVE_QUEUE, {})]);
    expect(runDenseIntradayRetention).toHaveBeenCalledTimes(1);
    expect(runDenseIntradayRetention).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dryRun: false }),
    );
  });

  it("surfaces the iOS#34 derived-resting count in the per-user worker log", async () => {
    // The PULSE facet mints derived RESTING_HEART_RATE rows for proxy users;
    // the per-user handler returns the count and the worker logs it so the
    // signal-preservation is observable in production.
    const outcome = await handleDenseIntradayRetention([
      job(DENSE_INTRADAY_RETENTION_QUEUE, {
        userId: "u1",
        enqueuedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    expect(outcome).toMatchObject({
      did: { derived_resting_rows_upserted: 3 },
    });
    expect(workerLog).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("derivedRestingRowsUpserted=3"),
    );
  });
});

describe("dense hourly-rebuild registration", () => {
  it("declares the hourly-rebuild queue in the rollup group", () => {
    expect(groupOf(DENSE_INTRADAY_HOURLY_REBUILD_QUEUE).name).toBe("rollup");
  });

  it("binds the hourly-rebuild handler", async () => {
    expect(await loadedHandler(DENSE_INTRADAY_HOURLY_REBUILD_QUEUE)).toBe(
      handleDenseIntradayHourlyRebuild,
    );
  });

  it("fires the boot-discovery pass", () => {
    expect(discoveryOf("rollup")).toContain("dense-intraday-hourly-rebuild");
  });

  it("defers the boot-discovery rebuild past the startup storm (P2028 guard)", () => {
    const REBUILD_PATH = join(
      __dirname,
      "..",
      "dense-intraday-hourly-rebuild.ts",
    );
    const rebuildSource = readFileSync(REBUILD_PATH, "utf8");
    expect(rebuildSource).toMatch(
      /DENSE_INTRADAY_HOURLY_REBUILD_BOOT_DELAY_SECONDS\s*=\s*\d+/,
    );
    expect(rebuildSource).toMatch(
      /startAfter:\s*DENSE_INTRADAY_HOURLY_REBUILD_BOOT_DELAY_SECONDS/,
    );
  });
});
