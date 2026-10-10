import pLimit from "p-limit";
import { prisma } from "@/lib/db";
import { annotate, getEvent } from "@/lib/logging/context";
import { recordSyncSuccess } from "@/lib/integrations/status";
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
import { withGoogleHealthSyncLock } from "./sync-lock";
import {
  GOOGLE_HEALTH_INTEGRATION_KEY,
  getValidToken,
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
  /**
   * Set when nothing ran because another run for this account holds the
   * account's sync lock (a backfill, the hourly poll, a manual trigger).
   * `failed` is true alongside it so a caller that ignores the flag cannot
   * mistake the skipped run for a clean one.
   */
  busy?: true;
}

/**
 * Whether an account's Google Health connection is parked for a reason no
 * retry can fix, so the run is not attempted.
 *
 * `parked` (a persistent failure older than a day) is one: it waits for the
 * operator or the user to resume it. `error_reauth` is one only when the
 * grant itself was refused: the token endpoint answered `invalid_grant` or
 * 401, which `getValidToken` marks on the connection as `needsReauth`. The
 * ledger also reaches `error_reauth` from a 401 on a data request, and that
 * one says nothing certain about the grant: an access token that expired
 * part-way through a long walk produced it, with a refresh token that was
 * still valid, and the account stayed parked until it was reconnected by
 * hand (#1194). Such a connection is not parked here; the next run refreshes
 * the token first, a refresh that works clears the state when the run
 * completes, and a refresh that is refused marks `needsReauth` and parks it
 * properly.
 */
export async function isGoogleHealthParked(userId: string): Promise<boolean> {
  const state = await ledgerState(userId);
  if (state === "parked") return true;
  if (state !== "error_reauth") return false;
  const connection = await prisma.googleHealthConnection.findUnique({
    where: { userId },
    select: { needsReauth: true },
  });
  return connection?.needsReauth !== false;
}

async function ledgerState(userId: string): Promise<string | null> {
  const row = await prisma.integrationStatus.findUnique({
    where: {
      userId_integration: {
        userId,
        integration: GOOGLE_HEALTH_INTEGRATION_KEY,
      },
    },
    select: { state: true },
  });
  return row?.state ?? null;
}

/** Options for one `syncUserGoogleHealth` run. */
export interface GoogleHealthSyncOptions {
  fullSync?: boolean;
  /**
   * How long to wait for another run of this account to let go of the
   * account's sync lock. Zero (the default) answers `busy` at once.
   */
  waitForLockMs?: number;
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
  opts: GoogleHealthSyncOptions = {},
): Promise<GoogleHealthSyncResult> {
  if (await isGoogleHealthParked(userId)) {
    getEvent()?.addWarning(
      `google-health sync skipped for ${userId}: parked at error_reauth`,
    );
    return { state: "failed", imported: 0, failed: true, resources: [] };
  }

  const run = await withGoogleHealthSyncLock(
    userId,
    () => runGoogleHealthSyncCycle(userId, opts),
    { waitMs: opts.waitForLockMs ?? 0 },
  );
  if (!run.ran) {
    annotate({ meta: { "googleHealth.sync.busy": true } });
    return {
      state: "in_progress",
      imported: 0,
      failed: true,
      resources: [],
      busy: true,
    };
  }
  return run.result;
}

/** One sync cycle, run while holding the account's sync lock. */
async function runGoogleHealthSyncCycle(
  userId: string,
  opts: GoogleHealthSyncOptions,
): Promise<GoogleHealthSyncResult> {
  const cycleStartedAt = new Date();
  const connection = await prisma.googleHealthConnection.findUnique({
    where: { userId },
    select: { lastSyncedAt: true },
  });
  if (!connection) {
    return { state: "failed", imported: 0, failed: true, resources: [] };
  }

  // A connection held at `error_reauth` by a data request's 401 (see
  // `isGoogleHealthParked`) gets a fresh token before anything else: the
  // refresh is the one call that can tell an expired access token from a
  // revoked grant. Refused, it records the reauth and the run stops here.
  if ((await ledgerState(userId)) === "error_reauth") {
    const probe = await runWithGoogleHealthSyncCycle(() =>
      getValidToken(userId, { forceRefresh: true }),
    );
    if (!probe.result) {
      return { state: "failed", imported: 0, failed: true, resources: [] };
    }
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
    await markSynced(userId, cycleStartedAt);
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
