/**
 * WHOOP sync core — token refresh (rotating refresh token), shared
 * Measurement upsert/rollup-fold helpers, cursors, and sync status handling.
 *
 * Mirrors `src/lib/withings/sync.ts`:
 *   - `getValidToken` resolves the token through the shared OAuth token
 *     lifecycle (`src/lib/integrations/oauth-kit/token.ts`, descriptor in
 *     `./oauth-descriptor`): refreshed at `tokenExpiresAt - 5 min` under the
 *     provider/user advisory lock, BOTH rotated tokens persisted (WHOOP
 *     invalidates the prior access AND refresh token on every refresh).
 *   - Each per-resource sync (`sync-recovery` / `sync-sleep` / `sync-cycle` /
 *     `sync-workout`) upserts into `Measurement` / `Workout` keyed on
 *     `(userId, type, source = WHOOP, externalId)` so a re-post (WHOOP
 *     re-scores recovery/sleep after the fact) overwrites in place rather than
 *     minting a duplicate. After the upserts the rollup tier is re-folded
 *     (`recomputeBucketsForKeys`) and the status-insight caches are
 *     invalidated, identical to the Withings tail.
 *
 * The incremental window starts from `lastSyncedAt - overlap`. WHOOP re-scores
 * recovery/sleep hours after the night, so the overlap must comfortably cover
 * the re-score lag — `WHOOP_RECOVERY_SLEEP_OVERLAP_MS` is 7 days, now shared by
 * workout ingest too (a phone that syncs to the WHOOP cloud well after a
 * workout would otherwise fall outside a narrow window and never land);
 * `WHOOP_DEFAULT_OVERLAP_MS` stays the narrow fallback for other resources.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { getEvent } from "@/lib/logging/context";
import {
  markSyncFailureRecorded,
  recordSyncFailure,
  recordSyncSuccess,
  type FailureKind,
} from "@/lib/integrations/status";
import {
  afterProviderWrite,
  invalidateProviderStatus,
} from "@/lib/integrations/sync-kit/after-write";
import type { InsertedMeasurementArrivalRow } from "@/lib/arrivals/measurement-emit";
import { obtainAccessToken } from "@/lib/integrations/oauth-kit/token";
import {
  MeasurementReconciliationError,
  reconcileExternalMeasurement,
} from "@/lib/measurements/reconcile-external-measurement";
import { whoopTokenDescriptor } from "./oauth-descriptor";
import {
  WhoopApiError,
  classifyWhoopError,
  type WhoopClassification,
} from "./response-classifier";

/**
 * True when a caught error is a per-resource collection 403 (forbidden). A 403
 * on a single data class is a tier/scope gate on THAT class — the right
 * response is to soft-skip the class and keep the connection connected, NOT to
 * park the whole integration at `error_reauth`. Reserve connection-wide reauth
 * for a 401 (token rejected) and for a 403 on the token-refresh / profile path
 * (a genuine grant revoke), which run outside the per-resource catch blocks.
 */
export function isCollectionForbidden(err: unknown): boolean {
  return err instanceof WhoopApiError && err.httpStatus === 403;
}

/**
 * Per-`syncUserWhoop`-cycle counter for collection-403 soft-skips. Set up by
 * `syncUserWhoop` around the resource loop so the per-resource catch blocks —
 * which return a bare 0 on a soft-skip, indistinguishable from a genuine
 * "no new records" — can be told apart from the orchestrator. AsyncLocalStorage
 * keeps the count scoped to one user's sync, never bleeding across concurrent
 * per-user pg-boss jobs.
 */
interface SoftSkipTracker {
  count: number;
}
const softSkipStorage = new AsyncLocalStorage<SoftSkipTracker>();

/**
 * Run work inside a request-local collection soft-skip tracker. Both the
 * full orchestrator and single-resource jobs use this boundary so a 403 in
 * one user's sync cannot affect another concurrent sync.
 */
export async function runWithWhoopSoftSkipTracking<T>(
  run: () => Promise<T>,
): Promise<{ result: T; softSkipCount: number }> {
  const tracker: SoftSkipTracker = { count: 0 };
  const result = await softSkipStorage.run(tracker, run);
  return { result, softSkipCount: tracker.count };
}

