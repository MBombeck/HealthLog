/**
 * The pulse day-mean method switch (#1107 follow-up): dry run, then apply.
 *
 * Both start from `POST /api/admin/maintenance/pulse-day-mean` (cookie-only
 * admin) and run here, in the background worker, one at a time.
 *
 *   - `dry_run` computes, for every account with pulse and every UTC day, the
 *     day value under both methods on the account's canonical source, and
 *     writes one thing: the result, to `app_settings.pulse_day_mean_dry_run_json`
 *     (how many days move by more than 1 bpm, the largest move, a distribution,
 *     and the same per account under an ordinal label). Nothing else is
 *     written, the rollup tier included.
 *   - `rebuild` follows the apply step, which has already stored the new
 *     method: it recomputes the PULSE rollups of every account, which read the
 *     stored method inside their own statement.
 *
 * Both work one account and one window at a time (`DRY_RUN_WINDOW_DAYS`,
 * `REBUILD_WINDOW_DAYS`), so the process holds a window's aggregate rows and
 * never an account's readings: the heap stays flat however long the history.
 */
import { activeAccountSql } from "@/lib/account-deletion/active-account";
import type { Job } from "pg-boss";

import { buildSourceRankCase } from "@/lib/analytics/source-rank-sql";
import { prisma } from "@/lib/db";
import { withJobLock } from "@/lib/jobs/job-lock";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import { logCaught } from "@/lib/logging/signal";
import {
  hourWeightSql,
  weightedHourMeanSql,
} from "@/lib/measurements/day-mean";
import {
  isPulseDayMeanMethod,
  DEFAULT_PULSE_DAY_MEAN_METHOD,
} from "@/lib/measurements/day-statistic";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import {
  recomputeUserRollups,
  ROLLUP_FOLD_WINDOW_MS,
} from "@/lib/rollups/measurement-rollups";
import {
  PULSE_DAY_MEAN_CHANGE_BUCKETS,
  pulseDayMeanStoredRunsSchema,
  type PulseDayMeanDryRun,
  type PulseDayMeanDryRunResult,
  type PulseDayMeanRebuild,
  type PulseDayMeanStatus,
  type PulseDayMeanStoredRuns,
} from "@/lib/validations/pulse-day-mean";

export const PULSE_DAY_MEAN_QUEUE = "pulse-day-mean";

/**
 * One-shot and exclusive: a dry run or a rebuild that stops part way is
 * started again by the operator, never retried beside a half-finished one.
 */
export const PULSE_DAY_MEAN_SEND_OPTIONS = {
  retryLimit: 0,
  expireInSeconds: 6 * 60 * 60,
  singletonKey: PULSE_DAY_MEAN_QUEUE,
} as const;

