/**
 * One-shot repair: period days Garmin or Oura imported before their write
 * learned to open and attribute cycles.
 *
 * Both wearables wrote their period days as bare rows, past the seam every
 * other cycle writer goes through (`ensureCycleForBleedingDay`), so an account
 * whose periods came from a watch or a ring held day-logs and no cycle: no
 * start, no lengths, no forecast. The write now goes through
 * `createSubordinatePeriodDays`; this pass gives the rows written before it
 * the cycles they should have opened, by the same rule, oldest first per
 * account.
 *
 * A row is a candidate when it is a live GARMIN or OURA bleeding day without
 * a cycle and the rule can still place it: either a cycle starts on or before
 * it (the row only needs its attribution), or no cycle does and nothing in the
 * way stops it opening one (`ensureCycleForBleedingDay` declines a day that
 * lies too close before a later start without being the same period). A day
 * the rule declines stays unattributed and drops out of the predicate, so the
 * pass converges: a second run finds nothing, and a boot with nothing to
 * repair costs one query.
 *
 * It repairs, and never re-decides what a person took back. A cycle she
 * deleted (or whose first day she deleted or cleared) stays as a tombstone
 * with no `absorbedIntoId`; its wearable days are left without a cycle when
 * nothing lies before them, which looks exactly like the backlog. A day that
 * lies within the hard minimum cycle length after such a removed start is
 * therefore never a candidate: inside that span it can only be the period she
 * removed, and reopening it on the next boot would undo her delete. A start
 * folded into another one is not a removal and does not count.
 *
 * Accounts with the cycle module off are left alone, as the syncs leave them
 * (`isCycleAvailableForUser`), and their rows do not make a boot enqueue.
 *
 * Only cycles and the `cycleId` link move. No day-log's own content is
 * touched, a person's own rows included. A Garmin period whose cycle this pass
 * opened and that is over (a later cycle has started) has its last day stamped
 * as the period end, from the run of consecutive Garmin days at its start.
 */
import type { Job } from "pg-boss";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { activeAccountSql } from "@/lib/account-deletion/active-account";
import { ensureCycleForBleedingDay } from "@/lib/cycle/cycle-boundaries";
import { addDays } from "@/lib/cycle/day-math";
import { isCycleAvailableForUser } from "@/lib/cycle/gate";
import { stampSubordinatePeriodEnd } from "@/lib/cycle/subordinate-period-days";
import { HARD_CYCLE_MIN, PERIOD_MAX } from "@/lib/cycle/types";
import { prisma as defaultPrisma } from "@/lib/db";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { workerLog } from "@/lib/jobs/reminder/shared";
import { annotate } from "@/lib/logging/context";
import { withBackgroundEvent } from "@/lib/logging/background";

import {
  WEARABLE_CYCLE_REPAIR_QUEUE,
  WEARABLE_CYCLE_REPAIR_SINGLETON_KEY,
} from "./wearable-cycle-repair-queue";

/** The longest run of Garmin days read as one period. */
const MAX_PERIOD_RUN_DAYS = 14;

interface CandidateRow {
  id: string;
  userId: string;
  date: string;
}

/**
 * The SQL half of the rule. `limit` turns it into the boot's existence check.
 * The second arm mirrors `ensureCycleForBleedingDay`: with no cycle on or
 * before the day, it opens one unless a later start lies within the hard
 * minimum cycle length without being the same period. The last arm keeps
 * out every day a removed start still speaks for (see the file comment).
 */
