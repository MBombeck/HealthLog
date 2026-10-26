/**
 * v1.17.0 — Oura Cloud v2 sync.
 *
 * Pulls daily readiness (→ RECOVERY_SCORE + BODY_TEMPERATURE_DEVIATION), sleep
 * (real per-segment hypnogram timeline when present, else per-stage totals;
 * efficiency, HRV, RHR, respiratory rate), daily activity (steps, active
 * energy), the daily Sleep Score (→ SLEEP_SCORE),
 * daily SpO2 (→ OXYGEN_SATURATION), the dedicated vO2_max collection (→
 * VO2_MAX), and the daily cardiovascular-age estimate (→ VASCULAR_AGE) for one
 * connected user, mapping each into `Measurement` rows tagged `source = OURA`.
 *
 * daily_stress → STRESS_SCORE is deferred: STRESS_SCORE already has an
 * HRV-derived COMPUTED producer that is not yet wired into the source-priority
 * ladder or the weekly graded-series collapse, so a second producer here would
 * double-count nondeterministically. Re-add once STRESS_SCORE is laddered.
 *
 * daily_resilience → RESILIENCE (v1.19.0): the daily resilience LEVEL (limited /
 * adequate / solid / strong / exceptional) is ordinal-encoded (limited=1 …
 * exceptional=5) into the numeric `value` — no new categorical column. An
 * unknown / missing level mints no row. See `RESILIENCE_LEVELS` in `./client`.
 *
 * Token model: Oura uses refresh tokens. The merged schema has no expiry
 * column, so the sync refreshes REACTIVELY — the first read refused for its
 * token triggers one refresh (persisting BOTH rotated tokens, serialised per
 * user) and a single retry. A 401 that names a missing scope is not a token
 * refusal and spends no refresh. A failed refresh (`invalid_grant`) records
 * `reauth_required` on the `oura` ledger.
 *
 * Idempotency: `externalId = <resource>:<day>:<fieldTag>` for the day-keyed
 * collections; sleep rows carry a record-scoped `sleep:<record-id>:<fieldTag>`
 * key (per-segment timeline + nightly scalars) so a nap and the main sleep on
 * one day stay distinct instead of overwriting each other (B2). The shared
 * reconciler protects both external and natural identity. Oura finalises a
 * day's scores after the night, so an exact re-post overwrites in place.
 *
 * The measurement-write tail mirrors the shared WHOOP / Nightscout sync tail.
 */
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { annotate, getEvent } from "@/lib/logging/context";
import {
  markSyncFailureRecorded,
  recordSyncFailure,
  recordSyncSuccess,
  toFailureKind,
  type FailureKind,
} from "@/lib/integrations/status";
import type { InsertedMeasurementArrivalRow } from "@/lib/arrivals/measurement-emit";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";
import { afterProviderWrite } from "@/lib/integrations/sync-kit/after-write";
import type { SyncWriteResult } from "@/lib/outcome/written-outcome";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";
import {
  sweepStaleSleepSegments,
  type SleepSegmentSweep,
} from "@/lib/sleep/sweep-stale-segments";
import {
  MeasurementReconciliationError,
  reconcileExternalMeasurement,
} from "@/lib/measurements/reconcile-external-measurement";
import {
  fetchCardiovascularAge,
  fetchDailyActivity,
  fetchDailySleep,
  fetchDailySpo2,
  fetchReadiness,
  fetchResilience,
  fetchSleep,
  fetchVo2Max,
  fetchWorkouts,
} from "./client";
import {
  isRetiredOuraSleepPeriod,
  mapCardiovascularAge,
  mapDailyActivity,
  mapDailySleep,
  mapDailySpo2,
  mapReadiness,
  mapResilience,
  mapSleep,
  mapVo2Max,
  type MappedMeasurement,
} from "./map";
import { getOuraConnection, syncOuraScopeDenied } from "./credentials";
import { refreshOuraAfterRefusal } from "./oauth-descriptor";
import { OuraApiError, classifyOuraError } from "./response-classifier";
import { syncUserOuraCyclePhases } from "./cycle-sync";
import {
  OURA_COLLECTIONS,
  isOuraScopeGatedCollection,
  type OuraCollectionName,
} from "./scope";
import { writeOuraWorkouts } from "./sync-workouts";
import {
  refoldOuraTouchedDays,
  resolveOuraHeartRateWindow,
  syncOuraHeartRateRange,
  TouchedDays,
} from "./sync-heart-rate";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { resolveUserTimezone } from "@/lib/tz/resolver";

