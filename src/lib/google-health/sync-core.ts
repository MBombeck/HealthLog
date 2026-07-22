/**
 * Google Health sync service (v1.27.0).
 *
 * Token-management + per-resource orchestration:
 *   - `getValidToken` decrypts the stored token, refreshes at
 *     `tokenExpiresAt - 5 min`, persists the new access token + expiry, and —
 *     following Google's semantics — only overwrites the stored refresh token
 *     when the response carries a fresh one (Google does NOT rotate refresh
 *     tokens). A revoked / expired refresh token (the 7-day "Testing"-mode
 *     expiry, or a user-revoked grant) surfaces `invalid_grant`/401 →
 *     `reauth_required`, which parks the connection at `error_reauth` so the
 *     card prompts a reconnect.
 *   - `recordGoogleHealthSyncFailure` / `classificationToFailureKind` map a
 *     classified API error onto the shared integration-status ledger.
 *   - `syncUserGoogleHealth` drives the hourly poll, the manual trigger, and the
 *     boot-time backfill across every resource.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { encrypt, decrypt } from "@/lib/crypto";
import { getEvent } from "@/lib/logging/context";
import { emitInsertedMeasurementArrivals } from "@/lib/arrivals/measurement-emit";
import { recordSyncFailure, type FailureKind } from "@/lib/integrations/status";
import {
  collapseToTypeDayKeys,
  recomputeBucketsForMeasurement,
} from "@/lib/rollups/measurement-rollups";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/comprehensive-generate";
import { refreshAccessToken } from "./client";
import { getUserGoogleHealthCredentials } from "./credentials";
import {
  GoogleHealthApiError,
  classifyGoogleHealthError,
  isGoogleHealthReauthRequired,
  type GoogleHealthClassification,
} from "./response-classifier";

/**
 * The status-ledger key for this integration. Distinct from the classic Fitbit
 * `"fitbit"` key so the two coexisting providers keep independent status rows.
 */
export const GOOGLE_HEALTH_INTEGRATION_KEY = "google-health";

/** Refresh the access token this many ms before `tokenExpiresAt`. */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Overlap window for the incremental sync, in ms. Google re-rolls daily
 * summaries after the fact (a daily SpO2 / HRV / RHR can finalise hours after
 * the night), so the default overlap is a full 24 h to make sure the re-rolled
 * row is re-fetched on the next tick. Mirrors WHOOP's recovery/sleep overlap.
 */
export const GOOGLE_HEALTH_DEFAULT_OVERLAP_MS = 24 * 60 * 60 * 1000;

export interface GoogleHealthTokenInfo {
  accessToken: string;
  connection: { id: string; googleUserId: string };
}

/**
 * Resolve a valid Google Health access token for a user, refreshing if it is
 * within the 5-minute expiry buffer. Returns null when there is no connection,
 * no credentials, or the refresh fails (the failure is recorded so scheduled
 * syncs back off).
 *
 * Google does not rotate refresh tokens. On refresh, persist the new access
 * token + expiry and overwrite the stored `refreshToken` ONLY when the response
 * carries a fresh one — otherwise keep the existing refresh token so the next
 * refresh still authenticates.
 */
