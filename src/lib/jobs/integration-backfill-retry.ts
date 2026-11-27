/**
 * What the shared admission drain does when an import slice throws.
 *
 * Before, every throw went to pg-boss's retry policy: three retries one, two
 * and four minutes apart. A provider whose API answered 500 for ten minutes
 * used up all four attempts inside that outage, the job failed for good, and
 * the history import sat still until the next restart's discovery offered it
 * again. The import had kept its place the whole time; only the chain was
 * gone.
 *
 * Now the drain reads why the slice failed:
 *
 *   - transient (a 5xx, a 429, a timeout, a dropped connection): the slice is
 *     sent again as the next slice of the same chain, after a backoff that
 *     doubles from five minutes up to six hours, with jitter, and never
 *     sooner than the provider's `Retry-After`. The progress note the runner
 *     keeps is untouched, so the retry starts where the failed slice stopped.
 *     After `INTEGRATION_BACKFILL_TRANSIENT_ATTEMPTS` failed runs in a row the
 *     chain gives up: the failure goes on the integration's ledger under the
 *     `backfill` leg, so the card shows it, and the job fails with the
 *     slice's own message, so system status names the integration and slice.
 *     The next restart's discovery offers the import again from its note.
 *   - permanent (the provider refused the credentials): no retry can help.
 *     The connection is parked for re-authorisation, which the card shows as
 *     "reconnect", unless the runner already did that.
 *   - anything else (a database error, a bug): unchanged, the pg-boss retry.
 *
 * A slice that makes progress sends its follow-up without a retry count, so
 * the count is of failures in a row, not in all.
 */
import type { Job, JobWithMetadata } from "pg-boss";

import { IntegrationApiError } from "@/lib/integrations/http-status-classifier";
import { RETRY_AFTER_CAP_MS } from "@/lib/integrations/oauth-kit/retry-after";
import {
  isReauthRequired,
  isSyncFailureRecorded,
  recordSyncFailure,
  type IntegrationKey,
} from "@/lib/integrations/status";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  enqueueIntegrationBackfillAdmission,
  type IntegrationBackfillAdmissionPayload,
  type IntegrationBackfillKind,
} from "@/lib/jobs/integration-backfill-admission";
import { annotate } from "@/lib/logging/context";

/** Failed runs in a row a slice gets before the chain gives up. */
export const INTEGRATION_BACKFILL_TRANSIENT_ATTEMPTS = 8;

/** The wait after the first failure; it doubles with every further one. */
export const INTEGRATION_BACKFILL_RETRY_BASE_SECONDS = 5 * 60;

/** The longest wait between two attempts. */
export const INTEGRATION_BACKFILL_RETRY_CAP_SECONDS = 6 * 60 * 60;

/** The ledger leg a backfill failure is recorded under. */
export const INTEGRATION_BACKFILL_LEG = "backfill";

export type BackfillFailure =
  | {
      kind: "transient";
      /** The provider's error, or the network failure, the chain led to. */
      error: Error;
      httpStatus?: number;
      retryAfterMs?: number;
    }
  | { kind: "permanent"; httpStatus?: number; error: IntegrationApiError }
  | { kind: "other" };

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