/** Floor of the lookback window (days) for an incremental sync. Oura finalises
 * a night's scores hours after wake; 7 days re-fetches a handful of records
 * (the upserts are idempotent) and covers the re-score tail. */
export const OURA_SYNC_LOOKBACK_DAYS = 7;

/**
 * Ceiling of the lookback window (days). A catch-up tick may widen the window
 * up to this many days; beyond it the missing span is history, not an outage,
 * and belongs to a backfill rather than an hourly poll.
 *
 * 30 rather than the ~90 days Oura's own guidance would allow: the whole batch
 * still rides ONE `$transaction` with a 60 s timeout (see
 * `upsertOuraMeasurements` below), and a 30-day catch-up is roughly four times
 * the row count of a normal tick — comfortably inside what that transaction
 * handles. Raise it only after the batch write is chunked.
 */
export const OURA_SYNC_MAX_LOOKBACK_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve how far back this tick should reach, anchored on the newest Oura
 * measurement we actually hold.
 *
 * The fixed 7-day window lost days in two ways. A sync that failed for longer
 * than a week resumed with a window too narrow to reach the gap, so the missing
 * days stayed missing. And a ring left unsynced (Oura's cloud has nothing until
 * the app is opened) produced a run of EMPTY successes — every signal green —
 * after which the late-arriving days fell outside the window and were never
 * imported.
 *
 * Anchoring on the newest imported row covers both: rows stop arriving whether
 * the sync fails or succeeds empty, so the same watermark goes stale in either
 * case. It is derived, never stored, so it cannot drift out of step with the
 * data the way a persisted cursor can — the watermark IS the data.
 *
 * `deletedAt: null` matters: the sleep sweep soft-deletes rows a revised
 * hypnogram orphaned, and a tombstone must not hold the watermark artificially
 * fresh. The `+ 1` day is the overlap buffer over the last seen day. With data
 * flowing normally the watermark is under two days old and the clamp floors at
 * `OURA_SYNC_LOOKBACK_DAYS`, so the steady-state window and request count are
 * exactly what they were before. No watermark at all is a fresh connection:
 * take the full ceiling.
 */
export async function resolveOuraLookbackDays(userId: string): Promise<number> {
  const newest = await prisma.measurement.findFirst({
    where: { userId, source: "OURA", deletedAt: null },
    orderBy: { measuredAt: "desc" },
    select: { measuredAt: true },
  });
  if (!newest) return OURA_SYNC_MAX_LOOKBACK_DAYS;

  const daysSince = Math.floor(
    (Date.now() - newest.measuredAt.getTime()) / DAY_MS,
  );
  return Math.min(
    OURA_SYNC_MAX_LOOKBACK_DAYS,
    Math.max(OURA_SYNC_LOOKBACK_DAYS, daysSince + 1),
  );
}

export function classifyOuraFailure(err: unknown): FailureKind {
  return toFailureKind(classifyOuraError(err));
}

/**
 * Record a whole-connection Oura sync failure on the shared `oura` ledger with
 * the correct classification + HTTP code. Extracted so the poll-cohort boundary
 * can record a future escape with the SAME provider-owned classification the
 * inline catch already applies.
 */
export async function recordOuraSyncFailure(
  userId: string,
  err: unknown,
): Promise<void> {
  await recordSyncFailure({
    userId,
    integration: "oura",
    kind: classifyOuraFailure(err),
    message: err instanceof Error ? err.message : String(err),
    errorCode:
      err instanceof OuraApiError && err.httpStatus != null
        ? String(err.httpStatus)
        : undefined,
  });
}

function ymd(d: Date): string {
  // eslint-disable-next-line healthlog/no-utc-day-key -- baseline: request window edge for the provider API, not a displayed day; rows carry their own dates
  return d.toISOString().slice(0, 10);
}