export async function getValidToken(
  userId: string,
): Promise<GoogleHealthTokenInfo | null> {
  const connection = await prisma.googleHealthConnection.findUnique({
    where: { userId },
  });
  if (!connection) return null;

  const accessToken = decrypt(connection.accessToken);
  const refreshToken = decrypt(connection.refreshToken);

  if (
    connection.tokenExpiresAt.getTime() - TOKEN_REFRESH_BUFFER_MS <
    Date.now()
  ) {
    try {
      const creds = await getUserGoogleHealthCredentials(userId);
      if (!creds) {
        getEvent()?.addWarning(
          `No Google Health credentials found for user ${userId} during token refresh`,
        );
        await recordSyncFailure({
          userId,
          integration: GOOGLE_HEALTH_INTEGRATION_KEY,
          kind: "reauth_required",
          message: "Google Health credentials missing — token refresh skipped",
          errorCode: "credentials_missing",
        });
        // A dead token means every resource "succeeds" with 0 rows — without a
        // ledger entry the cycle would read as clean, stamp `markSynced`, and
        // `recordSyncSuccess` would flip a parked connection back to connected
        // (an hourly invalid-refresh hammer with an advancing watermark). Fail
        // the cycle's verdict so the park holds.
        noteHardFailure(GOOGLE_HEALTH_TOKEN_HARD_FAIL);
        return null;
      }

      const newTokens = await refreshAccessToken(refreshToken, creds);
      const expiresAt = new Date(Date.now() + newTokens.expires_in * 1000);

      // Google does NOT rotate refresh tokens: a routine refresh returns a new
      // access token but usually omits `refresh_token`. Persist the new access
      // token + expiry and only overwrite the stored refresh token when the
      // response actually carries a fresh one — otherwise keep the existing one.
      await prisma.googleHealthConnection.update({
        where: { id: connection.id },
        data: {
          accessToken: encrypt(newTokens.access_token),
          tokenExpiresAt: expiresAt,
          ...(newTokens.refresh_token
            ? { refreshToken: encrypt(newTokens.refresh_token) }
            : {}),
        },
      });

      return {
        accessToken: newTokens.access_token,
        connection: {
          id: connection.id,
          googleUserId: connection.googleUserId,
        },
      };
    } catch (err) {
      getEvent()?.addWarning(
        `Google Health token refresh failed for user ${userId}: ${err}`,
      );
      // A revoked / expired refresh token (`invalid_grant` / 401 — the 7-day
      // Testing-mode refresh expiry, or a user-revoked grant) is a SOFT
      // disconnect: flag `needsReauth` on the connection so the card surfaces a
      // "reconnect" CTA rather than a hard error. The callback clears it on a
      // fresh consent. A transient refresh failure (network blip, 5xx) leaves
      // the flag untouched so we don't nag the user to reconnect needlessly.
      if (isGoogleHealthReauthRequired(err)) {
        await prisma.googleHealthConnection
          .update({
            where: { id: connection.id },
            data: { needsReauth: true },
          })
          .catch((e) =>
            getEvent()?.addWarning(
              `google-health: needsReauth flag write failed for ${userId}: ${e}`,
            ),
          );
      }
      await recordGoogleHealthSyncFailure(userId, err);
      // Same verdict rule as the credentials-missing branch above: a refresh
      // failure must fail the cycle, or the all-zeros run stamps success,
      // un-parks `error_reauth`, and the hourly cohort retries the dead
      // refresh token forever while `lastSyncedAt` advances past real data.
      noteHardFailure(GOOGLE_HEALTH_TOKEN_HARD_FAIL);
      return null;
    }
  }

  return {
    accessToken,
    connection: {
      id: connection.id,
      googleUserId: connection.googleUserId,
    },
  };
}

/**
 * True when a caught error is a per-data-class 403 (forbidden). The Google
 * Health Restricted bundles are granted independently in the consent flow, so a
 * 403 on ONE data class is a scope gate on THAT class — soft-skip it and keep
 * the connection connected rather than parking the whole integration at
 * `error_reauth`. Connection-wide reauth is reserved for a 401 (token rejected)
 * and for a 403 on the token-refresh / profile path (a genuine grant revoke),
 * which run outside the per-resource catch blocks.
 */
export function isCollectionForbidden(err: unknown): boolean {
  return err instanceof GoogleHealthApiError && err.httpStatus === 403;
}

/**
 * Per-`syncUserGoogleHealth`-cycle counter for collection-403 soft-skips.
 * Scoped by AsyncLocalStorage so the count never bleeds across concurrent
 * per-user pg-boss jobs. Mirrors the WHOOP `softSkipStorage` tracker.
 */
interface SoftSkipTracker {
  count: number;
}
const softSkipStorage = new AsyncLocalStorage<SoftSkipTracker>();

/**
 * Per-cycle ledger of collection fetches that HARD-failed (non-403). A hard
 * failure on one collection must not abort its siblings — steps 400ing must
 * not suppress distance / floors / active-energy — so
 * `handleCollectionFetchError` records the failure here and returns instead of
 * rethrowing. The orchestrator reads the ledger to keep the cycle's verdict
 * honest: any entry ⇒ the run counts as failed (partial error), the watermark
 * is NOT stamped, and the next tick refetches the window.
 */
interface HardFailTracker {
  failures: string[];
}
const hardFailStorage = new AsyncLocalStorage<HardFailTracker>();

