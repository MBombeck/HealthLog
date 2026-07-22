/**
 * Shared Fitbit sync runtime used by the orchestrator and resource leaves.
 *
 * This module owns token resolution, collection-error tracking, range helpers,
 * and measurement persistence. It performs no I/O until an exported function
 * is called.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { MeasurementType } from "@/generated/prisma/client";
import { emitInsertedMeasurementArrivals } from "@/lib/arrivals/measurement-emit";
import { encrypt, decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/comprehensive-generate";
import { persistRotatedToken } from "@/lib/integrations/oauth-refresh";
import { recordSyncFailure } from "@/lib/integrations/status";
import type { FailureKind } from "@/lib/integrations/status";
import { getEvent } from "@/lib/logging/context";
import {
  collapseToTypeDayKeys,
  recomputeBucketsForMeasurement,
} from "@/lib/rollups/measurement-rollups";
import { refreshAccessToken } from "./client";
import { getUserFitbitCredentials } from "./credentials";
import { FitbitApiError, classifyFitbitError } from "./response-classifier";
import type { FitbitClassification } from "./response-classifier";

/** Refresh the access token this many ms before `tokenExpiresAt`. */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Delimiter joining `(type, externalId)` into a single dedup map key. A
 * control character keeps it unambiguous against any value a real type or
 * externalId could contain, while staying a normal printable-safe constant
 * (a literal NUL in the source made text tooling treat the file as binary).
 */
const DEDUP_KEY_DELIM = "\u0000";

/**
 * Overlap window for the incremental sync, in ms. Fitbit finalises daily
 * summaries after the fact (a daily SpO2 / HRV / RHR can settle hours after the
 * night), so the default overlap is a full 24 h to make sure the re-rolled row
 * is re-fetched on the next tick. Mirrors WHOOP's recovery/sleep overlap.
 */
export const FITBIT_DEFAULT_OVERLAP_MS = 24 * 60 * 60 * 1000;

/**
 * How far back a `fullSync` backfill walks. The classic Web API per-endpoint
 * range cap (30 days) means a deep backfill issues many requests against the
 * tight 150/h budget, so the backfill horizon is bounded to keep one user's
 * backfill inside a couple of hourly windows (~12 chunks/resource). One year of
 * daily summaries is the launch horizon.
 */
export const FITBIT_BACKFILL_DAYS = 365;

export interface FitbitTokenInfo {
  accessToken: string;
  connection: { id: string; fitbitUserId: string };
}

/**
 * Resolve a valid Fitbit access token for a user, refreshing if it is within
 * the 5-minute expiry buffer. Returns null when there is no connection, no
 * credentials, or the refresh fails (the failure is recorded so scheduled syncs
 * back off).
 *
 * Classic Fitbit ROTATES refresh tokens (one-time use): every refresh response
 * carries a fresh `refresh_token` that invalidates the old one. Persist the new
 * access token + expiry AND the new refresh token unconditionally. If a refresh
 * response ever omits the new refresh token (a malformed reply), keep the stored
 * one rather than wiping it — a blank refresh token would brick every future
 * refresh.
 */
export async function getValidToken(
  userId: string,
): Promise<FitbitTokenInfo | null> {
  const connection = await prisma.fitbitConnection.findUnique({
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
      const creds = await getUserFitbitCredentials(userId);
      if (!creds) {
        getEvent()?.addWarning(
          `No Fitbit credentials found for user ${userId} during token refresh`,
        );
        await recordSyncFailure({
          userId,
          integration: "fitbit",
          kind: "reauth_required",
          message: "Fitbit credentials missing — token refresh skipped",
          errorCode: "credentials_missing",
        });
        return null;
      }

      const newTokens = await refreshAccessToken(refreshToken, creds);
      const expiresAt = new Date(Date.now() + newTokens.expires_in * 1000);

      // Classic Fitbit ROTATES refresh tokens: the refresh response carries a
      // fresh `refresh_token` that replaces the (now-invalid) stored one. Persist
      // with a compare-and-swap on the stored ciphertext so a concurrent sync
      // that already rotated the token does not get its work clobbered — and so
      // THIS caller, if it lost the race, reuses the peer's rotated access token
      // instead of parking the connection at reauth. Guard the malformed-reply
      // case: if the response omits the new refresh token, keep the existing one
      // rather than writing a blank, which would brick every future refresh.
      const persistedAccessToken = await persistRotatedToken(
        newTokens.access_token,
        {
          conditionalUpdate: async () => {
            const { count } = await prisma.fitbitConnection.updateMany({
              // `connection.refreshToken` is the exact ciphertext we read +
              // spent; matching it is the CAS guard (a re-encrypt would differ).
              where: {
                id: connection.id,
                refreshToken: connection.refreshToken,
              },
              data: {
                accessToken: encrypt(newTokens.access_token),
                tokenExpiresAt: expiresAt,
                ...(newTokens.refresh_token
                  ? { refreshToken: encrypt(newTokens.refresh_token) }
                  : {}),
              },
            });
            return count;
          },
          readPeerAccessToken: async () => {
            const fresh = await prisma.fitbitConnection.findUnique({
              where: { id: connection.id },
              select: { accessToken: true },
            });
            return fresh ? decrypt(fresh.accessToken) : null;
          },
        },
      );

      if (!persistedAccessToken) return null;

      return {
        accessToken: persistedAccessToken,
        connection: {
          id: connection.id,
          fitbitUserId: connection.fitbitUserId,
        },
      };
    } catch (err) {
      getEvent()?.addWarning(
        `Fitbit token refresh failed for user ${userId}: ${err}`,
      );
      await recordFitbitSyncFailure(userId, err);
      return null;
    }
  }

  return {
    accessToken,
    connection: {
      id: connection.id,
      fitbitUserId: connection.fitbitUserId,
    },
  };
}