export interface OuraMeasurementUpsert {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  externalId: string;
  sleepStage?: "CORE" | "DEEP" | "REM" | "AWAKE" | null;
}

function toUpsert(
  mapped: MappedMeasurement[],
  resourcePrefix: string,
  dateOnlyDay?: string,
): OuraMeasurementUpsert[] {
  return mapped.map((m) => ({
    type: m.type,
    value: m.value,
    unit: m.unit,
    measuredAt: m.measuredAt,
    // A mapper that needs a record-scoped key (sleep rows — per-segment timeline
    // + nightly scalars) carries its own externalId; everything else falls back
    // to the day-keyed `<resource>:<day>:<fieldTag>` shape. A record with no
    // instant of its own (`dateOnlyDay`) keys on its date: its row sits at
    // local noon in the user's zone, which east of UTC+12 is the previous UTC
    // date. A timed record keys on its instant's UTC date, as it always has.
    externalId:
      m.externalId ??
      `${resourcePrefix}:${dateOnlyDay ?? ymd(m.measuredAt)}:${m.fieldTag}`,
    sleepStage: m.sleepStage ?? null,
  }));
}

/** One Oura collection: its ledger name and a self-contained fetch+map closure
 * that resolves to the collection's mapped upserts. Each closure owns its own
 * client call and mapper so a throw is contained to this one collection. A
 * collection that writes rows of its own (workouts, the heart-rate stream)
 * writes inside the closure, counts on `OuraRunContext.sideImported`, and
 * resolves to no upserts. */
interface OuraCollectionSpec {
  name: OuraCollectionName;
  collect: (token: string) => Promise<OuraMeasurementUpsert[]>;
}

/** A single collection that failed to fetch/map, carried so the caller can
 * classify + record the failure without blanking the collections that did
 * succeed. */
export interface OuraCollectionFailure {
  name: string;
  err: unknown;
}

export interface OuraFetchResult {
  readings: OuraMeasurementUpsert[];
  failures: OuraCollectionFailure[];
  /**
   * One sweep entry per fetched sleep record (`sleep:<record-id>:` prefix +
   * that record's fresh SLEEP_DURATION externalIds). Drives the record-scoped
   * cleanup of rows a revised hypnogram orphaned — including every legacy
   * run-indexed `seg:<i>` row — before the fresh set upserts.
   */
  sleepSweeps: SleepSegmentSweep[];
  /**
   * The `sleep:<record-id>:` prefix of every fetched sleep period Oura marks as
   * rejected or deleted (`isRetiredOuraSleepPeriod`). Such a period maps to no
   * rows, and whatever an earlier sync imported for it is retired.
   */
  sleepRetirements: string[];
  /**
   * Collections the grant does not cover: refused with a 401 that names the
   * missing scope, or with a bare 401 while a sibling succeeded with the same
   * token. Not failures; the card asks for one reconnect instead. `null` when
   * the run never proved the token (no collection succeeded, none was refused
   * by name, or the refresh was abandoned): it learned nothing about the
   * grant, so the note from the last run that did stands.
   */
  scopeDenied: string[] | null;
}

/**
 * What one run reads: the day window of the day-keyed collections, the time
 * range of the heart-rate stream, the user's zone, and the sinks the sleep
 * collection and the self-writing collections fill as they go.
 */
export interface OuraRunContext {
  userId: string;
  tz: string;
  query: { startDate: string; endDate: string };
  heartRate: { start: Date; end: Date };
  /** False on a history backfill: old rows are not arrivals. */
  emitArrivals: boolean;
  sleepSweeps: SleepSegmentSweep[];
  sleepRetirements: string[];
  /** Rows written by the collections that write their own. */
  sideImported: number;
  /** Days the heart-rate stream touched; refolded once by the caller. */
  heartRateTouched: TouchedDays;
}

export function ouraRunContext(
  userId: string,
  tz: string,
  query: { startDate: string; endDate: string },
  heartRate: { start: Date; end: Date },
  emitArrivals = true,
): OuraRunContext {
  return {
    userId,
    tz,
    query,
    heartRate,
    emitArrivals,
    sleepSweeps: [],
    sleepRetirements: [],
    sideImported: 0,
    heartRateTouched: new TouchedDays(),
  };
}

