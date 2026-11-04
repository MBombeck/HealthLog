/**
 * Garmin poll-cohort sync handler.
 *
 * Poll-only: the Personal API has no webhooks, so one hourly cron tick (no
 * `userId`) walks every account holding a Garmin key and re-syncs each via
 * `syncUserGarmin`. A connection parked on a refused key is skipped until
 * the person pastes a new one. One account's failure is booked on its ledger
 * and the pass goes on.
 */
import { ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import { recordGarminSyncFailure, syncUserGarmin } from "@/lib/garmin/sync";
import { makePollCohortHandler, type PollCohortPayload } from "./poll-cohort";

export type GarminSyncPayload = PollCohortPayload;

export const handleGarminSync = makePollCohortHandler({
  taskName: "job.garmin_sync",
  findCohort: async (prisma) => {
    const users = await prisma.user.findMany({
      where: { garminApiKeyEncrypted: { not: null }, ...ACTIVE_ACCOUNT },
      select: { id: true },
    });
    return users.map((u) => u.id);
  },
  syncUser: async (userId) =>
    (await syncUserGarmin(userId, { skipWhenParked: true })).imported,
  recordFailure: recordGarminSyncFailure,
});