/**
 * True when a caught error is a per-endpoint 403 (forbidden). The classic Fitbit
 * scopes are granted independently in the consent flow (and intraday needs an
 * extra per-app grant), so a 403 on ONE endpoint is a scope gate on THAT metric
 * — soft-skip it and keep the connection connected rather than parking the whole
 * integration at `error_reauth`. Connection-wide reauth is reserved for a 401
 * (token rejected) and a 403 on the token-refresh / profile path (a genuine
 * grant revoke), which run outside the per-resource catch blocks. Matters here
 * because partial grants are likely across the independent scopes.
 */
export function isCollectionForbidden(err: unknown): boolean {
  return err instanceof FitbitApiError && err.httpStatus === 403;
}

/**
 * Per-`syncUserFitbit`-cycle counter for collection-403 soft-skips. Scoped by
 * AsyncLocalStorage so the count never bleeds across concurrent per-user
 * pg-boss jobs. Mirrors the WHOOP `softSkipStorage` tracker.
 */
export interface SoftSkipTracker {
  count: number;
}
export const softSkipStorage = new AsyncLocalStorage<SoftSkipTracker>();

/**
 * Per-`syncUserFitbit`-cycle accumulator of the `(type, day)` keys every
 * resource's writes touched. Only populated on a `fullSync` backfill (when the
 * inline per-day rollup hook is deferred); the orchestrator drains it into ONE
 * `recomputeUserRollups(from, to)` pass at the end of the cycle. Scoped by
 * AsyncLocalStorage so concurrent per-user jobs never cross-pollinate, mirroring
 * the soft-skip tracker.
 */
export interface RollupDeferTracker {
  keys: Array<{ type: MeasurementType; measuredAt: Date }>;
}
export const rollupDeferStorage = new AsyncLocalStorage<RollupDeferTracker>();

/**
 * Per-cycle ledger of collection fetches that HARD-failed (non-403). A hard
 * failure on one endpoint must not abort its siblings — weight 500ing must not
 * suppress body-fat / spo2 / hrv / rhr / respiratory in the same resource — so
 * `handleCollectionFetchError` records the failure here and RETURNS instead of
 * rethrowing (the old pattern that aborted every endpoint ordered after the bad
 * one and stalled the watermark). The orchestrator reads the ledger to keep the
 * cycle's verdict honest: any entry ⇒ the run counts as failed, so success is
 * NOT stamped and the next tick refetches the window. Ported from Google
 * Health's `hardFailStorage`.
 */
export interface HardFailTracker {
  failures: string[];
}
export const hardFailStorage = new AsyncLocalStorage<HardFailTracker>();

/**
 * Single-source the per-resource collection-fetch error handling. A 403 on one
 * data class soft-skips it (warn + return 0) so sibling resources still sync; a
 * soft-skip increments the ambient tracker so `syncUserFitbit` can refuse to
 * stamp success on an all-403 grant-revoke cycle that imported nothing.
 *
 * Anything else records a classified sync failure, notes the collection on the
 * ambient hard-fail ledger, and RETURNS 0 — it does NOT rethrow. Every call site
 * sits in a per-collection catch, so returning lets the sibling endpoints in the
 * same resource keep fetching (one 500 on weight must not kill body-fat / spo2 /
 * hrv / rhr / respiratory), while the ledger still fails the cycle so the
 * watermark is not stamped past the broken collection.
 */