/**
 * The fetch+map (or fetch+write) closure of one collection over the context's
 * window. The one place each collection's read is defined, for the hourly
 * sync and the history backfill alike.
 */
export function ouraCollectionReader(
  name: OuraCollectionName,
  ctx: OuraRunContext,
): (token: string) => Promise<OuraMeasurementUpsert[]> {
  const { tz, query } = ctx;
  switch (name) {
    case "readiness":
      return async (t) =>
        (await fetchReadiness(t, query)).flatMap((r) =>
          toUpsert(
            mapReadiness(r, tz),
            "readiness",
            r.timestamp ? undefined : r.day,
          ),
        );
    case "sleep":
      return async (t) => {
        const records = await fetchSleep(t, query);
        const ups: OuraMeasurementUpsert[] = [];
        for (const s of records) {
          if (isRetiredOuraSleepPeriod(s)) {
            if (s.id) ctx.sleepRetirements.push(`sleep:${s.id}:`);
            continue;
          }
          const rows = toUpsert(
            mapSleep(s, tz),
            "sleep",
            s.bedtime_end ? undefined : s.day,
          );
          ups.push(...rows);
          // Record-scoped sweep entry: every SLEEP_DURATION row of this
          // record keys under `sleep:<id>:` (hypnogram runs AND the
          // stage-total fallback), so the prefix bounds the cleanup to this
          // one record. Clears whatever a revised hypnogram orphaned —
          // shifted run boundaries, legacy run-indexed `seg:<i>` rows, and a
          // stale stage-total set once the hypnogram appears.
          ctx.sleepSweeps.push({
            prefix: `sleep:${s.id}:`,
            keepIds: rows
              .filter((r) => r.type === "SLEEP_DURATION")
              .map((r) => r.externalId),
          });
        }
        return ups;
      };
    case "activity":
      return async (t) =>
        (await fetchDailyActivity(t, query)).flatMap((a) =>
          toUpsert(
            mapDailyActivity(a, tz),
            "activity",
            a.timestamp ? undefined : a.day,
          ),
        );
    case "daily_sleep":
      return async (t) =>
        (await fetchDailySleep(t, query)).flatMap((d) =>
          toUpsert(
            mapDailySleep(d, tz),
            "daily_sleep",
            d.timestamp ? undefined : d.day,
          ),
        );
    case "spo2":
      return async (t) =>
        (await fetchDailySpo2(t, query)).flatMap((s) =>
          toUpsert(mapDailySpo2(s, tz), "spo2", s.day),
        );
    case "vo2max":
      return async (t) =>
        (await fetchVo2Max(t, query)).flatMap((v) =>
          toUpsert(mapVo2Max(v, tz), "vo2max", v.timestamp ? undefined : v.day),
        );
    case "cardio_age":
      return async (t) =>
        (await fetchCardiovascularAge(t, query)).flatMap((c) =>
          toUpsert(mapCardiovascularAge(c, tz), "cardio_age", c.day),
        );
    case "resilience":
      return async (t) =>
        (await fetchResilience(t, query)).flatMap((r) =>
          toUpsert(mapResilience(r, tz), "resilience", r.day),
        );
    case "workout":
      return async (t) => {
        const workouts = await fetchWorkouts(t, query);
        ctx.sideImported += await writeOuraWorkouts(ctx.userId, workouts, {
          emitArrivals: ctx.emitArrivals,
        });
        return [];
      };
    case "heartrate":
      return async (t) => {
        const { imported, truncated } = await syncOuraHeartRateRange(
          ctx.userId,
          t,
          ctx.heartRate,
          { emitArrivals: ctx.emitArrivals, touched: ctx.heartRateTouched },
        );
        ctx.sideImported += imported;
        if (truncated) {
          // A window Oura could not page to its end is not read: fail it so
          // the run is not reported clean over a gap.
          throw new Error("oura heart-rate walk stopped short of its window");
        }
        return [];
      };
  }
}

/**
 * A 401 whose body names the missing scope (see `./scope`): Oura checked the
 * token and found it valid, the grant just does not cover this collection. A
 * refresh cannot widen a grant, so none is spent on it.
 */
