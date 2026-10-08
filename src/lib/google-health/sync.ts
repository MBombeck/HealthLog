import pLimit from "p-limit";
import { prisma } from "@/lib/db";
import { annotate, getEvent } from "@/lib/logging/context";
import { isReauthRequired, recordSyncSuccess } from "@/lib/integrations/status";
import {
  collapseToTypeDayKeys,
  recomputeUserRollups,
} from "@/lib/rollups/measurement-rollups";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/comprehensive-generate";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import {
  runWithGoogleHealthClientOutcome,
  type GoogleHealthClientOutcome,
} from "./client";
import { syncUserActivity } from "./sync-activity";
import { syncUserMetrics } from "./sync-metrics";
import { syncUserSleep } from "./sync-sleep";
import { syncUserWorkout } from "./sync-workout";
import {
  GOOGLE_HEALTH_INTEGRATION_KEY,
  incrementalStart,
  intradayOverlapMs,
  markSynced,
  runWithGoogleHealthSyncCycle,
  type GoogleHealthResourceSyncOptions,
} from "./sync-core";
import {
  startGoogleHealthSyncProgress,
  updateGoogleHealthSyncProgress,
  type GoogleHealthReasonCode,
  type GoogleHealthResourceOutcome,
  type GoogleHealthResourceStatus,
  type GoogleHealthSyncState,
} from "./sync-progress";

export interface GoogleHealthSyncResult {
  runId?: string;
  state?: GoogleHealthSyncState;
  imported: number;
  failed: boolean;
  resources?: GoogleHealthResourceOutcome[];
}

const RESOURCE_STATUSES = new Set<GoogleHealthResourceStatus>([
  "pending",
  "complete",
  "partial",
  "empty",
  "truncated",
  "failed",
]);
const REASON_CODES = new Set<GoogleHealthReasonCode>([
  "collection_failed",
  "token_failed",
  "upsert_failed",
  "rollup_failed",
  "existing_page_limit",
]);

function boundedCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(2_147_483_647, Math.max(0, Math.trunc(value)))
    : 0;
}

function boundedOutcome(value: unknown): GoogleHealthResourceOutcome {
  const item =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const status = RESOURCE_STATUSES.has(
    item.status as GoogleHealthResourceStatus,
  )
    ? (item.status as GoogleHealthResourceStatus)
    : "failed";
  const reasonCode = REASON_CODES.has(item.reasonCode as GoogleHealthReasonCode)
    ? (item.reasonCode as GoogleHealthReasonCode)
    : null;
  return {
    resource:
      typeof item.resource === "string"
        ? item.resource
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .slice(0, 48)
        : "unknown",
    pages: boundedCount(item.pages),
    fetched: boundedCount(item.fetched),
    mapped: boundedCount(item.mapped),
    written: boundedCount(item.written),
    status,
    durationMs: Math.min(86_400_000, boundedCount(item.durationMs)),
    truncated: item.truncated === true,
    reasonCode,
  };
}

function terminalResourceOutcome(
  resource: string,
  imported: number,
  outcome: GoogleHealthClientOutcome,
  durationMs: number,
): GoogleHealthResourceOutcome {
  const written = outcome.written || imported;
  const mapped = outcome.mapped || imported;
  const fetched = outcome.fetched || imported;
  const pages = outcome.pages || (fetched > 0 ? 1 : 0);
  const status: GoogleHealthResourceStatus = outcome.truncated
    ? "truncated"
    : outcome.reasonCode
      ? written > 0
        ? "partial"
        : "failed"
      : fetched === 0 && written === 0
        ? "empty"
        : "complete";
  return boundedOutcome({
    resource,
    pages,
    fetched,
    mapped,
    written,
    status,
    durationMs,
    truncated: outcome.truncated,
    reasonCode: outcome.reasonCode,
  });
}

/**
 * Full per-user sync across every Google Health resource. The incremental
 * watermark is snapshotted once, every leaf receives the same lower bound, and
 * the connection is stamped only after a non-degenerate cycle completes.
 */
