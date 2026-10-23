/**
 * v1.17.0 — shared poll-cohort job-handler factory.
 *
 * The Polar, Oura and Nightscout sync handlers were byte-identical wrappers
 * differing only in three things: the wide-event task name, the cohort
 * discovery query (which credential column marks a connected user), and the
 * per-user `syncUser*` callback. This factory lifts the shared control flow —
 * targets from the job payloads or, on a `userId`-less cron tick, from the
 * cohort query; a sequential pass with per-user error isolation; and the
 * `users_synced` / `total` / `measurements_imported` background result.
 *
 * Each provider file collapses to a small config calling `makePollCohortHandler`.
 * The queue name, cron schedule, and boss.work registration stay in
 * reminder-worker.ts.
 *
 * Fitbit is intentionally NOT built on this factory: it fans the cohort out
 * with bounded concurrency via `runFitbitPollCohort`, a different control flow
 * from this sequential pass.
 */
import { type Job } from "pg-boss";
import { fireAndForget } from "@/lib/logging/fire-and-forget";

import { recordError } from "@/lib/jobs/worker-status";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import { isSyncFailureRecorded } from "@/lib/integrations/status";
import { getWorkerPrisma } from "./shared";

export type IntegrationCohortProvider = "google_health" | "withings";

export type IntegrationUserVerdict = Readonly<{
  status: "complete" | "partial" | "failed" | "parked" | "skipped";
  imported: number;
  downstreamFailed?: boolean;
  retryable?: boolean;
  reasonCode?: string;
}>;

export type IntegrationCohortFacts = Readonly<{
  provider: IntegrationCohortProvider;
  outcome: "useful" | "clean_zero";
  total: number;
  users_synced: number;
  users_complete: number;
  users_partial: number;
  users_failed: number;
  users_parked: number;
  users_skipped: number;
  users_useful: number;
  users_clean_zero: number;
  users_retryable: number;
  downstream_failed: number;
  measurements_imported: number;
}>;

export function foldIntegrationCohortOutcomes(input: {
  provider: IntegrationCohortProvider;
  verdicts: readonly IntegrationUserVerdict[];
  downstreamFailures?: number;
}): { readonly ok: true; readonly did: IntegrationCohortFacts } {
  let usersComplete = 0;
  let usersPartial = 0;
  let usersFailed = 0;
  let usersParked = 0;
  let usersSkipped = 0;
  let usersUseful = 0;
  let usersCleanZero = 0;
  let usersRetryable = 0;
  if (
    input.downstreamFailures !== undefined &&
    (!Number.isSafeInteger(input.downstreamFailures) ||
      input.downstreamFailures < 0)
  ) {
    throw new TypeError(
      "cohort downstream failure count must be a non-negative safe integer",
    );
  }
  let downstreamFailed = input.downstreamFailures ?? 0;
  let measurementsImported = 0;

  for (const verdict of input.verdicts) {
    if (!Number.isSafeInteger(verdict.imported) || verdict.imported < 0) {
      throw new TypeError(
        "cohort imported count must be a non-negative safe integer",
      );
    }

    switch (verdict.status) {
      case "complete":
        usersComplete++;
        if (verdict.imported === 0) usersCleanZero++;
        break;
      case "partial":
        usersPartial++;
        break;
      case "failed":
        usersFailed++;
        break;
      case "parked":
        usersParked++;
        break;
      case "skipped":
        usersSkipped++;
        break;
      default: {
        const exhaustive: never = verdict.status;
        throw new TypeError(`unsupported cohort status: ${String(exhaustive)}`);
      }
    }

    if (
      (verdict.status === "complete" || verdict.status === "partial") &&
      verdict.imported > 0
    ) {
      usersUseful++;
    }
    if (verdict.retryable === true) usersRetryable++;
    if (verdict.downstreamFailed === true) {
      if (!Number.isSafeInteger(downstreamFailed + 1)) {
        throw new RangeError(
          "cohort downstream failure total exceeds safe integer range",
        );
      }
      downstreamFailed++;
    }

    const nextImported = measurementsImported + verdict.imported;
    if (!Number.isSafeInteger(nextImported)) {
      throw new RangeError("cohort imported total exceeds safe integer range");
    }
    measurementsImported = nextImported;
  }

  return jobDone({
    provider: input.provider,
    outcome: usersUseful > 0 ? "useful" : "clean_zero",
    total: input.verdicts.length,
    users_synced: usersComplete,
    users_complete: usersComplete,
    users_partial: usersPartial,
    users_failed: usersFailed,
    users_parked: usersParked,
    users_skipped: usersSkipped,
    users_useful: usersUseful,
    users_clean_zero: usersCleanZero,
    users_retryable: usersRetryable,
    downstream_failed: downstreamFailed,
    measurements_imported: measurementsImported,
  }) as { readonly ok: true; readonly did: IntegrationCohortFacts };
}