/**
 * Per-cycle ledger of HARD failures that must fail the cycle's verdict WITHOUT
 * aborting sibling resources — a dead token (`getValidToken` returning null on
 * a missing-credentials, failed-refresh, or in-lock vanished-connection path).
 * Every resource leaf short-circuits `if (!tokenInfo) return 0` on a null
 * token, so without this ledger a dead-token cycle reads as CLEAN: every
 * resource "succeeds" with 0 rows, no failure is recorded, and
 * `recordSyncSuccess` un-parks `error_reauth`, resets the failure buckets +
 * `alertedAt`, and the hourly cohort hammers the dead refresh token forever.
 * The orchestrator + the per-resource driver read this ledger to refuse the
 * success stamp. Ported from Fitbit R2 / Google Health's `hardFailStorage`.
 * Scoped by AsyncLocalStorage so concurrent per-user jobs never cross-pollinate.
 */
export interface HardFailTracker {
  failures: string[];
}
export const hardFailStorage = new AsyncLocalStorage<HardFailTracker>();

/**
 * Ledger label for a dead-token failure (`getValidToken` returning null on a
 * missing-credentials, failed-refresh, or in-lock vanished-connection path).
 * Ported from Fitbit's `FITBIT_TOKEN_HARD_FAIL`.
 */
export const WHOOP_TOKEN_HARD_FAIL = "token";

/**
 * Record a hard failure on the ambient per-cycle ledger, if one is in scope.
 * No-op outside a ledger scope (e.g. a direct REPL call). Used by
 * `getValidToken`'s dead-token paths — anything that must fail the cycle's
 * verdict without aborting sibling work. Ported from Fitbit's `noteHardFailure`.
 */
export function noteHardFailure(label: string): void {
  const tracker = hardFailStorage.getStore();
  if (tracker) tracker.failures.push(label);
}

/**
 * Single-source the per-resource collection-fetch error handling. A 403 on one
 * data class soft-skips it (warn + return 0) so sibling resources still sync;
 * anything else records a classified sync failure and rethrows. Call as
 * `return handleCollectionFetchError("recovery", userId, err)` from a resource
 * sync's catch block.
 *
 * A soft-skip increments the ambient `softSkipStorage` tracker (when present)
 * so `syncUserWhoop` can refuse to stamp success on an all-403 grant-revoke
 * cycle that imported nothing.
 */
export async function handleCollectionFetchError(
  resource: string,
  userId: string,
  err: unknown,
): Promise<number> {
  if (isCollectionForbidden(err)) {
    getEvent()?.addWarning(
      `whoop ${resource} sync skipped for ${userId}: collection 403 (soft-skip)`,
    );
    const tracker = softSkipStorage.getStore();
    if (tracker) tracker.count += 1;
    return 0;
  }
  await recordWhoopSyncFailure(userId, err);
  // Marked so the orchestrator / cron catch (which records unmarked write-path
  // throws for WH-4) does not record this fetch failure a SECOND time.
  throw markSyncFailureRecorded(err);
}

/**
 * Overlap window for the incremental sync, in ms. WHOOP re-scores recovery
 * and sleep after the fact, and a night can reach the WHOOP cloud DAYS late
 * (phone offline, app unopened, score pending). The collection endpoints
 * filter on the record's own time range — not on when it arrived — so any
 * record surfacing after the cursor moved past it is missed FOREVER by a
 * narrow overlap; the night's per-stage rows then never reach the DB and
 * every sleep surface keeps showing the parallel coarse source for that
 * night. Seven days re-fetches a handful of records per tick (the upserts
 * are idempotent) and closes the gap for every realistic lag. Workout AND
 * cycle now ride the same 7-day overlap: a workout can reach the WHOOP cloud
 * days after a late phone sync, and a cycle is re-scored through the day —
 * both collections filter on the record's own time range, so a narrow overlap
 * steps the cursor past a still-settling record and misses it. One record per
 * day keeps the re-fetch to a single page. `WHOOP_DEFAULT_OVERLAP_MS` stays
 * the narrow fallback `incrementalStart` uses when no resource passes an
 * explicit overlap.
 */
export const WHOOP_RECOVERY_SLEEP_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;
export const WHOOP_DEFAULT_OVERLAP_MS = 60 * 60 * 1000; // 1 h

/**
 * The far-past anchor a `fullSync` walks from. Incremental ticks start at
 * `cursor − overlap` (days at most); a fullSync deliberately ignores the
 * cursor and re-walks the deep history WHOOP retains (multi-year), which an
 * incremental run would never reach. WHOOP's first public data predates this,
 * so a fixed anchor covers every realistic account; the client's `next_token`
 * pagination + the idempotent upsert keep the re-walk bounded and safe.
 */
export const WHOOP_FULL_SYNC_ANCHOR = new Date("2020-01-01T00:00:00.000Z");

/**
 * The four pollable WHOOP collections that carry an independent sync cursor.
 * Body-measurement is a single profile object (no time-range cursor) and is
 * excluded. Each resource advances ONLY its own cursor key so a slow/failing
 * collection never drags the incremental window forward for its siblings.
 */