export interface PulseDayMeanPayload {
  action: "dry_run" | "rebuild";
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Days of one account's pulse a dry-run statement covers. */
const DRY_RUN_WINDOW_DAYS = 90;
/** Days of one account's pulse a rebuild statement covers. */
const REBUILD_WINDOW_DAYS = 366;
/** A window's statements may outlast the request limit, never this. */
const STATEMENT_BUDGET_MS = 5 * 60 * 1000;

/** A day "changed" when its value moves by more than this many bpm. */
const CHANGED_OVER_BPM = 1;

// ─── Status ───────────────────────────────────────────────

/** Whether a dry run or rebuild is queued or running. */
export async function isPulseDayMeanRunActive(): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM pgboss.job
      WHERE name = ${PULSE_DAY_MEAN_QUEUE}
        AND state IN ('created', 'retry', 'active')
    `;
    return (rows[0]?.n ?? 0) > 0;
  } catch {
    // No queue schema (web-only deployment): nothing can be running.
    return false;
  }
}

function parseStoredRuns(value: unknown): PulseDayMeanStoredRuns | null {
  const parsed = pulseDayMeanStoredRunsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A run still marked queued or running with no live job behind it failed. */
function settle<T extends { status: PulseDayMeanDryRun["status"] }>(
  run: T | null,
  active: boolean,
): T | null {
  if (run && (run.status === "queued" || run.status === "running") && !active) {
    return { ...run, status: "failed" };
  }
  return run;
}

/**
 * The stored method, when it was applied, the last dry run and the last
 * rebuild. A run still marked queued or running with no live job behind it
 * (the worker went away mid-run) reads as failed.
 */
export async function readPulseDayMeanStatus(): Promise<PulseDayMeanStatus> {
  const row = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: {
      pulseDayMeanMethod: true,
      pulseDayMeanAppliedAt: true,
      pulseDayMeanDryRunJson: true,
    },
  });
  const stored = parseStoredRuns(row?.pulseDayMeanDryRunJson ?? null);
  const pending =
    stored !== null &&
    [stored.status, stored.rebuild?.status].some(
      (status) => status === "queued" || status === "running",
    );
  const active = pending ? await isPulseDayMeanRunActive() : false;
  const { rebuild, ...dryRun } = stored ?? { rebuild: null };
  return {
    method: isPulseDayMeanMethod(row?.pulseDayMeanMethod)
      ? row.pulseDayMeanMethod
      : DEFAULT_PULSE_DAY_MEAN_METHOD,
    appliedAt: row?.pulseDayMeanAppliedAt?.toISOString() ?? null,
    lastDryRun: stored ? settle(dryRun as PulseDayMeanDryRun, active) : null,
    lastRebuild: settle(rebuild ?? null, active),
  };
}

async function readStoredRuns(): Promise<PulseDayMeanStoredRuns | null> {
  const row = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { pulseDayMeanDryRunJson: true },
  });
  return parseStoredRuns(row?.pulseDayMeanDryRunJson ?? null);
}

async function writeStoredRuns(runs: PulseDayMeanStoredRuns): Promise<void> {
  await prisma.appSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", pulseDayMeanDryRunJson: runs },
    update: { pulseDayMeanDryRunJson: runs },
  });
}

/** The only write a dry run makes. The last rebuild stays as it was. */
export async function writeDryRun(run: PulseDayMeanDryRun): Promise<void> {
  const stored = await readStoredRuns();
  await writeStoredRuns({ ...run, rebuild: stored?.rebuild ?? null });
}

/**
 * Record the rebuild's state beside the dry run it followed. A rebuild only
 * runs after an apply, and an apply needs a dry run, so there is always one
 * to sit beside; without it there is nothing to record against.
 */
export async function writeRebuild(
  rebuild: PulseDayMeanRebuild | null,
): Promise<void> {
  const stored = await readStoredRuns();
  if (!stored) return;
  await writeStoredRuns({ ...stored, rebuild });
}

// ─── Accounts ─────────────────────────────────────────────

interface PulseAccount {
  id: string;
  first: Date;
  last: Date;
}

/** Accounts holding pulse, oldest account first, with their pulse span. */
async function pulseAccounts(): Promise<PulseAccount[]> {
  const rows = await prisma.$queryRaw<
    Array<{ id: string; first: Date | null; last: Date | null }>
  >`
    SELECT u."id",
           (SELECT MIN(m."measured_at") FROM measurements m
             WHERE m."user_id" = u."id" AND m."type" = 'PULSE'
               AND m."deleted_at" IS NULL) AS first,
           (SELECT MAX(m."measured_at") FROM measurements m
             WHERE m."user_id" = u."id" AND m."type" = 'PULSE'
               AND m."deleted_at" IS NULL) AS last
    FROM users u
    WHERE ${activeAccountSql(`u."id"`)}
    ORDER BY u."created_at", u."id"
  `;
  return rows
    .filter((r) => r.first !== null && r.last !== null)
    .map((r) => ({ id: r.id, first: r.first!, last: r.last! }));
}

/** `[from, to)` windows of `days` covering `[first, last]`, UTC-day aligned. */
function windows(
  first: Date,
  last: Date,
  days: number,
): Array<{ from: Date; to: Date }> {
  const out: Array<{ from: Date; to: Date }> = [];
  const start = Math.floor(first.getTime() / DAY_MS) * DAY_MS;
  const end = (Math.floor(last.getTime() / DAY_MS) + 1) * DAY_MS;
  for (let t = start; t < end; t += days * DAY_MS) {
    out.push({
      from: new Date(t),
      to: new Date(Math.min(end, t + days * DAY_MS)),
    });
  }
  return out;
}

// ─── Dry run ──────────────────────────────────────────────

interface WindowComparison {
  days: number;
  over1: number;
  maxDelta: number;
  buckets: [number, number, number, number];
}

/**
 * One account's UTC days in `[from, to)`: each day's value on its canonical
 * source under both methods, compared. Aggregated in the statement; one row
 * comes back however many readings the window holds.
 */
async function compareWindow(
  userId: string,
  rank: string,
  from: Date,
  to: Date,
): Promise<WindowComparison> {
  const v1 = weightedHourMeanSql(
    "h.hour_mean",
    hourWeightSql("h.n", "hour_mean_v1"),
  );
  const v2 = weightedHourMeanSql(
    "h.hour_mean",
    hourWeightSql("h.n", "weighted_hour_mean_v2"),
  );
  // Whitelist splice: `v1` / `v2` are built from code constants and `rank`
  // from the closed source enum (`buildSourceRankCase`); every value is a
  // positional parameter.
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(STATEMENT_BUDGET_MS)}, true)`;
    return tx.$queryRawUnsafe<
      Array<{
        days: number;
        over1: number;
        max_delta: number;
        b0: number;
        b1: number;
        b2: number;
        b3: number;
      }>
    >(
      `
      WITH h AS (
        SELECT m."source",
               date_trunc('hour', m."measured_at") AS hr,
               AVG(m."value") AS hour_mean,
               COUNT(*) AS n
        FROM measurements m
        WHERE m."user_id" = $1
          AND m."type" = 'PULSE'
          AND m."deleted_at" IS NULL
          AND m."measured_at" >= $2
          AND m."measured_at" < $3
        GROUP BY 1, 2
      ),
      d AS (
        SELECT h."source", date_trunc('day', h.hr) AS day,
               ${v1} AS v1,
               ${v2} AS v2
        FROM h
        GROUP BY 1, 2
      ),
      c AS (
        SELECT DISTINCT ON (d.day) ABS(d.v2 - d.v1) AS delta
        FROM d
        ORDER BY d.day, (${rank}), d."source"::text
      )
      SELECT COUNT(*)::int                                           AS days,
             COUNT(*) FILTER (WHERE delta > $4)::int                 AS over1,
             COALESCE(MAX(delta), 0)::double precision               AS max_delta,
             COUNT(*) FILTER (WHERE delta <= 1)::int                 AS b0,
             COUNT(*) FILTER (WHERE delta > 1 AND delta <= 2)::int   AS b1,
             COUNT(*) FILTER (WHERE delta > 2 AND delta <= 5)::int   AS b2,
             COUNT(*) FILTER (WHERE delta > 5)::int                  AS b3
      FROM c
    `,
      userId,
      from,
      to,
      CHANGED_OVER_BPM,
    );
  });
  const r = rows[0];
  return {
    days: Number(r?.days ?? 0),
    over1: Number(r?.over1 ?? 0),
    maxDelta: Number(r?.max_delta ?? 0),
    buckets: [
      Number(r?.b0 ?? 0),
      Number(r?.b1 ?? 0),
      Number(r?.b2 ?? 0),
      Number(r?.b3 ?? 0),
    ],
  };
}

