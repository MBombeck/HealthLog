/**
 * v1.17.0 — Polar poll-cohort sync handler.
 * v1.32.15 — the per-user arm now runs BOTH Polar legs: vitals
 * (`syncUserPolar`) then exercises/workouts (`syncUserPolarWorkouts`).
 *
 * Poll-only: Polar AccessLink has a webhook, but HealthLog runs the simpler
 * poll model (matching Nightscout). One hourly cron tick carries no `userId`
 * and the handler iterates every user with a stored Polar token, re-syncing
 * each via `syncUserPolarLegs`. One user's revoked grant / outage is warned and
 * the pass continues. The shared control flow lives in `./poll-cohort`.
 *
 * The queue name, cron schedule, and boss.work registration live in
 * reminder-worker.ts — no new queue: the workout leg rides the existing hourly
 * `polar-sync` tick (one extra request per connected user per hour).
 */
import { ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import { recordPolarSyncFailure, syncUserPolar } from "@/lib/polar/sync";
import { syncUserPolarWorkouts } from "@/lib/polar/sync-workouts";
import type { SyncWriteResult } from "@/lib/outcome/written-outcome";
import { makePollCohortHandler, type PollCohortPayload } from "./poll-cohort";

export type PolarSyncPayload = PollCohortPayload;

/**
 * Run both Polar legs for one user with INDEPENDENT attribution on the shared
 * `polar` ledger. Sequentially awaited (not `Promise.all`) so a workouts error
 * stays attributable, and so the vitals leg can tell the workouts leg whether
 * the token just worked (a 403 on exercises is then a per-type refusal). Each
 * leg records its own failure and its own success. A failure in either leg is isolated — both legs are
 * always attempted, so a workouts-leg failure can never mask a vitals success
 * and vice versa — then the FIRST error is rethrown so the cohort handler warns
 * and skips this user's success accounting without losing the error.
 *
 * The vitals leg (`syncUserPolar`) now settles its five collections
 * independently: a fetch/map failure on one collection is recorded as a partial
 * failure and the leg RETURNS (no rethrow, no success stamp), importing the
 * healthy collections. So the vitals leg reaching this wrapper's catch means a
 * write-path/unexpected error, not a collection fetch failure.
 */
export async function syncUserPolarLegs(
  userId: string,
): Promise<SyncWriteResult> {
  let total = 0;
  let firstError: unknown;
  let hadError = false;
  // A settled-but-partial vitals leg neither throws nor reduces the count, so
  // it has to be carried explicitly — otherwise a run in which four of five
  // collections failed reads exactly like a clean one.
  let partial = false;
  let tokenProven = false;

  try {
    const vitals = await syncUserPolar(userId);
    total += vitals.imported;
    partial = vitals.failed;
    tokenProven = vitals.tokenProven;
  } catch (err) {
    firstError = err;
    hadError = true;
  }

  try {
    total += await syncUserPolarWorkouts(userId, { tokenProven });
  } catch (err) {
    if (!hadError) {
      firstError = err;
      hadError = true;
    }
  }

  if (hadError) throw firstError;
  return { imported: total, failed: partial };
}

export const handlePolarSync = makePollCohortHandler({
  taskName: "job.polar_sync",
  findCohort: async (prisma) => {
    const users = await prisma.user.findMany({
      where: { polarAccessTokenEncrypted: { not: null }, ...ACTIVE_ACCOUNT },
      select: { id: true },
    });
    return users.map((u) => u.id);
  },
  // The cohort accounts in rows imported; a partial vitals leg is already on
  // the `polar` ledger, recorded by the leg that saw it.
  syncUser: async (userId) => (await syncUserPolarLegs(userId)).imported,
  // Catches an UNMARKED escape — the `upsertPolarMeasurements` /
  // `upsertPolarWorkouts` write-path throw. The vitals leg records its own
  // per-collection partial failures inline and returns without rethrowing; the
  // workouts leg records + marks its own fetch failures. Only an unmarked
  // write-path/unexpected escape reaches this boundary recorder.
  recordFailure: recordPolarSyncFailure,
});