export type WhoopResource = "recovery" | "sleep" | "workout" | "cycle";

/**
 * Shape of the `WhoopConnection.resourceCursors` JSON map: a partial
 * `resource → ISO-8601 last-synced instant`. A missing key (or a legacy null
 * column) means the resource has no per-resource cursor yet and falls back to
 * the shared `lastSyncedAt`.
 */
type ResourceCursorMap = Partial<Record<WhoopResource, string>>;

function parseResourceCursors(raw: unknown): ResourceCursorMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as ResourceCursorMap;
}

/**
 * Resolve the incremental cursor for one resource. Prefers the per-resource
 * cursor; falls back to the connection's shared `lastSyncedAt` for a legacy
 * connection (or a resource that has never synced under the new column) so no
 * historical state is lost on the first tick after the migration. Returns null
 * when neither exists (the very first sync — `incrementalStart` then anchors 30
 * days back).
 */
export function resolveResourceCursor(
  connection: {
    resourceCursors?: unknown;
    lastSyncedAt?: Date | null;
  },
  resource: WhoopResource,
): Date | null {
  const map = parseResourceCursors(connection.resourceCursors);
  const iso = map[resource];
  if (iso) {
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return connection.lastSyncedAt ?? null;
}

export interface WhoopTokenInfo {
  accessToken: string;
  connection: { id: string; whoopUserId: string };
}

/**
 * Resolve a valid WHOOP access token for a user, refreshing if it is within
 * the 5-minute expiry buffer. On refresh, persists BOTH rotated tokens.
 * Returns null when there is no connection, no credentials, or the refresh
 * fails (the failure is recorded so scheduled syncs back off).
 */
export async function getValidToken(
  userId: string,
): Promise<WhoopTokenInfo | null> {
  const connection = await prisma.whoopConnection.findUnique({
    where: { userId },
    select: { id: true, whoopUserId: true },
  });
  if (!connection?.whoopUserId) return null;
  const meta = { id: connection.id, whoopUserId: connection.whoopUserId };

  try {
    const result = await obtainAccessToken(whoopTokenDescriptor, userId);
    if (result.kind === "token") {
      return { accessToken: result.accessToken, connection: meta };
    }
    if (result.kind === "no_credentials") {
      getEvent()?.addWarning(
        `No WHOOP credentials found for user ${userId} during token refresh`,
      );
      await recordSyncFailure({
        userId,
        integration: "whoop",
        kind: "reauth_required",
        message: "WHOOP credentials missing — token refresh skipped",
        errorCode: "credentials_missing",
      });
    }
    // No credentials, or the connection vanished between the read above and
    // the token read (disconnect/webhook race). A dead token means every
    // resource "succeeds" with 0 rows — without a ledger entry the cycle reads
    // as clean and `recordSyncSuccess` un-parks `error_reauth` while the hourly
    // cohort hammers the dead refresh token. Fail the cycle's verdict so the
    // park holds.
    noteHardFailure(WHOOP_TOKEN_HARD_FAIL);
    return null;
  } catch (err) {
    getEvent()?.addWarning(
      `WHOOP token refresh failed for user ${userId}: ${err}`,
    );
    await recordWhoopSyncFailure(userId, err);
    // The WH-1 kill shot: an all-zeros refresh-failure run must not stamp
    // success, un-park `error_reauth`, and re-arm the alert. Fail the verdict.
    noteHardFailure(WHOOP_TOKEN_HARD_FAIL);
    return null;
  }
}

/**
 * Compute the `start` bound for a resource fetch.
 *
 * A `fullSync` deliberately ignores the cursor and anchors at
 * `WHOOP_FULL_SYNC_ANCHOR` — the deep historical backfill an incremental run
 * would never reach. (It previously returned `undefined`; an explicit anchor
 * pins the lower bound so the walk is reproducible and the cursor a stalled
 * incremental left behind cannot silently narrow a backfill.)
 *
 * Otherwise it is an incremental tick: start from `cursor − overlap`, or 30
 * days back on the very first sync (no cursor yet).
 */
export function incrementalStart(
  cursor: Date | null,
  opts: { fullSync?: boolean; overlapMs?: number } = {},
): Date | undefined {
  if (opts.fullSync) return WHOOP_FULL_SYNC_ANCHOR;
  const overlap = opts.overlapMs ?? WHOOP_DEFAULT_OVERLAP_MS;
  if (cursor) return new Date(cursor.getTime() - overlap);
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
}

/**
 * One mapped reading destined for a `Measurement` row, with the resource uuid
 * already resolved into a full `externalId`. The per-resource syncs build these
 * from the client mappers (`<resource-uuid>:<fieldTag>`).
 */
export interface WhoopMeasurementUpsert {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  externalId: string;
  sleepStage?: "CORE" | "DEEP" | "REM" | "AWAKE" | "IN_BED" | null;
}

const WHOOP_MEASUREMENT_TRANSACTION_CHUNK_SIZE = 100;

/**
 * Upsert mapped WHOOP readings for one user in bounded transactions, then fold
 * the rollup tier + invalidate status-insight caches once at the end (mirrors
 * the Withings sync tail). The shared reconciler protects both external and
 * natural identity; an exact WHOOP re-score overwrites in place. Returns the
 * count of rows written.
 *
 * Best-effort on the rollup fold + insight invalidate — a populator hiccup
 * never fails the user's sync.
 */
export async function upsertWhoopMeasurements(
  userId: string,
  readings: WhoopMeasurementUpsert[],
  opts: {
    onInserted?: (rows: InsertedMeasurementArrivalRow[]) => void;
  } = {},
): Promise<number> {
  if (readings.length === 0) return 0;

  let imported = 0;
  const touchedTypes = new Set<MeasurementType>();
  const invalidateTouchedTypes = (): void =>
    invalidateProviderStatus(userId, "whoop", touchedTypes);

  for (
    let chunkStart = 0;
    chunkStart < readings.length;
    chunkStart += WHOOP_MEASUREMENT_TRANSACTION_CHUNK_SIZE
  ) {
    const chunkEnd = Math.min(
      chunkStart + WHOOP_MEASUREMENT_TRANSACTION_CHUNK_SIZE,
      readings.length,
    );
    const verdicts = await prisma
      .$transaction(
        async (tx) => {
          const outcomes = [];
          for (let index = chunkStart; index < chunkEnd; index++) {
            const reading = readings[index]!;
            const verdict = await reconcileExternalMeasurement(
              tx,
              {
                userId,
                type: reading.type as MeasurementType,
                source: "WHOOP",
                value: reading.value,
                unit: reading.unit,
                measuredAt: reading.measuredAt,
                externalId: reading.externalId,
                sleepStage: reading.sleepStage ?? null,
              },
              { exactExternalMatch: "update" },
            );
            if (verdict.status === "failed") {
              throw new MeasurementReconciliationError(verdict);
            }
            outcomes.push(verdict);
          }
          return outcomes;
        },
        { maxWait: 10_000, timeout: 60_000 },
      )
      .catch((err) => {
        invalidateTouchedTypes();
        throw err;
      });

    const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];
    const insertedRows: Array<
      InsertedMeasurementArrivalRow & { externalId: string | null }
    > = [];
    for (let index = chunkStart; index < chunkEnd; index++) {
      const reading = readings[index]!;
      const verdict = verdicts[index - chunkStart]!;
      // Refused by the plausibility gate: nothing was written and nothing was
      // touched, so the reading counts as neither imported nor a rollup dirt
      // mark. The drop is already on the wide event.
      if (verdict.status === "rejected_range") continue;
      for (const dirty of verdict.dirtyIdentities ?? []) {
        touched.push(dirty);
        touchedTypes.add(dirty.type);
      }
      const type = reading.type as MeasurementType;
      touchedTypes.add(type);
      imported++;
      touched.push({ type, measuredAt: reading.measuredAt });
      if (verdict.status === "inserted") {
        insertedRows.push(verdict.row);
      }
    }

    opts.onInserted?.(insertedRows);
    // Each chunk folds its own days; the status cards are re-warmed once,
    // after the last chunk (or the one that failed).
    await afterProviderWrite({
      userId,
      provider: "whoop",
      touched,
      arrivals: { rows: insertedRows, source: "whoop" },
      invalidateStatus: false,
    });
  }

  invalidateTouchedTypes();

  return imported;
}