/** Compare both methods over every account's pulse. Writes nothing. */
export async function computePulseDayMeanDryRun(): Promise<PulseDayMeanDryRunResult> {
  const buckets = [0, 0, 0, 0];
  let daysCompared = 0;
  let over1 = 0;
  let maxChange = 0;
  const perAccount: PulseDayMeanDryRunResult["perAccount"] = [];
  const accounts = await pulseAccounts();
  for (const [i, account] of accounts.entries()) {
    const rank = buildSourceRankCase(
      await loadUserSourcePriority(account.id),
      "'PULSE'",
      'd."source"',
    );
    let days = 0;
    let changed = 0;
    for (const w of windows(account.first, account.last, DRY_RUN_WINDOW_DAYS)) {
      const c = await compareWindow(account.id, rank, w.from, w.to);
      days += c.days;
      changed += c.over1;
      maxChange = Math.max(maxChange, c.maxDelta);
      c.buckets.forEach((n, b) => (buckets[b] += n));
    }
    daysCompared += days;
    over1 += changed;
    perAccount.push({ account: `#${i + 1}`, days, changedOver1Bpm: changed });
  }
  return {
    accounts: accounts.length,
    daysCompared,
    daysChangedOver1Bpm: over1,
    maxChangeBpm: Math.round(maxChange * 10) / 10,
    distribution: PULSE_DAY_MEAN_CHANGE_BUCKETS.map((bucket, b) => ({
      bucket,
      days: buckets[b],
    })),
    perAccount,
  };
}