/** Every poll-cohort handler accepts an optional single-user payload. */
export interface PollCohortPayload {
  userId?: string;
}

export interface PollCohortConfig {
  /** Wide-event task name, e.g. `job.polar_sync`. */
  taskName: string;
  /**
   * Cohort discovery for a `userId`-less cron tick: returns every connected
   * user's id. Receives the worker Prisma client.
   */
  findCohort: (prisma: ReturnType<typeof getWorkerPrisma>) => Promise<string[]>;
  /** Sync one user; returns the count of measurements imported. */
  syncUser: (userId: string) => Promise<number>;
  /**
   * Record a per-user sync failure that escaped `syncUser` UNRECORDED. Called
   * only for an error the source site did not already mark via
   * `markSyncFailureRecorded` — so a provider that records-then-rethrows never
   * double-records, and the recorder keeps classification + secret redaction
   * provider-owned (a boundary-blind recorder would leak Nightscout's
   * token-bearing URL into `lastError`). A rejection here never breaks the
   * cohort loop.
   */
  recordFailure: (userId: string, err: unknown) => Promise<void>;
}

/**
 * Build a pg-boss batch handler for a poll-only integration. The returned
 * handler resolves its targets from the batch payloads (single-user enqueue) or
 * the cohort query (cron tick), then re-syncs each sequentially with per-user
 * error isolation so one revoked grant / outage never starves the cohort.
 *
 * Outcome semantics for a fan-out pass: the JOB succeeded if the pass ran.
 * One user's revoked grant is that user's problem — it belongs on their
 * integration ledger, not in a queue-wide failure that retries the whole
 * cohort — so per-user failures ride out as the `users_failed` count. Only a
 * failure of the pass itself (cohort discovery, the wide-event scope) fails
 * the job, and that path already throws.
 */
export function makePollCohortHandler({
  taskName,
  findCohort,
  syncUser,
  recordFailure,
}: PollCohortConfig) {
  return async function handlePollCohort(
    jobs: Job<PollCohortPayload>[],
  ): Promise<JobOutcome> {
    return withBackgroundEvent(taskName, async (evt) => {
      const prisma = getWorkerPrisma();
      try {
        const targets: Array<{ userId: string }> = [];
        for (const job of jobs) {
          if (job.data?.userId) targets.push({ userId: job.data.userId });
        }
        if (targets.length === 0) {
          const ids = await findCohort(prisma);
          targets.push(...ids.map((userId) => ({ userId })));
        }
        if (targets.length === 0) {
          return jobDone({ total: 0, users_synced: 0, users_failed: 0 });
        }

        let usersSynced = 0;
        let usersFailed = 0;
        let measurementsImported = 0;
        for (const { userId } of targets) {
          try {
            const imported = await syncUser(userId);
            measurementsImported += imported;
            usersSynced++;
            // v1.18.1 — a fresh reading landed; resolve this user's Vorsorge
            // reminders eventfully. Fire-and-forget; the cron is the net.
            if (imported > 0) {
              fireAndForget(() => enqueueReminderSatisfy(userId), {
                action: "reminder.satisfy.enqueue",
              });
            }
          } catch (err) {
            // A record-then-rethrow provider already stamped the ledger and
            // marked the error; recording again would double-count the streak
            // and (for Nightscout) risk re-persisting an unredacted message.
            // Only an UNMARKED escape — today's Oura / Polar write-path throw,
            // or any future provider path — is recorded here.
            if (!isSyncFailureRecorded(err)) {
              await recordFailure(userId, err).catch(() => {
                evt.addWarning(`${taskName} recordFailure failed`);
              });
            }
            usersFailed++;
            evt.addWarning(`${taskName} failed for one cohort member`);
          }
        }

        evt.setBackground({
          task_name: taskName,
          result: {
            users_synced: usersSynced,
            users_failed: usersFailed,
            total: targets.length,
            measurements_imported: measurementsImported,
          },
        });
        return jobDone({
          total: targets.length,
          users_synced: usersSynced,
          users_failed: usersFailed,
          measurements_imported: measurementsImported,
        });
      } catch (err) {
        evt.setError(err);
        recordError();
        throw err;
      }
    });
  };
}
