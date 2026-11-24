/**
 * Daily demo refresh: rewrite the public demo from `scripts/seed-demo.ts`.
 *
 * Everything the seed writes is relative to the moment it runs: 90 days of
 * readings ending today, intakes up to this morning, a dental check-up due
 * today, a visit booked for tomorrow, a lab panel ten days old, cycle
 * forecasts, status cards keyed on today. Nothing on the demo writes after
 * that (visitors are read-only), so every one of those series aged from the
 * seed day on. A medication without an automatic intake lost a day of
 * adherence every day, sleep and activity fell out of their windows within
 * four weeks, and "tomorrow" became the past.
 *
 * Topping up each series day by day was the other way. It would need a
 * second generator per series beside the seed's, kept in step with it by
 * hand, and it still leaves the one-off anchors (due today, booked tomorrow,
 * latest panel, forecasts) to age. Running the seed itself keeps the demo
 * exactly as a fresh seed reads, for every series the seed has now or gains
 * later, with no second copy of any pattern to drift.
 *
 * It runs only on a demo deploy (`DEMO_MODE=true`) and only against a
 * database that holds the demo account and nothing else, because the seed
 * deletes every account before it writes. A visitor's session ends with the
 * refresh, once a day. After the seed it queues the rollup backfill an
 * operator used to get by restarting the app after a hand seed.
 */
import { Pool } from "pg";
import type { Job } from "pg-boss";

import type { PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { workerLog } from "@/lib/jobs/reminder/shared";
import { annotate } from "@/lib/logging/context";
import { withBackgroundEvent } from "@/lib/logging/background";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { localHmAsUtc } from "@/lib/tz/local-day";

import {
  DEMO_REFRESH_HOUR,
  DEMO_REFRESH_QUEUE,
  DEMO_REFRESH_SINGLETON_KEY,
  demoRefreshEnabled,
} from "./demo-refresh-queue";

/** The published demo account, the only one the seed writes. */
export const DEMO_USERNAME = "demo";

export interface DemoRefreshDeps {
  readonly prisma?: PrismaClient;
  readonly seed?: (pool: Pool) => Promise<void>;
  readonly afterSeed?: () => Promise<void>;
  readonly databaseUrl?: string;
}

/**
 * The accounts in the database, at most two: the refresh proceeds only when
 * this is exactly the demo account.
 */
async function accountNames(prisma: PrismaClient): Promise<string[]> {
  // account-deletion: the count of every account, pending or not, is the
  // point: the refresh must refuse a database holding anyone but the demo.
  const rows = await prisma.$queryRaw<Array<{ username: string }>>`
    SELECT username FROM users LIMIT 2`;
  return rows.map((r) => r.username);
}

/** True when the database holds the demo account and nothing else. */
export async function isDemoOnlyDatabase(
  prisma: PrismaClient = defaultPrisma,
): Promise<boolean> {
  const names = await accountNames(prisma);
  return names.length === 1 && names[0] === DEMO_USERNAME;
}

async function runSeed(pool: Pool): Promise<void> {
  const { seed } = await import("../../../scripts/seed-demo");
  await seed(pool);
}

/**
 * The rollup group's boot discovery: the reseeded account is a new account
 * without rollups, and this is what queues its backfill (the Health Score
 * reads "not enough data" until it ran). It used to take an app restart.
 */
async function runRollupDiscovery(): Promise<void> {
  const [{ ROLLUP_GROUP }, { runBootDiscovery }] = await Promise.all([
    import("@/lib/jobs/registry/rollup"),
    import("@/lib/jobs/registry/register"),
  ]);
  await runBootDiscovery(ROLLUP_GROUP.discovery ?? []);
}

export async function handleDemoRefresh(
  _jobs: Job<Record<string, never>>[],
  deps: DemoRefreshDeps = {},
): Promise<JobOutcome> {
  return withBackgroundEvent("job.demo_refresh", async () => {
    if (!demoRefreshEnabled()) return jobDone({ skipped: true });
    const prisma = deps.prisma ?? defaultPrisma;
    try {
      if (!(await isDemoOnlyDatabase(prisma))) {
        workerLog(
          "info",
          "[demo-refresh] skipped: the database holds other accounts than the demo",
        );
        return jobDone({ skipped: true });
      }
      const pool = new Pool({
        connectionString: deps.databaseUrl ?? process.env.DATABASE_URL,
        max: 1,
      });
      try {
        await (deps.seed ?? runSeed)(pool);
      } finally {
        await pool.end();
      }
      await (deps.afterSeed ?? runRollupDiscovery)();
    } catch (err) {
      workerLog("error", "[demo-refresh] failed", err);
      return jobFailed("demo refresh failed", err);
    }
    annotate({ action: { name: "demo.data.refresh" } });
    workerLog("info", "[demo-refresh] demo data rewritten");
    return jobDone({ accounts_completed: 1 });
  });
}

/**
 * The most recent refresh time at or before `now`: today's refresh hour once
 * it has passed, else null (the cron covers the rest of the morning).
 */
export function refreshCutToday(now: Date): Date | null {
  const cut = localHmAsUtc(now, DEFAULT_TIMEZONE, DEMO_REFRESH_HOUR, 0);
  return now.getTime() >= cut.getTime() ? cut : null;
}

/**
 * Boot discovery: a worker that was down at the refresh hour (a deploy, a
 * restart) misses that cron tick, and pg-boss does not replay it. Past the
 * refresh hour, a demo seeded before today's refresh is refreshed now.
 */
export async function enqueueBootTimeDemoRefresh(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<{ enqueued: boolean; error: string | null }> {
  if (!demoRefreshEnabled()) return { enqueued: false, error: null };
  const boss = getGlobalBoss();
  if (!boss) return { enqueued: false, error: null };
  const cut = refreshCutToday(now);
  if (!cut) return { enqueued: false, error: null };
  try {
    if (!(await isDemoOnlyDatabase(prisma))) {
      return { enqueued: false, error: null };
    }
    // account-deletion: reads the one demo account's seed time, nothing else.
    const rows = await prisma.$queryRaw<Array<{ createdAt: Date }>>`
      SELECT created_at AS "createdAt" FROM users WHERE username = ${DEMO_USERNAME}`;
    const seededAt = rows[0]?.createdAt;
    if (seededAt && seededAt.getTime() >= cut.getTime()) {
      return { enqueued: false, error: null };
    }
    const id = await boss.send(
      DEMO_REFRESH_QUEUE,
      {},
      { singletonKey: DEMO_REFRESH_SINGLETON_KEY, retryLimit: 2 },
    );
    return { enqueued: id !== null, error: null };
  } catch (err) {
    return {
      enqueued: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