export async function handleCollectionFetchError(
  resource: string,
  userId: string,
  err: unknown,
): Promise<number> {
  if (isCollectionForbidden(err)) {
    getEvent()?.addWarning(
      `fitbit ${resource} sync skipped for ${userId}: collection 403 (soft-skip)`,
    );
    const tracker = softSkipStorage.getStore();
    if (tracker) tracker.count += 1;
    return 0;
  }
  await recordFitbitSyncFailure(userId, err);
  getEvent()?.addWarning(`fitbit ${resource} failed for ${userId}: ${err}`);
  const hardTracker = hardFailStorage.getStore();
  if (hardTracker) hardTracker.failures.push(resource);
  return 0;
}

/**
 * Options threaded from `syncUserFitbit` to each per-resource sync. The `start`
 * + `end` window is snapshotted ONCE by the orchestrator (a single `lastSyncedAt`
 * read + a single `now`) so every resource fetches the same window; no resource
 * re-reads `lastSyncedAt` or stamps `markSynced` itself. The per-resource sync
 * chunks `[start, end]` into the per-endpoint date-range cap. The orchestrator
 * owns the single end-of-cycle `markSynced`.
 */
export interface FitbitResourceSyncOptions {
  fullSync?: boolean;
  /** The lower bound of the fetch window, snapshotted once by the orchestrator. */
  start?: Date;
  /** The upper bound of the fetch window (now), snapshotted once. */
  end?: Date;
  /**
   * When true, `upsertFitbitMeasurements` writes the rows but SKIPS the inline
   * per-(type,day) DAY-rollup recompute + status-insight invalidate, returning
   * the touched type-days to the caller instead. The orchestrator collapses
   * them into ONE `recomputeUserRollups(from, to)` pass at the end of a
   * `fullSync` cycle, so a multi-year backfill pays a single range-recompute
   * rather than thousands of per-day round-trips. The incremental path leaves
   * this unset and keeps the inline per-day hook (small touched set, warm read
   * on the next tick).
   */
  deferRollup?: boolean;
}

/**
 * Compute the incremental `start` for a resource sync. `fullSync` walks back the
 * bounded backfill horizon (the classic Web API caps each call's date range, so
 * an unbounded backfill would blow the 150/h budget). Otherwise start from
 * `lastSyncedAt - overlap`, or 30 days back on the very first incremental tick.
 */
export function incrementalStart(
  lastSyncedAt: Date | null,
  opts: { fullSync?: boolean; overlapMs?: number; now?: Date } = {},
): Date {
  const now = opts.now ?? new Date();
  if (opts.fullSync) {
    return new Date(now.getTime() - FITBIT_BACKFILL_DAYS * 24 * 60 * 60 * 1000);
  }
  const overlap = opts.overlapMs ?? FITBIT_DEFAULT_OVERLAP_MS;
  if (lastSyncedAt) return new Date(lastSyncedAt.getTime() - overlap);
  return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
}

/**
 * Slice `[start, end]` into consecutive inclusive windows no wider than
 * `maxDays` calendar days, the per-endpoint range cap the classic Web API
 * enforces. Each window is `{ start, end }` with `end` no later than the overall
 * `end`; the per-resource syncs issue one request per window. Returns a single
 * window when the span already fits.
 */
export function chunkDateRanges(
  start: Date,
  end: Date,
  maxDays: number,
): Array<{ start: Date; end: Date }> {
  const windows: Array<{ start: Date; end: Date }> = [];
  if (end.getTime() < start.getTime()) return windows;
  const stepMs = maxDays * 24 * 60 * 60 * 1000;
  let cursor = start.getTime();
  const endMs = end.getTime();
  // Guard against a pathological span minting an unbounded loop.
  let guard = 0;
  const MAX_WINDOWS = 1000;
  while (cursor <= endMs && guard < MAX_WINDOWS) {
    // Each window spans up to `maxDays` days inclusive, so subtract one day from
    // the step to keep the inclusive end inside the cap.
    const windowEnd = Math.min(cursor + stepMs - 24 * 60 * 60 * 1000, endMs);
    windows.push({ start: new Date(cursor), end: new Date(windowEnd) });
    cursor = windowEnd + 24 * 60 * 60 * 1000;
    guard += 1;
  }
  return windows;
}