export function isNamedScopeRefusal(err: unknown): boolean {
  return (
    err instanceof OuraApiError &&
    err.httpStatus === 401 &&
    err.missingScope !== undefined
  );
}

/**
 * Any other 401: the token was refused, or an older authorization server sent
 * no body to tell. This is what the one refresh is for. A 403 is neither: Oura
 * answers it for a lapsed membership, which no refresh or reconnect fixes.
 */
export function isTokenRefusal(err: unknown): boolean {
  return (
    err instanceof OuraApiError &&
    err.httpStatus === 401 &&
    err.missingScope === undefined
  );
}

/**
 * A failure that is the grant's scope rather than the token. Only the
 * collections behind a scope beyond `daily` qualify: without `daily` nothing
 * syncs, and that is a reconnect, not a hint. On those, a 401 naming its scope
 * always qualifies; a bare 401 qualifies only once a sibling collection has
 * proven the token, the inference that predates Oura naming the scope.
 */
function isScopeRefusal(
  f: OuraCollectionFailure,
  tokenProven: boolean,
): boolean {
  if (!isOuraScopeGatedCollection(f.name)) return false;
  return isNamedScopeRefusal(f.err) || (tokenProven && isTokenRefusal(f.err));
}

/**
 * Split the scope refusals out of a run's failures. Oura's authorization
 * server enforces scopes per collection, so a grant issued without `spo2`,
 * `heart_health` or `stress` answers 401 on exactly the collections behind
 * them and 200 everywhere else. Counting those toward the reconnect ladder
 * painted a working connection as broken on every sync, and refreshing the
 * token over them changed nothing. Any other failure, a 401 on a core
 * collection included, stays a failure.
 *
 * A 401 that names its scope proves the token by itself: Oura validated it in
 * order to say which permission it lacks.
 */
function splitScopeDenied(
  failures: OuraCollectionFailure[],
  siblingSucceeded: boolean,
): { failures: OuraCollectionFailure[]; scopeDenied: string[] | null } {
  const tokenProven =
    siblingSucceeded || failures.some((f) => isNamedScopeRefusal(f.err));
  if (!tokenProven) return { failures, scopeDenied: null };
  return {
    failures: failures.filter((f) => !isScopeRefusal(f, true)),
    scopeDenied: failures
      .filter((f) => isScopeRefusal(f, true))
      .map((f) => f.name),
  };
}

/**
 * Fetch every Oura daily collection for a user with a single reactive
 * refresh-on-401 retry, ISOLATED per collection. Unlike a bare `Promise.all`,
 * one flaky endpoint or one throwing mapper no longer rejects the whole batch
 * (which used to blank readiness, sleep, activity, spo2 all at once). Each
 * collection is settled independently (`Promise.allSettled`); the ones that
 * succeed import, the ones that throw are returned as `failures` for the caller
 * to record — mirroring Google Health's / Fitbit's per-collection hard-fail
 * ledger.
 *
 * The reactive refresh is preserved: because every collection shares one access
 * token, an expired token 401s all of them together; a single refresh is done
 * once and ONLY the failed collections are retried with the rotated token. A
 * failed refresh (`invalid_grant`) still throws so the caller parks the whole
 * connection at `reauth_required`.
 */
