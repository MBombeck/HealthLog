/**
 * v1.28.x — Strava poll-cohort sync handler.
 *
 * Poll-only: Strava has a Webhook Events API, but this ship runs the simpler
 * poll model (matching Polar/Oura/Fitbit). One hourly cron tick carries no
 * `userId` and the handler iterates every user with a stored Strava token,
 * re-syncing each via `syncUserStrava`. One user's revoked grant / outage is
 * warned and the pass continues. The shared control flow lives in
 * `./poll-cohort`.
 *
 * The queue name, cron schedule, and boss.work registration live in
 * `register-integration-sync.ts`.
 */
import { ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import { recordStravaFailure, syncUserStrava } from "@/lib/strava/sync";
import { makePollCohortHandler, type PollCohortPayload } from "./poll-cohort";

export type StravaSyncPayload = PollCohortPayload;

export const handleStravaSync = makePollCohortHandler({
  taskName: "job.strava_sync",
  findCohort: async (prisma) => {
    const users = await prisma.user.findMany({
      where: { stravaAccessTokenEncrypted: { not: null }, ...ACTIVE_ACCOUNT },
      select: { id: true },
    });
    return users.map((u) => u.id);
  },
  syncUser: (userId) => syncUserStrava(userId),
  // Strava records + marks every failure at its source today, so this is inert
  // now — it's the net for a future unmarked escape (matching the cohort's
  // contract that every provider supplies a recorder).
  recordFailure: recordStravaFailure,
});
