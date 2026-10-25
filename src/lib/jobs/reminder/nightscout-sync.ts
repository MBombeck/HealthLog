/**
 * Nightscout hourly poll-cohort sync handler (v1.17.0).
 *
 * Poll-only: Nightscout has no outbound webhook to HealthLog, so the single
 * hourly cron tick carries no `userId` and the handler iterates every user with
 * a configured instance, re-syncing each via `syncUserNightscout`. One user's
 * unreachable instance never starves the rest of the cohort — a per-user error
 * is warned and the pass continues. The shared control flow lives in
 * `./poll-cohort`; reminder-worker.ts owns the queue name, cron schedule, and
 * boss.work registration.
 */
import { ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import {
  recordNightscoutSyncFailure,
  syncUserNightscout,
} from "@/lib/nightscout/sync";
import { makePollCohortHandler, type PollCohortPayload } from "./poll-cohort";

export type NightscoutSyncPayload = PollCohortPayload;

export const handleNightscoutSync = makePollCohortHandler({
  taskName: "job.nightscout_sync",
  findCohort: async (prisma) => {
    // The URL column is the connect marker (a public instance stores no token).
    const users = await prisma.user.findMany({
      where: { nightscoutUrlEncrypted: { not: null }, ...ACTIVE_ACCOUNT },
      select: { id: true },
    });
    return users.map((u) => u.id);
  },
  // The cohort accounts in rows imported; the failure half of the result is
  // recorded on the `nightscout` ledger by the sync itself.
  syncUser: async (userId) => (await syncUserNightscout(userId)).imported,
  // The fetch path already records + marks its own failure (token-redacted), so
  // this fires only for a future UNMARKED escape — and redacts the token before
  // the message reaches the ledger.
  recordFailure: recordNightscoutSyncFailure,
});