/**
 * Ledger label for a dead-token failure (`getValidToken` returning null on a
 * missing-credentials or failed-refresh path). Exported so the one-shot jobs
 * that run a single resource inside their own ledger scope can tell "the token
 * is dead" (park, don't retry) apart from "a fetch/write hard-failed" (retry).
 */
export const GOOGLE_HEALTH_TOKEN_HARD_FAIL = "token";

/**
 * Record a hard failure on the ambient per-cycle ledger, if one is in scope.
 * No-op outside a ledger scope (e.g. a direct call from a REPL script). Used by
 * `getValidToken`'s dead-token paths, the measurement write catches, and the
 * workout upsert catch — anything that must fail the cycle's verdict without
 * aborting sibling work.
 */
export function noteHardFailure(label: string): void {
  const tracker = hardFailStorage.getStore();
  if (tracker) tracker.failures.push(label);
}

/**
 * Run `fn` inside a fresh hard-fail ledger scope and surface the collected
 * failures. `syncUserGoogleHealth` owns its own scope; this export exists for
 * the one-shot jobs (sleep repair) that drive a single resource sync directly
 * and must still see a dead token or a hard fetch/write failure before
 * stamping their completion marker.
 */
export async function runWithGoogleHealthHardFailLedger<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; failures: string[] }> {
  const tracker: HardFailTracker = { failures: [] };
  const result = await hardFailStorage.run(tracker, fn);
  return { result, failures: tracker.failures };
}

/**
 * Per-cycle accumulator of the `(type, day)` keys every resource's writes
 * touched. Only populated on a `fullSync` backfill (when the inline per-day
 * rollup hook is deferred); the orchestrator drains it into ONE
 * `recomputeUserRollups(from, to)` pass at the end of the cycle. Scoped by
 * AsyncLocalStorage so concurrent per-user jobs never cross-pollinate.
 */
interface RollupDeferTracker {
  keys: Array<{ type: MeasurementType; measuredAt: Date }>;
}
const rollupDeferStorage = new AsyncLocalStorage<RollupDeferTracker>();

export interface GoogleHealthSyncCycleResult<T> {
  result: T;
  softSkipCount: number;
  hardFailures: string[];
  deferredRollupKeys: Array<{ type: MeasurementType; measuredAt: Date }>;
}

/**
 * Scope every ambient ledger used by one orchestrated sync cycle. Resource
 * leaves record into these ledgers through the helpers in this module; the
 * orchestrator receives a snapshot only after every leaf has completed.
 */
export async function runWithGoogleHealthSyncCycle<T>(
  fn: () => Promise<T>,
): Promise<GoogleHealthSyncCycleResult<T>> {
  const softSkips: SoftSkipTracker = { count: 0 };
  const hardFailures: HardFailTracker = { failures: [] };
  const deferredRollups: RollupDeferTracker = { keys: [] };
  const result = await softSkipStorage.run(softSkips, () =>
    hardFailStorage.run(hardFailures, () =>
      rollupDeferStorage.run(deferredRollups, fn),
    ),
  );
  return {
    result,
    softSkipCount: softSkips.count,
    hardFailures: hardFailures.failures,
    deferredRollupKeys: deferredRollups.keys,
  };
}

/**
 * Single-source the per-resource collection-fetch error handling. A 403 on one
 * data class soft-skips it (warn + return 0) so sibling resources still sync; a
 * soft-skip increments the ambient tracker so `syncUserGoogleHealth` can refuse
 * to stamp success on an all-403 grant-revoke cycle that imported nothing.
 *
 * Anything else records a classified sync failure, warns with the per-type
 * detail, notes the collection on the ambient hard-fail ledger, and RETURNS —
 * it does not rethrow. Every call site sits in a per-collection catch, so
 * returning lets the sibling collections in the same resource keep fetching
 * (one 400 on steps must not kill distance / floors / active-energy), while
 * the ledger still fails the cycle so the watermark is not stamped past the
 * broken collection.
 */