/**
 * One mapped reading destined for a `Measurement` row, with the per-point anchor
 * already resolved into a full `externalId`. The per-resource syncs build these
 * from the client mappers (`<anchor>:<fieldTag>`). Mirrors WHOOP's
 * `WhoopMeasurementUpsert` (no `sleepStage` — sleep lands in W5).
 */
export interface FitbitMeasurementUpsert {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  externalId: string;
  /**
   * Per-stage sleep rows carry the `SleepStage` axis so the (up to six) stage
   * rows for one night stay distinct under the dedup key; every other row omits
   * it (null). W5 (sleep) is the only producer.
   */
  sleepStage?: "IN_BED" | "AWAKE" | "ASLEEP" | "REM" | "CORE" | "DEEP" | null;
}

/** Chunk size for the batched `createMany` insert of fresh readings. */
const FITBIT_CREATE_CHUNK = 500;

/**
 * Write a batch of mapped Fitbit readings for one user and (unless deferred)
 * fold the rollup tier + invalidate status-insight caches once at the end
 * (mirrors the WHOOP / Withings sync tail). Returns the count of rows written
 * plus the distinct `(type, day)` keys the write touched.
 *
 * TOMBSTONES RESURRECT: the measurements unique index on
 * `(userId, type, source, externalId)` is FULL — it covers soft-deleted rows
 * too, so exactly ONE row can ever exist per key, live or tombstoned. An
 * earlier revision assumed a partial (live-only) index and skipped tombstoned
 * rows in the probe, expecting a fresh insert; in reality `createMany` with
 * `skipDuplicates` then hit the tombstoned row's key and dropped the insert
 * SILENTLY — once a Fitbit row was soft-deleted, that key could never import
 * again (the same wedge shipped live on the Google transport). The probe now
 * matches tombstoned rows as well and the update branch clears `deletedAt`:
 * Fitbit remains the source of truth for its own rows, so a re-import
 * deliberately revives a deleted one. An operator who wants Fitbit data gone
 * permanently disconnects the integration rather than deleting rows.
 *
 * OVERWRITE CONTRACT preserved: a re-fetched daily summary (`stats:`-keyed and
 * every other stable per-point anchor) maps to the SAME `externalId`, so the
 * probe finds the existing row and takes the in-place update branch (bumping
 * `syncVersion` for the iOS LWW reconciler) — never a duplicate.
 *
 * BATCHING: the existence probe is a single `findMany` over the batch's
 * externalIds; fresh rows go through chunked `createMany` (collapsing the N+1
 * insert round-trips a deep backfill used to pay), and only the (bounded)
 * already-live rows take a per-row `update` for their differing values.
 *
 * Best-effort on the rollup fold + insight invalidate — a populator hiccup never
 * fails the user's sync.
 */
