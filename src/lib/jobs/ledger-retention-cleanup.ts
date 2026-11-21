/**
 * Nightly retention of two ledgers that only ever grew.
 *
 * - `telegram_reminder_messages`: one row per reminder sent to Telegram, so a
 *   tap on its buttons finds the dose it was about. A row was removed only
 *   when someone answered it; every unanswered reminder stayed for good. A
 *   reminder older than a few days cannot be answered usefully any more (the
 *   dose is long marked missed or taken), and the send-side dedup keys on the
 *   day. A row goes 30 days after it was sent.
 * - `coach_usage`: one row per account and day that used the Coach or the
 *   background AI work. The readers look back at most a week (the measured
 *   use behind `ai.usage`), two weeks (the nudge's "recently active"
 *   check), or at today (the budget). A row goes 180 days after its last
 *   write, which leaves half a year of daily totals to look at by hand.
 *
 * Neither table holds anything a person entered, and neither is in the
 * backup. The measurement-reminder event ledger is deliberately not here: it
 * is the history of completed and skipped check-ups, shown on the day view
 * and kept in the backup like any other record.
 *
 * Each table is deleted in bounded batches over the index migration 0517
 * gave its age column.
 */
import type { Job } from "pg-boss";

import type { PrismaClient } from "@/generated/prisma/client";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { PURGE_BATCH_SIZE, PURGE_MAX_BATCHES } from "@/lib/jobs/purge-batch";
import { getWorkerPrisma } from "@/lib/jobs/reminder/shared";
import { withBackgroundEvent } from "@/lib/logging/background";

export const LEDGER_RETENTION_CLEANUP_QUEUE = "ledger-retention-cleanup";
/** Daily at 03:58 Europe/Berlin, the last slot of the 03:xx window. */
export const LEDGER_RETENTION_CLEANUP_CRON = "58 3 * * *";

const DAY_MS = 86_400_000;

/** Days a Telegram reminder message is kept after it was sent. */
export const TELEGRAM_REMINDER_MESSAGE_RETENTION_DAYS = 30;
/** Days a Coach usage day is kept after its last write. */
export const COACH_USAGE_RETENTION_DAYS = 180;

export interface LedgerRetentionCleanupPayload {
  triggeredAt?: string;
}

/** The tables and the column each one ages by. Literals, spliced below. */
const LEDGERS = [
  {
    key: "telegram_reminder_messages",
    table: "telegram_reminder_messages",
    column: "sent_at",
    retentionDays: TELEGRAM_REMINDER_MESSAGE_RETENTION_DAYS,
  },
  {
    key: "coach_usage",
    table: "coach_usage",
    column: "updated_at",
    retentionDays: COACH_USAGE_RETENTION_DAYS,
  },
] as const;

export type RetainedLedger = (typeof LEDGERS)[number]["key"];

export interface LedgerRetentionCleanupResult {
  deleted: Record<RetainedLedger, number>;
  /** False when a table stopped at the batch cap with rows left. */
  drained: boolean;
}

export async function cleanupRetainedLedgers(
  prisma: PrismaClient,
  now: Date = new Date(),
  { batchSize = PURGE_BATCH_SIZE, maxBatches = PURGE_MAX_BATCHES } = {},
): Promise<LedgerRetentionCleanupResult> {
  const deleted = {} as Record<RetainedLedger, number>;
  let drained = true;
  for (const ledger of LEDGERS) {
    const cutoff = new Date(now.getTime() - ledger.retentionDays * DAY_MS);
    let total = 0;
    let finished = false;
    for (let batch = 0; batch < maxBatches; batch++) {
      // `ledger.table` and `ledger.column` are the literals above, never input.
      // account-deletion: retention ages rows out whatever their account's state; a frozen record keeps no more than an active one.
      const removed = await prisma.$executeRawUnsafe(
        `DELETE FROM "${ledger.table}" WHERE "id" IN (
           SELECT "id" FROM "${ledger.table}"
            WHERE "${ledger.column}" < $1 LIMIT $2)`,
        cutoff,
        batchSize,
      );
      total += removed;
      if (removed < batchSize) {
        finished = true;
        break;
      }
    }
    deleted[ledger.key] = total;
    if (!finished) drained = false;
  }
  return { deleted, drained };
}

export async function handleLedgerRetentionCleanup(
  jobs: Job<LedgerRetentionCleanupPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.ledger_retention_cleanup", async (evt) => {
    try {
      const { deleted, drained } =
        await cleanupRetainedLedgers(getWorkerPrisma());
      for (const [key, count] of Object.entries(deleted)) {
        evt.addMeta(`ledger_retention_cleanup_${key}`, count);
      }
      evt.addMeta("ledger_retention_cleanup_drained", drained);
      if (!drained) {
        evt.addWarning(
          "ledger-retention-cleanup stopped at the batch cap; a backlog remains for the next run",
        );
      }
      return jobDone({
        telegram_reminder_messages_deleted: deleted.telegram_reminder_messages,
        coach_usage_days_deleted: deleted.coach_usage,
        drained,
      });
    } catch (err) {
      evt.addWarning(`ledger-retention-cleanup failed: ${err}`);
      throw err;
    }
  });
}