export async function handleCollectionFetchError(
  resource: string,
  userId: string,
  err: unknown,
): Promise<number> {
  if (isCollectionForbidden(err)) {
    getEvent()?.addWarning(
      `google-health ${resource} sync skipped for ${userId}: collection 403 (soft-skip)`,
    );
    const tracker = softSkipStorage.getStore();
    if (tracker) tracker.count += 1;
    return 0;
  }
  await recordGoogleHealthSyncFailure(userId, err);
  getEvent()?.addWarning(
    `google-health ${resource} failed for ${userId}: ${err}`,
  );
  const hardTracker = hardFailStorage.getStore();
  if (hardTracker) hardTracker.failures.push(resource);
  return 0;
}

/**
 * Options threaded from `syncUserGoogleHealth` to each per-resource sync. The
 * `start` watermark is snapshotted ONCE by the orchestrator (a single
 * `lastSyncedAt` read) so every resource fetches from the same lower bound; no
 * resource re-reads `lastSyncedAt` or stamps `markSynced` itself. On a
 * full/backfill run `start` is undefined (no lower bound). The orchestrator owns
 * the single end-of-cycle `markSynced`.
 */
export interface GoogleHealthResourceSyncOptions {
  fullSync?: boolean;
  /** The incremental lower bound, snapshotted once by the orchestrator. */
  start?: Date;
  /**
   * When true, `upsertGoogleHealthMeasurements` writes the rows but SKIPS the
   * inline per-(type,day) DAY-rollup recompute + status-insight invalidate,
   * returning the touched type-days to the caller instead. The orchestrator
   * collapses them into ONE `recomputeUserRollups(from, to)` pass at the end of
   * a `fullSync` cycle, so a multi-year backfill pays a single range-recompute
   * rather than thousands of per-day round-trips. The incremental path leaves
   * this unset and keeps the inline per-day hook.
   */
  deferRollup?: boolean;
}

/**
 * Compute the incremental `start` for a resource sync. `fullSync` returns
 * undefined (the backfill walks deep history without a lower bound). Otherwise
 * start from `lastSyncedAt - overlap`, or 30 days back on the very first
 * incremental tick. Mirrors WHOOP's `incrementalStart`.
 */
export function incrementalStart(
  lastSyncedAt: Date | null,
  opts: { fullSync?: boolean; overlapMs?: number } = {},
): Date | undefined {
  if (opts.fullSync) return undefined;
  const overlap = opts.overlapMs ?? GOOGLE_HEALTH_DEFAULT_OVERLAP_MS;
  if (lastSyncedAt) return new Date(lastSyncedAt.getTime() - overlap);
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
}

/**
 * One mapped reading destined for a `Measurement` row, with the per-point anchor
 * already resolved into a full `externalId`. The per-resource syncs build these
 * from the client mappers (`<anchor>:<fieldTag>`).
 */
export interface GoogleHealthMeasurementUpsert {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  externalId: string;
  /**
   * Per-stage sleep rows carry the `SleepStage` axis so the (up to six) stage
   * rows for one night stay distinct under the dedup key; every other row omits
   * it (null). Sleep is the only producer.
   */
  sleepStage?: "IN_BED" | "AWAKE" | "ASLEEP" | "REM" | "CORE" | "DEEP" | null;
}

/** Chunk size for the batched `createMany` insert of fresh readings. */
const GOOGLE_HEALTH_CREATE_CHUNK = 500;

/** One just-fetched sleep session's window + the ids that must survive it. */
export interface GoogleHealthSleepReplaceWindow {
  /** Earliest segment start (UTC). Null → nothing to clean for this session. */
  windowStart: Date | null;
  /** Latest segment end (UTC). */
  windowEnd: Date | null;
  /** The fresh externalIds for THIS session — never soft-deleted. */
  keepIds: string[];
}

/**
 * Replace-by-window cleanup for re-scored Google sleep sessions.
 *
 * Google re-scores a night after the fact. Before the stable-anchor fix a
 * re-fetch minted fresh externalIds and left the prior night's rows LIVE, so the
 * night-total silently double-counted (a 7h35 night read as 10h+). For each
 * just-fetched session this soft-deletes any LIVE `GOOGLE_HEALTH`
 * `SLEEP_DURATION` row whose `measuredAt` falls inside the session's
 * `[windowStart, windowEnd]` but was NOT re-produced by this fetch (`keepIds`
 * are this session's fresh externalIds). Sleep sessions do not overlap in time,
 * so a scan bounded to one session's window only ever touches that session's own
 * rows — a fresh row is protected by `keepIds`, and any leftover (old volatile
 * key, or a segment Google dropped) is cleared. Rows OUTSIDE every returned
 * window are never touched, so a night Google did not re-report this tick stays
 * intact — no data loss, only stale duplicates and re-score orphans go. This is
 * also the repair path: a full backfill re-fetches history and cleans each night
 * as it goes. Best-effort — a cleanup failure never fails the user's sync.
 */