export async function upsertFitbitMeasurements(
  userId: string,
  readings: FitbitMeasurementUpsert[],
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
  let rowByKey = new Map<string, { id: string }>();
  try {
    const existing = await prisma.measurement.findMany({
      where: {
        userId,
        source: "FITBIT",
        externalId: { in: externalIds },
      },
      select: { id: true, type: true, externalId: true },
    });
    rowByKey = new Map(
      existing
        .filter((e) => e.externalId !== null)
        .map((e) => [
          `${e.type}${DEDUP_KEY_DELIM}${e.externalId}`,
          { id: e.id },
        ]),
    );
  } catch (err) {
    // A probe failure must not strand the whole batch; fall back to treating
    // every row as fresh (`skipDuplicates` absorbs the collision on the full
    // unique index — those rows simply retry on the next sync tick).
    getEvent()?.addWarning(`Fitbit: row probe failed: ${err}`);
  }

  const toCreate: Array<{
    type: MeasurementType;
    value: number;
    unit: string;
    measuredAt: Date;
    externalId: string;
    sleepStage: FitbitMeasurementUpsert["sleepStage"];
  }> = [];
  const toUpdate: Array<{
    id: string;
    r: FitbitMeasurementUpsert;
    /** Set when a key-format migration re-keys the row in place (see below). */
    reKeyTo?: string;
  }> = [];
  const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];

  // A batch can carry the same (type, externalId) twice (an overlap re-fetch);
  // collapse to last-write-wins so we never emit two creates for one live key.
  const plannedCreateKeys = new Set<string>();
  for (const r of readings) {
    const type = r.type as MeasurementType;
    const key = `${type}${DEDUP_KEY_DELIM}${r.externalId}`;
    const live = rowByKey.get(key);
    if (live) {
      toUpdate.push({ id: live.id, r });
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
        (c) => `${c.type}${DEDUP_KEY_DELIM}${c.externalId}` === key,
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
  // FORMAT changes (a re-keyed re-import after an anchor-scheme fix), a
  // re-fetched night's fresh rows carry NEW externalIds but the SAME natural
  // key as the rows a replace-by-window sweep just tombstoned: the externalId
  // probe finds nothing, the insert collides with the tombstone on the natural
  // index, and `skipDuplicates` drops it SILENTLY — old row gone, new row
  // never written (live incident on the Google transport: a full-history
  // re-sync erased a user's sleep). So every planned CREATE gets a second
  // probe by natural key; a match — live or tombstoned — is UPDATED in place
  // instead: fresh value, the NEW externalId (the migration itself),
  // `deletedAt: null`.
  if (toCreate.length > 0) {
    try {
      const rescued = new Set<number>();
      const naturalKeyOf = (
        type: string,
        measuredAt: Date,
        stage: FitbitMeasurementUpsert["sleepStage"],
      ): string => `${type}|${measuredAt.getTime()}|${stage ?? ""}`;
      for (let i = 0; i < toCreate.length; i += FITBIT_CREATE_CHUNK) {
        const chunk = toCreate.slice(i, i + FITBIT_CREATE_CHUNK);
        const rows = await prisma.measurement.findMany({
          where: {
            userId,
            source: "FITBIT",
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
              row.sleepStage as FitbitMeasurementUpsert["sleepStage"],
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
      // dropped by `skipDuplicates` as before — note the failure on the
      // ambient ledger so the watermark holds and the next tick retries the
      // rescue rather than losing the rows for good.
      getEvent()?.addWarning(`Fitbit: natural-key rescue probe failed: ${err}`);
      const hardTracker = hardFailStorage.getStore();
      if (hardTracker) hardTracker.failures.push("measurements:rescue");
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
  for (let i = 0; i < toCreate.length; i += FITBIT_CREATE_CHUNK) {
    const chunk = toCreate.slice(i, i + FITBIT_CREATE_CHUNK);
    try {
      const inserted = await prisma.measurement.createManyAndReturn({
        data: chunk.map((c) => ({
          userId,
          type: c.type,
          source: "FITBIT" as const,
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
      void emitInsertedMeasurementArrivals(userId, inserted, "fitbit").catch(
        () => {},
      );
      for (const c of chunk) {
        touched.push({ type: c.type, measuredAt: c.measuredAt });
      }
    } catch (err) {
      getEvent()?.addWarning(`Fitbit: failed to create measurements: ${err}`);
    }
  }

  // Existing-row overwrites: per-row update (differing values) on the matched
  // id, so the re-fetched daily summary overwrites in place and bumps
  // `syncVersion`. `deletedAt: null` rides along unconditionally — a no-op on
  // a live row, a deliberate RESURRECTION on a tombstoned one (Fitbit is the
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
      getEvent()?.addWarning(`Fitbit: failed to update measurement: ${err}`);
    }
  }

  // On a `fullSync` backfill the caller defers the rollup fold: it collapses
  // every resource's touched type-days into a SINGLE range-recompute at the end
  // of the cycle (thousands of per-day round-trips → one pass). The incremental
  // path keeps the inline per-day hook here (small touched set, warm next read).
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
        `fitbit: status-insight invalidate failed for ${userId}: ${err}`,
      );
    });
  } catch (err) {
    getEvent()?.addWarning(
      `fitbit: rollup recompute failed for ${userId}: ${err}`,
    );
  }

  return { imported, touched, inserted: insertedRows };
}

/**
 * Stamp `lastSyncedAt = now`. Called ONCE per cycle by `syncUserFitbit` after a
 * non-degenerate run — never per resource, so the watermark can't move mid-cycle
 * and shrink a later resource's fetch window.
 */
export async function markSynced(userId: string): Promise<void> {
  await prisma.fitbitConnection.update({
    where: { userId },
    data: { lastSyncedAt: new Date() },
  });
}

/**
 * Map a Fitbit response classification onto a `FailureKind` and record it.
 * Shared by the token-refresh path and every per-resource catch block.
 */
export async function recordFitbitSyncFailure(
  userId: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await recordSyncFailure({
    userId,
    integration: "fitbit",
    kind: classificationToFailureKind(classifyFitbitError(err)),
    message,
    errorCode:
      err instanceof FitbitApiError ? err.httpStatus?.toString() : undefined,
  });
}

export function classificationToFailureKind(
  classification: FitbitClassification,
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