function candidateQuery(limit: number | null): Prisma.Sql {
  return Prisma.sql`
    SELECT d."id", d."user_id" AS "userId", d."date"
    FROM "cycle_day_logs" d
    WHERE d."source" IN ('GARMIN', 'OURA')
      AND d."deleted_at" IS NULL
      AND d."cycle_id" IS NULL
      AND d."flow" IS NOT NULL
      AND d."flow" NOT IN ('NONE', 'SPOTTING')
      AND NOT d."intermenstrual_bleeding"
      AND (
        EXISTS (
          SELECT 1 FROM "menstrual_cycles" c
          WHERE c."user_id" = d."user_id" AND c."deleted_at" IS NULL
            AND c."start_date" <= d."date"
        )
        OR NOT EXISTS (
          SELECT 1 FROM "menstrual_cycles" c
          WHERE c."user_id" = d."user_id" AND c."deleted_at" IS NULL
            AND c."start_date" >= to_char(d."date"::date + ${PERIOD_MAX}::int, 'YYYY-MM-DD')
            AND c."start_date" < to_char(d."date"::date + ${HARD_CYCLE_MIN}::int, 'YYYY-MM-DD')
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM "menstrual_cycles" r
        WHERE r."user_id" = d."user_id"
          AND r."deleted_at" IS NOT NULL
          AND r."absorbed_into_id" IS NULL
          AND r."start_date" <= d."date"
          AND r."start_date" > to_char(d."date"::date - ${HARD_CYCLE_MIN}::int, 'YYYY-MM-DD')
      )
      AND ${activeAccountSql('d."user_id"')}
    ORDER BY d."user_id", d."date"
    ${limit === null ? Prisma.empty : Prisma.sql`LIMIT ${limit}`}
  `;
}

export interface WearableCycleRepairResult {
  /** Rows the SQL predicate returned. */
  scanned: number;
  /** Cycles a row opened. */
  opened: number;
  /** Rows given the cycle they fall in. */
  attributed: number;
  /** Garmin period ends stamped on an opened cycle. */
  periodEnds: number;
  /** Accounts repaired (the cycle module on). */
  accounts: number;
}

/** The last day of the run of consecutive Garmin days starting at `start`. */
async function garminRunEnd(
  prisma: PrismaClient,
  userId: string,
  start: string,
): Promise<string | null> {
  const rows = await prisma.cycleDayLog.findMany({
    where: {
      userId,
      source: "GARMIN",
      deletedAt: null,
      date: { gte: start, lt: addDays(start, MAX_PERIOD_RUN_DAYS) },
    },
    orderBy: { date: "asc" },
    select: { date: true },
  });
  let end: string | null = null;
  for (const row of rows) {
    if (row.date !== (end === null ? start : addDays(end, 1))) break;
    end = row.date;
  }
  return end;
}

/** Repair one account's rows, oldest first. */
async function repairAccount(
  prisma: PrismaClient,
  userId: string,
  rows: readonly CandidateRow[],
  result: WearableCycleRepairResult,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const tz = user?.timezone ?? null;
  const openedGarminStarts: string[] = [];
  for (const row of rows) {
    // Re-read. A cycle opened for an earlier row claims every day after it
    // until the next start, this one included, so a claimed row is still
    // asked whether it starts a cycle of its own.
    const live = await prisma.cycleDayLog.findFirst({
      where: { id: row.id, deletedAt: null },
      select: {
        source: true,
        flow: true,
        intermenstrualBleeding: true,
        cycleId: true,
      },
    });
    if (!live) continue;
    const opened = await ensureCycleForBleedingDay(userId, row.date, tz, {
      flow: live.flow,
      intermenstrualBleeding: live.intermenstrualBleeding,
    });
    if (opened) {
      result.opened += 1;
      if (live.source === "GARMIN") openedGarminStarts.push(row.date);
      continue;
    }
    if (live.cycleId !== null) continue;
    const owning = await prisma.menstrualCycle.findFirst({
      where: { userId, deletedAt: null, startDate: { lte: row.date } },
      orderBy: { startDate: "desc" },
      select: { id: true },
    });
    if (!owning) continue;
    const moved = await prisma.cycleDayLog.updateMany({
      where: { id: row.id, cycleId: null },
      data: { cycleId: owning.id, syncVersion: { increment: 1 } },
    });
    result.attributed += moved.count;
  }
  for (const start of openedGarminStarts) {
    const cycle = await prisma.menstrualCycle.findFirst({
      where: { userId, startDate: start, deletedAt: null },
      select: { endDate: true },
    });
    // An open cycle may still be bleeding; the hourly sync stamps its end.
    if (!cycle?.endDate) continue;
    const end = await garminRunEnd(prisma, userId, start);
    if (
      end &&
      (await stampSubordinatePeriodEnd(userId, "GARMIN", start, end))
    ) {
      result.periodEnds += 1;
    }
  }
}