export async function replaceStaleGoogleHealthSleep(
  userId: string,
  sessions: GoogleHealthSleepReplaceWindow[],
): Promise<number> {
  let removed = 0;
  for (const s of sessions) {
    if (!s.windowStart || !s.windowEnd || s.keepIds.length === 0) continue;
    try {
      const res = await prisma.measurement.updateMany({
        where: {
          userId,
          source: "GOOGLE_HEALTH",
          type: "SLEEP_DURATION",
          deletedAt: null,
          measuredAt: { gte: s.windowStart, lte: s.windowEnd },
          externalId: { notIn: s.keepIds },
        },
        data: { deletedAt: new Date() },
      });
      removed += res.count;
    } catch (err) {
      getEvent()?.addWarning(
        `google-health: sleep replace-by-window failed: ${err}`,
      );
    }
  }
  return removed;
}

/**
 * Write a batch of mapped Google Health readings for one user and (unless
 * deferred) fold the rollup tier + invalidate status-insight caches once at the
 * end (mirrors the WHOOP / Withings sync tail). Returns the count of rows
 * written plus the distinct `(type, day)` keys the write touched.
 *
 * TOMBSTONES RESURRECT: the measurements unique index on
 * `(userId, type, source, externalId)` is FULL — it covers soft-deleted rows
 * too, so exactly ONE row can ever exist per key, live or tombstoned. An
 * earlier revision assumed a partial (live-only) index and skipped tombstoned
 * rows in the probe, expecting a fresh insert; in reality `createMany` with
 * `skipDuplicates` then hit the tombstoned row's key and dropped the insert
 * SILENTLY — once a Google row was soft-deleted, that key could never import
 * again (live: a self-hoster's step days were stuck this way). The probe now
 * matches tombstoned rows as well and the update branch clears `deletedAt`:
 * Google remains the source of truth for its own rows, so a re-import
 * deliberately revives a deleted one. An operator who wants Google data gone
 * permanently disconnects the integration rather than deleting rows.
 *
 * OVERWRITE CONTRACT preserved: a re-fetched daily summary (`stats:`-keyed and
 * every other stable per-point anchor) maps to the SAME live `externalId`, so
 * the probe finds the existing row and takes the in-place update branch.
 *
 * BATCHING: the existence probe is a single `findMany` over the batch's
 * externalIds; fresh rows go through chunked `createMany`, and only the
 * already-existing rows take a per-row `update` for their differing values.
 *
 * Best-effort on the rollup fold + insight invalidate — a populator hiccup never
 * fails the user's sync.
 */