/** Stamp `lastSyncedAt = now` after a successful resource sync. */
export async function markSynced(userId: string): Promise<void> {
  await prisma.whoopConnection.update({
    where: { userId },
    data: { lastSyncedAt: new Date() },
  });
}

/**
 * The closed set of resources allowed in the `resourceCursors` JSON path. The
 * key is passed to `jsonb_set` below — assert it against this whitelist so a
 * caller can never splice an arbitrary path, even though `resource` is already
 * the typed `WhoopResource` union.
 */
const WHOOP_CURSOR_RESOURCES: ReadonlySet<WhoopResource> = new Set([
  "recovery",
  "sleep",
  "workout",
  "cycle",
]);

/**
 * Advance ONE resource's cursor after its successful fetch+upsert. Sibling
 * cursors are preserved untouched, so a resource that errored or soft-skipped
 * this tick keeps its own (older) cursor and re-fetches from there next time.
 * Also keeps the shared `lastSyncedAt` moving (monotonically) for any legacy
 * reader still on it.
 *
 * The merge is a SINGLE atomic `jsonb_set` upsert, not a read-modify-write. The
 * four WHOOP resources are independent pg-boss queues that run concurrently for
 * the same user (a cron tick fans out all four at once), so a read-then-write
 * would let two resources read the same map and the second write clobber the
 * first's cursor. `jsonb_set` merges in-place under the row lock, and
 * `GREATEST` keeps `last_synced_at` from being dragged backward by a slower
 * sibling finishing with an older `at`.
 */
