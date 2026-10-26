/**
 * v1.17.0 — Oura poll-cohort sync handler.
 *
 * Poll-only: one hourly cron tick (no `userId`) iterates every user with a
 * stored Oura token and re-syncs each via `syncUserOura`. One user's revoked
 * grant / outage is warned and the pass continues. The shared control flow
 * lives in `./poll-cohort`; the queue name, cron schedule, and boss.work
 * registration live in reminder-worker.ts.
 */
import { ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import { recordOuraSyncFailure, syncUserOura } from "@/lib/oura/sync";
import { makePollCohortHandler, type PollCohortPayload } from "./poll-cohort";

export type OuraSyncPayload = PollCohortPayload;

export const handleOuraSync = makePollCohortHandler({
  taskName: "job.oura_sync",
  findCohort: async (prisma) => {
    const users = await prisma.user.findMany({
      where: { ouraAccessTokenEncrypted: { not: null }, ...ACTIVE_ACCOUNT },
      select: { id: true },
    });
    return users.map((u) => u.id);
  },
  // The cohort accounts in rows imported; the failure half of the result is
  // recorded on the `oura` ledger by the sync itself.
  syncUser: async (userId) => (await syncUserOura(userId)).imported,
  // Catches an UNMARKED escape — today the `upsertOuraMeasurements` write-path
  // throw (the fetch/refresh path already records + marks its own failures).
  recordFailure: recordOuraSyncFailure,
});