export async function syncUserGoogleHealth(
  userId: string,
  opts: { fullSync?: boolean } = {},
): Promise<GoogleHealthSyncResult> {
  if (await isReauthRequired(userId, GOOGLE_HEALTH_INTEGRATION_KEY)) {
    getEvent()?.addWarning(
      `google-health sync skipped for ${userId}: parked at error_reauth`,
    );
    return { state: "failed", imported: 0, failed: true, resources: [] };
  }

  const connection = await prisma.googleHealthConnection.findUnique({
    where: { userId },
    select: { lastSyncedAt: true },
  });
  if (!connection) {
    return { state: "failed", imported: 0, failed: true, resources: [] };
  }

  const progress = await startGoogleHealthSyncProgress(userId);
  const persistProgress = async (
    state: GoogleHealthSyncState,
    imported: number,
    failed: boolean,
    resources: GoogleHealthResourceOutcome[],
  ): Promise<void> => {
    await updateGoogleHealthSyncProgress(userId, progress.runId, {
      state,
      startedAt: progress.startedAt,
      imported,
      failed,
      resources,
    }).catch((err) => {
      getEvent()?.addWarning(
        `google-health progress write failed for ${userId}: ${err}`,
      );
    });
  };

  const start = incrementalStart(connection.lastSyncedAt, {
    fullSync: opts.fullSync,
  });
  const intradayStart = incrementalStart(connection.lastSyncedAt, {
    fullSync: opts.fullSync,
    overlapMs: intradayOverlapMs(
      connection.lastSyncedAt,
      await resolveUserTimezone(userId),
    ),
  });
  const resourceOpts: GoogleHealthResourceSyncOptions = {
    fullSync: opts.fullSync,
    start,
    intradayStart,
    deferRollup: opts.fullSync === true,
  };
  const resources = [
    { name: "workout", fn: syncUserWorkout },
    { name: "sleep", fn: syncUserSleep },
    { name: "activity", fn: syncUserActivity },
    { name: "dense-heart-rate", fn: syncUserMetrics },
  ];

  const cycle = await runWithGoogleHealthSyncCycle(async () => {
    let total = 0;
    let anyFailed = false;
    const resourceOutcomes: GoogleHealthResourceOutcome[] = [];
    for (const { name, fn } of resources) {
      const startedAt = performance.now();
      try {
        const tracked = await runWithGoogleHealthClientOutcome(() =>
          fn(userId, resourceOpts),
        );
        total += tracked.result;
        const outcome = terminalResourceOutcome(
          name,
          tracked.result,
          tracked.outcome,
          performance.now() - startedAt,
        );
        resourceOutcomes.push(outcome);
        if (
          outcome.status === "failed" ||
          outcome.status === "partial" ||
          outcome.status === "truncated"
        ) {
          anyFailed = true;
        }
      } catch (err) {
        anyFailed = true;
        resourceOutcomes.push(
          boundedOutcome({
            resource: name,
            status: "failed",
            durationMs: performance.now() - startedAt,
            reasonCode: "collection_failed",
          }),
        );
        getEvent()?.addWarning(
          `google-health ${name} sync failed for ${userId}: ${err}`,
        );
      }
      await persistProgress("in_progress", total, anyFailed, resourceOutcomes);
    }
    return { total, anyFailed, resources: resourceOutcomes };
  });

  const total = cycle.result.total;
  let anyFailed = cycle.result.anyFailed || cycle.hardFailures.length > 0;
  const suppliedResources = (cycle as unknown as { resources?: unknown })
    .resources;
  const outcomeSource = Array.isArray(suppliedResources)
    ? suppliedResources
    : cycle.result.resources;
  const resourceOutcomes = outcomeSource.map(boundedOutcome);

  if (opts.fullSync && cycle.deferredRollupKeys.length > 0) {
    try {
      const days = collapseToTypeDayKeys(cycle.deferredRollupKeys);
      const types = Array.from(new Set(days.map((key) => key.type)));
      const sorted = days
        .map((key) => key.measuredAt.getTime())
        .sort((a, b) => a - b);
      const from = new Date(sorted[0]!);
      const to = new Date(sorted[sorted.length - 1]! + 24 * 60 * 60 * 1000);
      await recomputeUserRollups(userId, { types, from, to });
      invalidateStatusInsightsForTypes(userId, types).catch((err) => {
        getEvent()?.addWarning(
          `google-health: status-insight invalidate failed for ${userId}: ${err}`,
        );
      });
    } catch (err) {
      anyFailed = true;
      resourceOutcomes.push(
        boundedOutcome({
          resource: "rollup",
          fetched: cycle.deferredRollupKeys.length,
          mapped: cycle.deferredRollupKeys.length,
          written: total,
          status: "failed",
          durationMs: 0,
          reasonCode: "rollup_failed",
        }),
      );
      getEvent()?.addWarning(
        `google-health: backfill rollup recompute failed for ${userId}: ${err}`,
      );
    }
  }

  const allSoftSkipped = cycle.softSkipCount >= resources.length && total === 0;
  const truncated = resourceOutcomes.some((resource) => resource.truncated);
  const failed = anyFailed || allSoftSkipped || truncated;

  if (!failed) {
    await markSynced(userId);
    await recordSyncSuccess(userId, GOOGLE_HEALTH_INTEGRATION_KEY);
  }

  // Background-sync posture (mirrors the Fitbit tail): mark the per-user
  // analytics / correlations / targets / achievements cells stale so the
  // imported rows reach the cached readers before their TTL lapses — the
  // correlations route documents exactly this invariant. Fires on a
  // partial failure too: rows that DID land must not stay invisible.
  if (total > 0) {
    invalidateUserMeasurements(userId);
  }

  annotate({
    action: { name: "googleHealth.sync", details: { imported: total, failed } },
  });
  const state: GoogleHealthSyncState = truncated
    ? "truncated"
    : failed
      ? total > 0
        ? "partial"
        : "failed"
      : total === 0
        ? "zero"
        : "complete";
  await persistProgress(state, total, failed, resourceOutcomes);
  return {
    runId: progress.runId,
    state,
    imported: total,
    failed,
    resources: resourceOutcomes,
  };
}

/** Bounded fan-out width for the hourly Google Health cohort poll. */
export const GOOGLE_HEALTH_POLL_CONCURRENCY = 4;

/**
 * Run an hourly-poll cohort with bounded concurrency and per-user isolation.
 */
export async function runGoogleHealthPollCohort(
  userIds: string[],
  opts: {
    concurrency?: number;
    sync?: (userId: string) => Promise<number>;
    onUserError?: (userId: string, err: unknown) => void;
    onUserSynced?: (userId: string, imported: number) => void;
  } = {},
): Promise<{ usersSynced: number; measurementsImported: number }> {
  const sync =
    opts.sync ??
    (async (userId: string) => {
      const result = await syncUserGoogleHealth(userId);
      return result.imported;
    });
  const limit = pLimit(opts.concurrency ?? GOOGLE_HEALTH_POLL_CONCURRENCY);

  let usersSynced = 0;
  let measurementsImported = 0;
  await Promise.all(
    userIds.map((userId) =>
      limit(async () => {
        try {
          const imported = await sync(userId);
          measurementsImported = measurementsImported + imported;
          usersSynced = usersSynced + 1;
          opts.onUserSynced?.(userId, imported);
        } catch (err) {
          opts.onUserError?.(userId, err);
        }
      }),
    ),
  );

  return { usersSynced, measurementsImported };
}