export async function upsertGoogleHealthMeasurements(
  userId: string,
  readings: GoogleHealthMeasurementUpsert[],
  opts: { deferRollup?: boolean } = {},
): Promise<{
  imported: number;
  touched: Array<{ type: MeasurementType; measuredAt: Date }>;
  inserted: Array<{
    id: string;
    type: MeasurementType;
    measuredAt: Date;
  }>;
}> {
  if (readings.length === 0) return { imported: 0, touched: [], inserted: [] };

  // Probe EVERY existing row (live AND tombstoned) for the batch's externalIds
  // in a single query. The full unique index guarantees at most one row per
  // `(type, externalId)` key, and a tombstoned match must take the UPDATE
  // branch (which clears `deletedAt`) — treating it as absent would plan an
  // insert that `skipDuplicates` silently drops against the tombstone's key,
  // permanently wedging the key (see TOMBSTONES RESURRECT above).
  const externalIds = readings.map((r) => r.externalId);
  interface ProbedRow {
    id: string;
    value: number;
    unit: string;
    measuredAt: Date;
    sleepStage: GoogleHealthMeasurementUpsert["sleepStage"];
    deletedAt: Date | null;
  }
  let rowByKey = new Map<string, ProbedRow>();
  try {
    const existing = await prisma.measurement.findMany({
      where: {
        userId,
        source: "GOOGLE_HEALTH",
        externalId: { in: externalIds },
      },
      // The payload fields ride along so the update branch can skip a no-op
      // overwrite: the 24 h overlap re-fetches every recent row hourly, and an
      // unconditional write would bump `syncVersion` (iOS delta churn) on rows
      // whose values did not change.
      select: {
        id: true,
        type: true,
        externalId: true,
        value: true,
        unit: true,
        measuredAt: true,
        sleepStage: true,
        deletedAt: true,
      },
    });
    rowByKey = new Map(
      existing
        .filter((e) => e.externalId !== null)
        .map((e) => [
          `${e.type} ${e.externalId}`,
          {
            id: e.id,
            value: e.value,
            unit: e.unit,
            measuredAt: e.measuredAt,
            sleepStage: e.sleepStage,
            deletedAt: e.deletedAt,
          },
        ]),
    );
  } catch (err) {
    // A probe failure must not strand the whole batch; fall back to treating
    // every row as fresh (`skipDuplicates` absorbs the collision on the full
    // unique index — those rows simply retry on the next sync tick).
    getEvent()?.addWarning(`google-health: row probe failed: ${err}`);
  }

  const toCreate: Array<{
    type: MeasurementType;
    value: number;
    unit: string;
    measuredAt: Date;
    externalId: string;
    sleepStage: GoogleHealthMeasurementUpsert["sleepStage"];
  }> = [];
  const toUpdate: Array<{
    id: string;
    r: GoogleHealthMeasurementUpsert;
    /** Set when a key-format migration re-keys the row in place (see below). */
    reKeyTo?: string;
  }> = [];
  const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];

  // A batch can carry the same (type, externalId) twice (an overlap re-fetch);
  // collapse to last-write-wins so we never emit two creates for one live key.
  const plannedCreateKeys = new Set<string>();
  for (const r of readings) {
    const type = r.type as MeasurementType;
    const key = `${type} ${r.externalId}`;
    const existingRow = rowByKey.get(key);
    if (existingRow) {
      // Skip the no-op overwrite: a LIVE row whose payload matches the
      // re-fetched reading exactly gains nothing from a write, and the
      // unconditional `syncVersion` bump churned the DB + every iOS delta pull
      // hourly for the whole 24 h overlap window. A TOMBSTONED row always
      // updates — the write is what resurrects it (`deletedAt: null`).
      const unchanged =
        existingRow.deletedAt === null &&
        existingRow.value === r.value &&
        existingRow.unit === r.unit &&
        existingRow.measuredAt.getTime() === r.measuredAt.getTime() &&
        (existingRow.sleepStage ?? null) === (r.sleepStage ?? null);
      if (!unchanged) toUpdate.push({ id: existingRow.id, r });
    } else if (!plannedCreateKeys.has(key)) {
      plannedCreateKeys.add(key);
      toCreate.push({
        type,
        value: r.value,
        unit: r.unit,
        measuredAt: r.measuredAt,
        externalId: r.externalId,
        sleepStage: r.sleepStage ?? null,
      });
    } else {
      // A duplicate fresh key inside the same batch — overwrite the planned
      // create's payload so last-write-wins, matching the prior upsert loop.
      const idx = toCreate.findIndex(
        (c) => `${c.type} ${c.externalId}` === key,
      );
      if (idx >= 0) {
        toCreate[idx] = {
          type,
          value: r.value,
          unit: r.unit,
          measuredAt: r.measuredAt,
          externalId: r.externalId,
          sleepStage: r.sleepStage ?? null,
        };
      }
    }
  }

  // ── KEY-FORMAT MIGRATION RESCUE ──────────────────────────────────────────
  // measurements carries a SECOND full unique index — the natural key
  // `(user_id, type, measured_at, source, sleep_stage)` NULLS NOT DISTINCT
  // (migration 0055) — and it covers tombstoned rows too. When an externalId
  // FORMAT changes (the v1.28.18 sleep-anchor fix re-keyed every segment), a
  // re-fetched night's fresh rows carry NEW externalIds but the SAME natural
  // key as the rows the replace-by-window sweep just tombstoned: the
  // externalId probe finds nothing, the insert collides with the tombstone on
  // the natural index, and `skipDuplicates` drops it SILENTLY — old row gone,
  // new row never written (live incident: a full-history re-sync erased a
  // user's sleep). So every planned CREATE gets a second probe by natural
  // key; a match — live or tombstoned — is UPDATED in place instead: fresh
  // value, the NEW externalId (the migration itself), `deletedAt: null`.
  if (toCreate.length > 0) {
    try {
      const rescued = new Set<number>();
      const naturalKeyOf = (
        type: string,
        measuredAt: Date,
        stage: GoogleHealthMeasurementUpsert["sleepStage"],
      ): string => `${type}|${measuredAt.getTime()}|${stage ?? ""}`;
      for (let i = 0; i < toCreate.length; i += GOOGLE_HEALTH_CREATE_CHUNK) {
        const chunk = toCreate.slice(i, i + GOOGLE_HEALTH_CREATE_CHUNK);
        const rows = await prisma.measurement.findMany({
          where: {
            userId,
            source: "GOOGLE_HEALTH",
            type: { in: [...new Set(chunk.map((c) => c.type))] },
            measuredAt: { in: chunk.map((c) => c.measuredAt) },
          },
          select: {
            id: true,
            type: true,
            measuredAt: true,
            sleepStage: true,
          },
        });
        const byNaturalKey = new Map(
          rows.map((row) => [
            naturalKeyOf(
              row.type,
              row.measuredAt,
              row.sleepStage as GoogleHealthMeasurementUpsert["sleepStage"],
            ),
            row.id,
          ]),
        );
        for (let j = 0; j < chunk.length; j++) {
          const c = chunk[j];
          const id = byNaturalKey.get(
            naturalKeyOf(c.type, c.measuredAt, c.sleepStage),
          );
          if (id) {
            rescued.add(i + j);
            toUpdate.push({
              id,
              r: {
                type: c.type,
                value: c.value,
                unit: c.unit,
                measuredAt: c.measuredAt,
                externalId: c.externalId,
                sleepStage: c.sleepStage,
              },
              reKeyTo: c.externalId,
            });
          }
        }
      }
      if (rescued.size > 0) {
        for (let i = toCreate.length - 1; i >= 0; i--) {
          if (rescued.has(i)) toCreate.splice(i, 1);
        }
      }
    } catch (err) {
      // Best-effort: an unresolved natural-key twin only means the insert is
      // dropped by `skipDuplicates` as before — hold the watermark so the
      // next tick retries the rescue rather than losing the rows for good.
      getEvent()?.addWarning(
        `google-health: natural-key rescue probe failed: ${err}`,
      );
      noteHardFailure("measurements:rescue");
    }
  }

  let imported = 0;
  const insertedRows: Array<{
    id: string;
    type: MeasurementType;
    measuredAt: Date;
  }> = [];

  // Fresh inserts: chunked `createMany` (server-owned rows, field-by-field).
  // `skipDuplicates` guards the partial-unique index in the rare race where a
  // concurrent run inserted the same live key between the probe and the write.
  for (let i = 0; i < toCreate.length; i += GOOGLE_HEALTH_CREATE_CHUNK) {
    const chunk = toCreate.slice(i, i + GOOGLE_HEALTH_CREATE_CHUNK);
    try {
      const inserted = await prisma.measurement.createManyAndReturn({
        data: chunk.map((c) => ({
          userId,
          type: c.type,
          source: "GOOGLE_HEALTH" as const,
          value: c.value,
          unit: c.unit,
          measuredAt: c.measuredAt,
          externalId: c.externalId,
          sleepStage: c.sleepStage,
        })),
        skipDuplicates: true,
        select: { id: true, type: true, measuredAt: true },
      });
      imported += inserted.length;
      insertedRows.push(...inserted);
      void emitInsertedMeasurementArrivals(
        userId,
        inserted,
        "google_health",
      ).catch(() => {});
      for (const c of chunk) {
        touched.push({ type: c.type, measuredAt: c.measuredAt });
      }
    } catch (err) {
      getEvent()?.addWarning(
        `google-health: failed to create measurements: ${err}`,
      );
      // Fetched-but-unwritten rows are lost for good once they age out of the
      // 24 h overlap — fail the cycle's verdict so the watermark holds and the
      // next tick re-fetches them. No rethrow: sibling chunks and resources
      // must keep writing.
      noteHardFailure("measurements:create");
    }
  }

  // Existing-row overwrites: per-row update (differing values) on the matched
  // id, so the re-fetched daily summary overwrites in place and bumps
  // `syncVersion`. `deletedAt: null` rides along unconditionally — a no-op on
  // a live row, a deliberate RESURRECTION on a tombstoned one (Google is the
  // source of truth for its own rows; see TOMBSTONES RESURRECT above).
  for (const { id, r, reKeyTo } of toUpdate) {
    try {
      await prisma.measurement.update({
        where: { id },
        data: {
          value: r.value,
          unit: r.unit,
          measuredAt: r.measuredAt,
          sleepStage: r.sleepStage ?? null,
          deletedAt: null,
          // Key-format migration: adopt the fresh externalId in place.
          ...(reKeyTo ? { externalId: reKeyTo } : {}),
          // Surface the server-side mutation to the iOS LWW reconciler.
          syncVersion: { increment: 1 },
        },
      });
      touched.push({
        type: r.type as MeasurementType,
        measuredAt: r.measuredAt,
      });
      imported++;
    } catch (err) {
      getEvent()?.addWarning(
        `google-health: failed to update measurement: ${err}`,
      );
      // Same rule as the create catch: hold the watermark so the overwrite is
      // retried next tick rather than silently dropped.
      noteHardFailure("measurements:update");
    }
  }

  // On a `fullSync` backfill the caller defers the rollup fold: it collapses
  // every resource's touched type-days into a SINGLE range-recompute at the end
  // of the cycle. The incremental path keeps the inline per-day hook here.
  if (opts.deferRollup) {
    const tracker = rollupDeferStorage.getStore();
    // Plain loop, never `push(...touched)`: `touched` carries ONE entry PER
    // READING, and a full-history batch on a sample-dense account (a
    // multi-year heart-rate series is six figures of rows) blows the call
    // stack when spread into a single call — the engine caps argument counts.
    // The RangeError aborted the whole metrics collection on exactly the
    // accounts with the most data.
    if (tracker) {
      for (const t of touched) tracker.keys.push(t);
    }
    return { imported, touched, inserted: insertedRows };
  }

  try {
    const keys = collapseToTypeDayKeys(touched);
    for (const k of keys) {
      await recomputeBucketsForMeasurement(userId, k.type, k.measuredAt);
    }
    invalidateStatusInsightsForTypes(
      userId,
      keys.map((k) => k.type),
    ).catch((err) => {
      getEvent()?.addWarning(
        `google-health: status-insight invalidate failed for ${userId}: ${err}`,
      );
    });
  } catch (err) {
    getEvent()?.addWarning(
      `google-health: rollup recompute failed for ${userId}: ${err}`,
    );
  }

  return { imported, touched, inserted: insertedRows };
}