export async function markResourceSynced(
  userId: string,
  resource: WhoopResource,
  at: Date = new Date(),
): Promise<void> {
  // Defence-in-depth: the typed union already bounds `resource`, but the value
  // reaches a JSON path, so refuse anything outside the closed whitelist.
  if (!WHOOP_CURSOR_RESOURCES.has(resource)) return;

  const iso = at.toISOString();
  // `resource` is parameter-bound ($2), never string-spliced. `jsonb_set`
  // builds the path array from it; `coalesce` seeds an empty object for a
  // legacy null column; `GREATEST` advances `last_synced_at` only forward.
  await prisma.$executeRaw`
    UPDATE "whoop_connections"
    SET "resource_cursors" = jsonb_set(
          coalesce("resource_cursors", '{}'::jsonb),
          ARRAY[${resource}],
          to_jsonb(${iso}::text),
          true
        ),
        "last_synced_at" = GREATEST("last_synced_at", ${at})
    WHERE "user_id" = ${userId}
  `;
}

/**
 * Run a SINGLE WHOOP resource sync (webhook-driven refresh or the per-resource
 * cron walk) under the soft-skip tracker and stamp `recordSyncSuccess` iff the
 * resource actually reached WHOOP — it did not throw and was not a pure
 * soft-skip (an all-403 grant-revoke that imported nothing).
 *
 * The per-resource path (`runWhoopResourceSync`) advances the resource cursor
 * via `markResourceSynced` but historically never touched `IntegrationStatus`,
 * so `lastSuccessAt` stayed frozen at the last full `syncUserWhoop` run — the
 * Settings "last synced" pill and the MCP `get_integration_status` read lied
 * for up to an hour after a webhook already landed last night's data. Stamp it
 * here, reusing `syncUserWhoop`'s exact success guard scoped to one resource:
 * a genuine import clears the error state; a 403 soft-skip leaves the
 * "looks-healthy" window closed.
 */
export type WhoopSyncLeg = "recovery" | "sleep" | "workout" | "cycle";

export async function syncWhoopResourceWithStatus(
  userId: string,
  leg: WhoopSyncLeg,
  run: () => Promise<number>,
): Promise<number> {
  // Run under BOTH trackers: soft-skip (a 403 scope gate) and hard-fail (a dead
  // token noted by `getValidToken`). This is the dominant path — the four
  // hourly crons walk every connection through here — so without the hard-fail
  // gate a dead-token tick would stamp success, un-park `error_reauth`, and the
  // whole release would be inert on the path that runs most often.
  const hardFailTracker: HardFailTracker = { failures: [] };
  const { result: imported, softSkipCount } =
    await runWithWhoopSoftSkipTracking(() =>
      hardFailStorage.run(hardFailTracker, run),
    );
  const softSkippedOnly = softSkipCount > 0 && imported === 0;
  if (!softSkippedOnly && hardFailTracker.failures.length === 0) {
    // Leg-scoped: WHOOP runs four resource crons against one ledger row, so a
    // healthy recovery tick at :05 must not clear the error the workout tick
    // recorded at :35 the hour before.
    await recordSyncSuccess(userId, "whoop", { leg });
  }
  return imported;
}

/**
 * Map a WHOOP response classification onto a `FailureKind` and record it.
 * Shared by every per-resource catch-block and the token-refresh path.
 */
export async function recordWhoopSyncFailure(
  userId: string,
  err: unknown,
  leg?: WhoopSyncLeg,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await recordSyncFailure({
    userId,
    integration: "whoop",
    kind: classificationToFailureKind(classifyWhoopError(err)),
    message,
    leg,
    errorCode:
      err instanceof WhoopApiError ? err.httpStatus?.toString() : undefined,
  });
}

export function classificationToFailureKind(
  classification: WhoopClassification,
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