async function fetchAll(
  ctx: OuraRunContext,
  accessToken: string,
  refreshTokenCiphertext: string,
  knownScopeDenied: readonly string[] = [],
): Promise<OuraFetchResult> {
  const userId = ctx.userId;
  const { sleepSweeps, sleepRetirements } = ctx;
  const collections: OuraCollectionSpec[] = OURA_COLLECTIONS.map((c) => ({
    name: c.name,
    collect: ouraCollectionReader(c.name, ctx),
  }));

  // Run a set of collections isolated from one another. A rejection is captured
  // per-collection, never propagated, so siblings still resolve.
  const attempt = async (
    token: string,
    specs: OuraCollectionSpec[],
  ): Promise<{
    readings: OuraMeasurementUpsert[];
    failures: OuraCollectionFailure[];
    succeeded: number;
  }> => {
    const settled = await Promise.allSettled(
      specs.map((spec) => spec.collect(token)),
    );
    const readings: OuraMeasurementUpsert[] = [];
    const failures: OuraCollectionFailure[] = [];
    let succeeded = 0;
    settled.forEach((res, i) => {
      const spec = specs[i]!;
      if (res.status === "fulfilled") {
        succeeded++;
        readings.push(...res.value);
      } else {
        failures.push({ name: spec.name, err: res.reason });
      }
    });
    return { readings, failures, succeeded };
  };

  const first = await attempt(accessToken, collections);
  // The refresh is for a refused token. A 401 that names its scope is not one,
  // and neither is a bare 401 on a collection already known to sit outside the
  // grant while a sibling succeeded with the same token: a refresh cannot
  // widen a grant, so none is spent on either.
  const knownDenied = new Set<string>(
    knownScopeDenied.filter((name) => isOuraScopeGatedCollection(name)),
  );
  const needsRefresh = first.failures.some(
    (f) =>
      isTokenRefusal(f.err) &&
      !(first.succeeded > 0 && knownDenied.has(f.name)),
  );
  if (!needsRefresh) {
    return {
      readings: first.readings,
      ...splitScopeDenied(first.failures, first.succeeded > 0),
      sleepSweeps,
      sleepRetirements,
    };
  }

  // Reactive refresh: the access token expired (a 401 on the shared token).
  // Refresh once, serialised per user so an overlapping sync never spends the
  // same one-time refresh token twice, and retry the collections that failed
  // for any reason but a named scope. A failed refresh throws so the caller
  // parks reauth_required.
  const usableToken = await refreshOuraAfterRefusal(
    userId,
    refreshTokenCiphertext,
  );
  if (!usableToken)
    return {
      readings: first.readings,
      // The refresh never happened, so no sibling's success can be trusted
      // over it; a refusal that names its scope still says what it says.
      ...splitScopeDenied(first.failures, false),
      sleepSweeps,
      sleepRetirements,
    };

  const settledByScope = first.failures.filter((f) =>
    isNamedScopeRefusal(f.err),
  );
  const retryNames = new Set(
    first.failures
      .filter((f) => !isNamedScopeRefusal(f.err))
      .map((f) => f.name),
  );
  const retry = await attempt(
    usableToken,
    collections.filter((c) => retryNames.has(c.name)),
  );
  return {
    readings: [...first.readings, ...retry.readings],
    // Proven by either pass: a collection that succeeded before the refresh
    // proves the grant as much as one that succeeded after it.
    ...splitScopeDenied(
      [...settledByScope, ...retry.failures],
      first.succeeded + retry.succeeded > 0,
    ),
    sleepSweeps,
    sleepRetirements,
  };
}

/**
 * Retire what earlier syncs imported for sleep periods Oura now reports as
 * rejected or deleted: every live OURA row keyed under the period's
 * `sleep:<record-id>:` prefix, whatever its type, because the period's stage
 * rows and its nightly scalars (lowest heart rate, HRV, breathing rate,
 * efficiency) all came from a period that was not sleep. Soft delete, then the
 * shared write tail refolds the touched days and re-warms the touched types.
 * Best-effort like the segment sweep: a failure never fails the sync, and the
 * record stays inside the lookback window, so the next run retries it.
 */