function errorCode(err: object): string | undefined {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isNetworkFailure(err: Error): boolean {
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  const code = errorCode(err);
  if (code && (NETWORK_CODES.has(code) || code.startsWith("UND_ERR_"))) {
    return true;
  }
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}

function retryAfterOf(err: object): number | undefined {
  const value = (err as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Why an import slice failed, read off the error and its `cause` chain (a
 * runner wraps the provider's error in its own message).
 */
export function classifyBackfillFailure(err: unknown): BackfillFailure {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof IntegrationApiError) {
      if (current.classification === "reauth_required") {
        return {
          kind: "permanent",
          httpStatus: current.httpStatus,
          error: current,
        };
      }
      if (current.classification === "transient") {
        const retryAfterMs = retryAfterOf(current);
        return {
          kind: "transient",
          error: current,
          ...(current.httpStatus !== undefined
            ? { httpStatus: current.httpStatus }
            : {}),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        };
      }
      return { kind: "other" };
    }
    if (isNetworkFailure(current)) return { kind: "transient", error: current };
    current = current.cause;
  }
  return { kind: "other" };
}

/**
 * The wait before attempt `failures + 1`: the doubled base, capped, with
 * equal jitter (half fixed, half random) so a fleet of instances that met
 * the same outage does not come back in step. A `Retry-After` is a floor.
 */
export function backfillRetryDelaySeconds(
  failures: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(
    INTEGRATION_BACKFILL_RETRY_CAP_SECONDS,
    INTEGRATION_BACKFILL_RETRY_BASE_SECONDS * 2 ** Math.max(0, failures - 1),
  );
  const jittered = Math.ceil(exp / 2 + random() * (exp / 2));
  const floor =
    retryAfterMs === undefined
      ? 0
      : Math.ceil(Math.min(retryAfterMs, RETRY_AFTER_CAP_MS) / 1000);
  return Math.max(jittered, floor);
}

/** The ledger an import's failure belongs on; null for internal repairs. */
function integrationOf(
  payload: IntegrationBackfillAdmissionPayload,
): IntegrationKey | null {
  const map: Record<IntegrationBackfillKind, IntegrationKey | null> = {
    "whoop-backfill": "whoop",
    "google-health-backfill": "google-health",
    "google-health-sleep-repair": "google-health",
    "sleep-timeline-backfill":
      payload.data.provider === "WITHINGS" ? "withings" : "whoop",
    "lab-biomarker-backfill": null,
    "strava-backfill": "strava",
    "oura-backfill": "oura",
    "garmin-backfill": "garmin",
  };
  return map[payload.kind];
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What the drain does with a slice that threw. */
export type BackfillFailureOutcome =
  { handled: true } | { handled: false; error: unknown };

/**
 * Decide on a thrown slice. `handled` means the job may complete: the slice
 * was sent again. Otherwise the job fails with `error`.
 */
export async function handleBackfillFailure(
  job: Job<IntegrationBackfillAdmissionPayload>,
  err: unknown,
): Promise<BackfillFailureOutcome> {
  const payload = job.data;
  const failure = classifyBackfillFailure(err);
  const integration = integrationOf(payload);
  const slice = payload.data.slice ?? 0;

  if (failure.kind === "permanent") {
    if (
      integration &&
      !isSyncFailureRecorded(failure.error) &&
      !(await isReauthRequired(payload.data.userId, integration))
    ) {
      await recordSyncFailure({
        userId: payload.data.userId,
        integration,
        kind: "reauth_required",
        message: failure.error.message,
        ...(failure.httpStatus !== undefined
          ? { errorCode: String(failure.httpStatus) }
          : {}),
        leg: INTEGRATION_BACKFILL_LEG,
      });
    }
    annotate({
      action: {
        name: "integration_backfill.refused",
        details: { kind: payload.kind, slice, status: failure.httpStatus },
      },
    });
    return { handled: false, error: err };
  }

  if (failure.kind !== "transient") return { handled: false, error: err };

  const failures = (payload.data.retry ?? 0) + 1;
  if (failures < INTEGRATION_BACKFILL_TRANSIENT_ATTEMPTS) {
    const delaySeconds = backfillRetryDelaySeconds(
      failures,
      failure.retryAfterMs,
    );
    const boss = getGlobalBoss();
    const sent = boss
      ? await enqueueIntegrationBackfillAdmission(
          boss,
          {
            kind: payload.kind,
            data: {
              ...payload.data,
              enqueuedAt: new Date().toISOString(),
              slice: slice + 1,
              retry: failures,
            },
          },
          delaySeconds,
        )
      : null;
    if (sent) {
      annotate({
        action: {
          name: "integration_backfill.retry_scheduled",
          details: {
            kind: payload.kind,
            slice,
            attempt: failures,
            status: failure.httpStatus,
            delaySeconds,
          },
        },
      });
      return { handled: true };
    }
    // Not sent (no queue, or the same follow-up is already waiting): the
    // pg-boss retry and the next restart's discovery remain.
    return { handled: false, error: err };
  }

  // Given up. The ledger hears it once per chain, not once per pg-boss retry
  // of the job that gave up.
  const retryCount =
    (job as Partial<JobWithMetadata<IntegrationBackfillAdmissionPayload>>)
      .retryCount ?? 0;
  if (integration && retryCount === 0) {
    await recordSyncFailure({
      userId: payload.data.userId,
      integration,
      kind: "transient",
      // The provider's own message (`Garmin dailySummaries error: 500`), not
      // the runner's, which names the account.
      message: `History import paused after ${failures} failed attempts: ${failure.error.message}`,
      ...(failure.httpStatus !== undefined
        ? { errorCode: String(failure.httpStatus) }
        : {}),
      leg: INTEGRATION_BACKFILL_LEG,
    });
  }
  annotate({
    action: {
      name: "integration_backfill.gave_up",
      details: {
        kind: payload.kind,
        slice,
        attempts: failures,
        status: failure.httpStatus,
      },
    },
  });
  return {
    handled: false,
    error: new Error(`gave up after ${failures} attempts: ${messageOf(err)}`, {
      cause: err,
    }),
  };
}