/** The repair itself, across every account. */
export async function repairWearableCycleDays(
  prisma: PrismaClient = defaultPrisma,
): Promise<WearableCycleRepairResult> {
  const rows = await prisma.$queryRaw<CandidateRow[]>(candidateQuery(null));
  const byUser = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    const list = byUser.get(row.userId) ?? [];
    list.push(row);
    byUser.set(row.userId, list);
  }
  const result: WearableCycleRepairResult = {
    scanned: rows.length,
    opened: 0,
    attributed: 0,
    periodEnds: 0,
    accounts: 0,
  };
  for (const [userId, list] of byUser) {
    if (!(await isCycleAvailableForUser(userId))) continue;
    result.accounts += 1;
    await repairAccount(prisma, userId, list, result);
  }
  return result;
}

/** The queue handler: one run over every account. */
export async function handleWearableCycleRepair(
  _jobs: Job<Record<string, never>>[],
  prisma: PrismaClient = defaultPrisma,
): Promise<JobOutcome> {
  return withBackgroundEvent("job.wearable_cycle_repair", async () => {
    let result: WearableCycleRepairResult;
    try {
      result = await repairWearableCycleDays(prisma);
    } catch (err) {
      workerLog("error", "[wearable-cycle-repair] failed", err);
      return jobFailed("wearable cycle repair failed", err);
    }
    workerLog(
      "info",
      `[wearable-cycle-repair] scanned=${result.scanned} opened=${result.opened} attributed=${result.attributed} periodEnds=${result.periodEnds} accounts=${result.accounts}`,
    );
    annotate({
      action: { name: "cycle.wearableDays.repair" },
      meta: { ...result },
    });
    return jobDone({
      candidates_scanned: result.scanned,
      // Cycles opened, rows attributed, period ends stamped, accounts.
      created: result.opened,
      linked: result.attributed,
      updated: result.periodEnds,
      users: result.accounts,
    });
  });
}

/**
 * Whether any account with candidates has the cycle module on. Candidates
 * come in account order, so the first account that may be repaired ends it.
 */
async function anyRepairableAccount(prisma: PrismaClient): Promise<boolean> {
  const rows = await prisma.$queryRaw<CandidateRow[]>(candidateQuery(null));
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.userId)) continue;
    seen.add(row.userId);
    if (await isCycleAvailableForUser(row.userId)) return true;
  }
  return false;
}

/**
 * Boot discovery: one existence query, and the one job only when there is
 * something to repair for an account that tracks its cycle.
 */
export async function enqueueBootTimeWearableCycleRepair(
  prisma: PrismaClient = defaultPrisma,
): Promise<{ enqueued: boolean; error: string | null }> {
  const boss = getGlobalBoss();
  if (!boss) return { enqueued: false, error: null };
  try {
    const any = await prisma.$queryRaw<CandidateRow[]>(candidateQuery(1));
    if (any.length === 0) return { enqueued: false, error: null };
    if (!(await anyRepairableAccount(prisma))) {
      return { enqueued: false, error: null };
    }
    const id = await boss.send(
      WEARABLE_CYCLE_REPAIR_QUEUE,
      {},
      { singletonKey: WEARABLE_CYCLE_REPAIR_SINGLETON_KEY, retryLimit: 2 },
    );
    return { enqueued: id !== null, error: null };
  } catch (err) {
    return {
      enqueued: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