export async function retireOuraSleepRecords(
  userId: string,
  prefixes: readonly string[],
): Promise<number> {
  // A bare `sleep::` (no record id) would match nothing useful and must never
  // widen to the whole source.
  const bounded = prefixes.filter((p) => /^sleep:[^:]+:$/.test(p));
  if (bounded.length === 0) return 0;
  try {
    const rows = await prisma.measurement.findMany({
      where: {
        userId,
        source: "OURA",
        deletedAt: null,
        OR: bounded.map((prefix) => ({ externalId: { startsWith: prefix } })),
      },
      select: { id: true, type: true, measuredAt: true },
    });
    if (rows.length === 0) return 0;
    const res = await prisma.measurement.updateMany({
      where: { userId, id: { in: rows.map((r) => r.id) }, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await afterMeasurementMutation(userId, rows, {
      source: "sync",
      label: "oura",
    });
    invalidateUserMeasurements(userId);
    annotate({ meta: { oura_sleep_retired_rows: res.count } });
    return res.count;
  } catch (err) {
    getEvent()?.addWarning(
      `oura: retiring rejected sleep periods failed for ${userId}: ${err}`,
    );
    return 0;
  }
}

/**
 * Sync one user's Oura data.
 *
 * `imported` is the count of measurement rows written; `failed` is true when a
 * collection did not settle. The count used to be the whole return value,
 * which hid the partial: a run where every collection failed answered `0`, the
 * same as a run that found nothing new, and the settings card reported both as
 * a success. A user with no Oura connection is a clean no-op (nothing
 * imported, nothing failed, no status row touched).
 */
export async function syncUserOura(
  userId: string,
  opts: { lookbackDays?: number } = {},
): Promise<SyncWriteResult> {
  const conn = await getOuraConnection(userId);
  if (!conn) return { imported: 0, failed: false };

  // An explicit window from the caller wins; otherwise derive it from what we
  // already hold so a gap widens the window instead of being skipped over.
  const lookbackDays =
    opts.lookbackDays ?? (await resolveOuraLookbackDays(userId));

  // Oura keys its daily collections by the user's calendar date, so the
  // window is cut on the user's own days, and date-only records are anchored
  // at local noon of their date in this zone. Heart rate is read by instant
  // over a window of hours (`resolveOuraHeartRateWindow`).
  const tz = await resolveUserTimezone(userId);
  const today = userDayKey(new Date(), tz);
  const ctx = ouraRunContext(
    userId,
    tz,
    { startDate: shiftDateKey(today, -lookbackDays), endDate: today },
    await resolveOuraHeartRateWindow(userId),
  );

  let result: OuraFetchResult;
  try {
    result = await fetchAll(
      ctx,
      conn.accessToken,
      conn.refreshTokenCiphertext,
      conn.scopeDenied,
    );
  } catch (err) {
    // Only a whole-connection failure (a failed token refresh → reauth) reaches
    // here now; per-collection failures are captured on `result.failures`.
    // Recorded here, then marked so the poll-cohort boundary does not
    // double-record it when it surfaces there.
    await recordOuraSyncFailure(userId, err);
    throw markSyncFailureRecorded(err);
  }

  // Remember which collections the grant does not cover, so the settings card
  // can ask for one reconnect. Best-effort: the note is a convenience, the
  // sync outcome does not depend on it.
  // A run that never proved the token says nothing about the grant and leaves
  // the note as it was.
  const scopeDenied = result.scopeDenied;
  if (scopeDenied && scopeDenied.length > 0) {
    annotate({
      meta: { oura_scope_denied: scopeDenied },
    });
  }
  if (scopeDenied) {
    try {
      await syncOuraScopeDenied(userId, scopeDenied);
    } catch (err) {
      getEvent()?.addWarning(`oura: scope note write failed: ${err}`);
    }
  }

  // Clear whatever an earlier scoring left under the re-fetched sleep records
  // before the fresh set upserts (mirrors Google Health's replace-by-window
  // order). Best-effort inside the helper — a sweep failure never fails the
  // sync; the record stays inside the lookback window, so the next tick
  // retries it.
  await sweepStaleSleepSegments(userId, "OURA", result.sleepSweeps);
  await retireOuraSleepRecords(userId, result.sleepRetirements);

  // Import everything the healthy collections returned regardless of whether a
  // sibling collection failed — one bad collection must not blank the source.
  let insertedSleepMeasuredAts: Date[] = [];
  const imported =
    (await upsertOuraMeasurements(userId, result.readings, {
      onInserted: (rows) => {
        insertedSleepMeasuredAts = rows
          .filter((row) => row.type === "SLEEP_DURATION")
          .map((row) => row.measuredAt);
      },
    })) + ctx.sideImported;
  await refoldOuraTouchedDays(userId, ctx.heartRateTouched);

  // v1.29.x — best-effort Cycle Insights import. Fully isolated from the
  // measurement sync's status ledger on purpose: `daily_cycle_phases` sits
  // outside the scope most self-registered Oura apps are granted (see the
  // `OuraCyclePhase` docstring in `./client`), so a 403/404 here is the
  // COMMON case for a typical connection. Re-reads the connection so a
  // reactive refresh `fetchAll` just performed is picked up rather than the
  // (now possibly stale) token captured before it ran.
  try {
    const freshConn = await getOuraConnection(userId);
    if (freshConn) {
      await syncUserOuraCyclePhases(userId, freshConn.accessToken, ctx.query);
    }
  } catch (err) {
    getEvent()?.addWarning(
      `oura: cycle-phases import skipped for ${userId}: ${err}`,
    );
  }

  // Trigger the debounced morning refresh on a last-night segment landing
  // (mirrors the Withings / WHOOP / Apple seams). Fires whether or not a
  // sibling collection failed, since the sleep readings were still imported.
  void maybeEnqueueMorningRefresh(userId, insertedSleepMeasuredAts).catch(
    () => {},
  );

  // Background-sync posture: mark the analytics cells stale (never hard-evict
  // from a poll) so the imported rows reach the cached readers. Fires on a
  // partial failure too — rows that DID land must not stay invisible for the
  // rest of the TTL window.
  if (imported > 0) {
    invalidateUserMeasurements(userId);
  }

  if (result.failures.length > 0) {
    // Partial failure: keep the cycle honest. Record the failure and do NOT
    // stamp success, so the freshness surface reflects that some collections
    // are behind and the next tick refetches them, rather than showing green.
    const firstErr = result.failures[0]!.err;
    getEvent()?.addWarning(
      `oura: ${result.failures.length} collection(s) failed for ${userId}: ${result.failures
        .map((f) => f.name)
        .join(", ")}`,
    );
    await recordSyncFailure({
      userId,
      integration: "oura",
      kind: classifyOuraFailure(firstErr),
      message: `partial sync failure (${result.failures
        .map((f) => f.name)
        .join(", ")}): ${
        firstErr instanceof Error ? firstErr.message : String(firstErr)
      }`,
      errorCode:
        firstErr instanceof OuraApiError && firstErr.httpStatus != null
          ? String(firstErr.httpStatus)
          : undefined,
    });
    return { imported, failed: true };
  }

  await recordSyncSuccess(userId, "oura");
  return { imported, failed: false };
}

export async function upsertOuraMeasurements(
  userId: string,
  readings: OuraMeasurementUpsert[],
  opts: {
    onInserted?: (rows: InsertedMeasurementArrivalRow[]) => void;
    /** False on a history backfill: old rows are not arrivals. */
    emitArrivals?: boolean;
  } = {},
): Promise<number> {
  if (readings.length === 0) return 0;

  let imported = 0;
  const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];
  const insertedRows: Array<
    InsertedMeasurementArrivalRow & { externalId: string | null }
  > = [];

  const verdicts = await prisma.$transaction(
    async (tx) => {
      const outcomes = [];
      for (const r of readings) {
        const verdict = await reconcileExternalMeasurement(
          tx,
          {
            userId,
            type: r.type as MeasurementType,
            source: "OURA",
            value: r.value,
            unit: r.unit,
            measuredAt: r.measuredAt,
            externalId: r.externalId,
            sleepStage: r.sleepStage ?? null,
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
    { timeout: 60_000 },
  );

  for (let index = 0; index < readings.length; index++) {
    const reading = readings[index]!;
    const verdict = verdicts[index]!;
    // Refused by the plausibility gate: nothing was written and nothing was
    // touched, so the reading counts as neither imported nor a rollup dirt
    // mark. The drop is already on the wide event.
    if (verdict.status === "rejected_range") continue;
    for (const dirty of verdict.dirtyIdentities ?? []) {
      touched.push(dirty);
    }
    const type = reading.type as MeasurementType;
    imported++;
    touched.push({ type, measuredAt: reading.measuredAt });
    if (verdict.status === "inserted") {
      insertedRows.push(verdict.row);
    }
  }

  opts.onInserted?.(insertedRows);
  // The shared tail (a history backfill writes through here and has no other
  // invalidation); the caller may emit the arrivals itself.
  await afterProviderWrite({
    userId,
    provider: "oura",
    touched,
    ...(opts.emitArrivals !== false
      ? { arrivals: { rows: insertedRows, source: "oura" as const } }
      : {}),
  });

  return imported;
}