// ─── Rebuild ──────────────────────────────────────────────

/**
 * Recompute every account's PULSE rollups inside the fold window, a year of
 * one account at a time. Returns the accounts done and the rows written.
 */
export async function rebuildPulseRollups(): Promise<{
  accounts: number;
  rows: number;
}> {
  const floor = new Date(Date.now() - ROLLUP_FOLD_WINDOW_MS);
  let rows = 0;
  let accounts = 0;
  for (const account of await pulseAccounts()) {
    if (account.last < floor) continue;
    const first = account.first < floor ? floor : account.first;
    for (const w of windows(first, account.last, REBUILD_WINDOW_DAYS)) {
      const done = await recomputeUserRollups(account.id, {
        types: ["PULSE"],
        from: w.from,
        to: w.to,
        statementTimeoutMs: STATEMENT_BUDGET_MS,
      });
      rows += done.rowsUpserted;
    }
    accounts += 1;
  }
  return { accounts, rows };
}

// ─── Job ──────────────────────────────────────────────────

async function runRebuild(): Promise<{ accounts: number; rows: number }> {
  const startedAt = new Date().toISOString();
  await writeRebuild({
    status: "running",
    startedAt,
    finishedAt: null,
    accounts: null,
    rows: null,
  });
  try {
    const done = await rebuildPulseRollups();
    await writeRebuild({
      status: "done",
      startedAt,
      finishedAt: new Date().toISOString(),
      ...done,
    });
    return done;
  } catch (err) {
    await writeRebuild({
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      accounts: null,
      rows: null,
    }).catch((writeErr) =>
      logCaught("pulse_day_mean.rebuild.status_write_failed", writeErr),
    );
    throw err;
  }
}

async function runDryRun(): Promise<PulseDayMeanDryRunResult> {
  const startedAt = new Date().toISOString();
  await writeDryRun({
    status: "running",
    startedAt,
    finishedAt: null,
    result: null,
  });
  try {
    const result = await computePulseDayMeanDryRun();
    await writeDryRun({
      status: "done",
      startedAt,
      finishedAt: new Date().toISOString(),
      result,
    });
    return result;
  } catch (err) {
    await writeDryRun({
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      result: null,
    }).catch((writeErr) =>
      logCaught("pulse_day_mean.dry_run.status_write_failed", writeErr),
    );
    throw err;
  }
}

export async function handlePulseDayMean(
  jobs: Job<PulseDayMeanPayload>[],
): Promise<JobOutcome> {
  const action = jobs[0]?.data?.action === "rebuild" ? "rebuild" : "dry_run";
  return withBackgroundEvent("job.pulse_day_mean", async (evt) => {
    const startedAt = Date.now();
    evt.addMeta("pulse_day_mean_action", action);
    try {
      const guarded = await withJobLock(PULSE_DAY_MEAN_QUEUE, async () =>
        action === "rebuild"
          ? { kind: "rebuild" as const, ...(await runRebuild()) }
          : { kind: "dry_run" as const, result: await runDryRun() },
      );
      if (!guarded.ran) {
        return jobDone({ outcome: "already_running" });
      }
      const done = guarded.result;
      if (done.kind === "rebuild") {
        evt.addMeta("pulse_day_mean_accounts", done.accounts);
        evt.addMeta("pulse_day_mean_rows", done.rows);
        return jobDone({
          outcome: "rebuilt",
          accounts_completed: done.accounts,
          rows_upserted: done.rows,
          duration_ms: Date.now() - startedAt,
        });
      }
      evt.addMeta("pulse_day_mean_accounts", done.result.accounts);
      evt.addMeta("pulse_day_mean_days", done.result.daysCompared);
      evt.addMeta("pulse_day_mean_changed", done.result.daysChangedOver1Bpm);
      return jobDone({
        outcome: "compared",
        accounts_completed: done.result.accounts,
        processed: done.result.daysCompared,
        duration_ms: Date.now() - startedAt,
      });
    } catch (err) {
      logCaught(`pulse_day_mean.${action}_failed`, err);
      return jobFailed(`pulse day-mean ${action} failed`, err, {
        duration_ms: Date.now() - startedAt,
      });
    }
  });
}