/**
 * Stamp `lastSyncedAt = now`. Called ONCE per cycle by `syncUserGoogleHealth`
 * after a non-degenerate run — never per resource, so the watermark can't move
 * mid-cycle and shrink a later resource's fetch window.
 */
export async function markSynced(userId: string): Promise<void> {
  await prisma.googleHealthConnection.update({
    where: { userId },
    data: { lastSyncedAt: new Date() },
  });
}

/**
 * Map a Google Health response classification onto a `FailureKind` and record
 * it. Shared by the token-refresh path and every per-resource catch block.
 */
export async function recordGoogleHealthSyncFailure(
  userId: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await recordSyncFailure({
    userId,
    integration: GOOGLE_HEALTH_INTEGRATION_KEY,
    kind: classificationToFailureKind(classifyGoogleHealthError(err)),
    message,
    errorCode:
      err instanceof GoogleHealthApiError
        ? err.httpStatus?.toString()
        : undefined,
  });
}

export function classificationToFailureKind(
  classification: GoogleHealthClassification,
): FailureKind {
  switch (classification) {
    case "reauth_required":
      return "reauth_required";
    case "persistent":
      return "persistent";
    case "transient":
      return "transient";
    case "success":
      // A caller asking for the FailureKind of a success is a contract bug;
      // surface it as transient so the audit log still records the anomaly.
      return "transient";
  }
}
