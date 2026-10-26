/**
 * v1.4.25 — Withings Sleep v2 sync.
 *
 * Pulls per-stage sleep segments from `POST /v2/sleep?action=get` and
 * writes one Measurement row per segment, tagged with the appropriate
 * `SleepStage` enum. The webhook trigger (appli=44) drives most calls
 * in production; the hourly pg-boss cron (`withings-sleep-sync`) is
 * the safety net for the 1 % of webhook deliveries Withings drops.
 *
 * State mapping (research §2 + withings-go reference):
 *
 *   - state 0 (awake)       → AWAKE
 *   - state 1 (light sleep) → CORE
 *   - state 2 (deep sleep)  → DEEP
 *   - state 3 (REM)         → REM
 *   - state 4 (manual)      → ignored (rare; Withings synthetic marker)
 *
 * The legacy `ASLEEP` and `IN_BED` slots in the HealthLog enum are
 * reserved for HealthKit ingest (pre-iOS-16 `asleepUnspecified` and
 * iOS-16+ `inBed` respectively) and are NOT emitted from this path.
 *
 * Idempotency: every segment keys on the stable externalId
 * `withings:sleep:<user>:<sessionId>:<segment-start-unix>` — the session id
 * plus the segment's own start instant, both stable across re-syncs of an
 * unchanged night. When Withings re-aggregates a night with adjusted
 * boundaries, the shifted segments mint new ids and the session-scoped sweep
 * (`sweepStaleSleepSegments`) tombstones whatever the re-aggregation
 * orphaned — including every legacy row from the retired running-index
 * format, so that fix self-heals without a migration.
 *
 * Date semantics: each segment's `measuredAt` is the segment's
 * `enddate` (unix seconds → `Date`). Every reader treats `measuredAt`
 * as the segment END and resolves the span as `start = end − duration`
 * (`sleep-night.ts` `segmentOf`); stamping the START shifted the whole
 * night one segment-length earlier. The duration in minutes lands in
 * `value`. The HealthLog analytics aggregator groups stage rows under
 * their parent night via the per-night `dayKey` helper, so the
 * segment-level END timestamp is the canonical sort key.
 */
import type { MeasurementType, SleepStage } from "@/generated/prisma/client";

import { prisma } from "@/lib/db";
import { annotate, getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";
import { getUnitForType } from "@/lib/validations/measurement";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";

import {
  sweepStaleSleepSegments,
  type SleepSegmentSweep,
} from "@/lib/sleep/sweep-stale-segments";
import {
  MeasurementReconciliationError,
  reconcileExternalMeasurement,
} from "@/lib/measurements/reconcile-external-measurement";

import { hasActivityScope } from "./oauth";
import {
  nextSleepStageReads,
  parseSleepStageReads,
  serialiseSleepStageReads,
  isSleepNightGivenUp,
  sleepNightKey,
  type SleepStageReadOutcome,
  type SleepStageReads,
} from "./sleep-stage-reads";
import {
  isPlanGatedError,
  isPlanReprobeDue,
  parseWithingsApiPlanState,
  persistWithingsPlanLeg,
  planCheckedAtFor,
  planSkipFor,
  requestWithinPlan,
  shouldPersistPlanLeg,
  WITHINGS_ADVANCED_SLEEP_FIELDS,
} from "./api-plan";
import {
  WithingsApiError,
  classifyWithingsResponse,
} from "./response-classifier";
import {
  WITHINGS_LEG_SLEEP,
  getValidToken,
  recordWithingsSyncFailure,
} from "./sync";
import {
  isReauthRequired,
  parkIntegrationAtReauth,
  recordSyncFailure,
  recordSyncSuccess,
} from "@/lib/integrations/status";

const WITHINGS_SLEEP_URL = "https://wbsapi.withings.net/v2/sleep";

/**
 * v1.18.10 — nightly sleep vitals from `action=getsummary`.
 *
 * The per-segment `action=get` series carries only the stage timeline; the
 * per-night summary carries the physiological vitals (average HR, respiratory
 * rate, SDNN-based HRV, average SpO2, the Withings sleep score). These were
 * previously dropped at the fetch even though the canonical enums exist. Each
 * vital maps to an EXISTING `MeasurementType` so there is no migration and no
 * iOS-contract change — the rows simply flow to `/api/sync/changes` under the
 * `WITHINGS` source like every other server-side fetch.
 *
 * Field set requested via `data_fields`. Withings nests the requested fields
 * under each night's `data` object. Only the fields with a canonical enum are
 * requested; snoring / breathing-disturbance intensity have no enum and are
 * deliberately left out (no home to store them).
 */
export const SLEEP_SUMMARY_DATA_FIELDS: readonly string[] = [
  "hr_average",
  "rr_average",
  "sdnn_1",
  "spo2_average",
  "sleep_score",
];

/**
 * One nightly summary row from `POST /v2/sleep?action=getsummary`. The vitals
 * live under `data`; `id` is the per-night session id (stable across re-syncs,
 * the same id the segment series carries) so the externalId reconciles.
 */
export interface WithingsSleepSummary {
  id?: number;
  startdate: number;
  enddate: number;
  /** When Withings last changed the night (unix seconds), e.g. a re-score. */
  modified?: number;
  data?: {
    hr_average?: number | null;
    rr_average?: number | null;
    sdnn_1?: number | null;
    spo2_average?: number | null;
    sleep_score?: number | null;
  };
}

/**
 * One nightly vital extracted from a summary, ready to upsert. The
 * `measuredAt` is the night's END (`enddate`) so the vital sorts under the
 * same night as the END-stamped stage segments.
 */
interface SleepVitalRow {
  type: MeasurementType;
  value: number;
  /** Stable per-vital externalId suffix; combined with the session id. */
  fieldTag: string;
}

/**
 * Map a nightly summary's `data` block to the canonical vital rows. Skips any
 * field Withings omitted or returned as a non-finite value. `spo2_average`
 * arrives as a fraction (0..1) on some firmware and a percent (0..100) on
 * others — normalise the fraction form to percent so it shares the
 * `OXYGEN_SATURATION` bucket with the meastype-54 spot reading.
 */
export function mapWithingsSleepSummary(
  data: WithingsSleepSummary["data"] | undefined,
): SleepVitalRow[] {
  if (!data) return [];
  const rows: SleepVitalRow[] = [];
  const push = (type: MeasurementType, value: unknown, fieldTag: string) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    rows.push({ type, value, fieldTag });
  };
  // Average HR over the sleep window → RESTING_HEART_RATE (one nightly sample,
  // distinct from spot PULSE — same convention the HealthKit nightly RHR uses).
  push("RESTING_HEART_RATE", data.hr_average, "hr");
  push("RESPIRATORY_RATE", data.rr_average, "rr");
  // sdnn_1 is the SDNN-based HRV estimator — the same estimator the
  // HEART_RATE_VARIABILITY enum documents (kept distinct from WHOOP's RMSSD).
  push("HEART_RATE_VARIABILITY", data.sdnn_1, "hrv");
  let spo2 = data.spo2_average;
  if (typeof spo2 === "number" && Number.isFinite(spo2) && spo2 <= 1) {
    spo2 = spo2 * 100;
  }
  push("OXYGEN_SATURATION", spo2, "spo2");
  push("SLEEP_SCORE", data.sleep_score, "score");
  return rows;
}

/**
 * Default backfill window for the first sleep sync of a connection.
 * Matches every other Withings ingest path so a reconnect lights up
 * 30 days of stage data.
 */
// Exported so the sleep-timeline backfill can bound its DELETE to exactly
// the window this sync will re-import — deleting beyond it is raw data loss
// the re-sync can never restore.
export const SLEEP_BACKFILL_DAYS = 30;

/**
 * One stage segment from the `action=get` series. Withings emits
 * `state` as an integer enum; `startdate` and `enddate` are unix
 * seconds (NOT YYYY-MM-DD like the activity response).
 */
export interface WithingsSleepSegment {
  startdate: number;
  enddate: number;
  state: number;
  // The session id is unique per night; HealthLog uses it as part of
  // the externalId so a future re-sync can reconcile against the
  // original write.
  id?: number;
}

/**
 * Format a Date as `YYYY-MM-DD` in UTC for the summary endpoint's
 * `startdateymd` / `enddateymd` params. The summary window is day-grained;
 * UTC keeps it deterministic and matches the unix-second window the segment
 * fetch derives from the same `start` / `now` Dates.
 */
function ymdUtc(d: Date): string {
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: day-grained summary window matching the unix-second segment window (see the doc comment)
  return d.toISOString().slice(0, 10);
}

/**
 * Map Withings `state` to the HealthLog `SleepStage` enum. Returns
 * `null` for states we deliberately ignore (state 4 = synthetic
 * marker) so the caller can skip the segment without an error.
 */
export function mapWithingsSleepState(state: number): SleepStage | null {
  switch (state) {
    case 0:
      return "AWAKE";
    case 1:
      return "CORE";
    case 2:
      return "DEEP";
    case 3:
      return "REM";
    default:
      return null;
  }
}

const SLEEP_TYPE: MeasurementType = "SLEEP_DURATION";

/**
 * Fetch the per-segment sleep series for the given user. Returns the
 * raw segments (no DB write) so callers compose the write step.
 */
export async function fetchWithingsSleep(
  accessToken: string,
  startdate: number,
  enddate: number,
): Promise<WithingsSleepSegment[]> {
  const params = new URLSearchParams({
    action: "get",
    startdate: String(startdate),
    enddate: String(enddate),
    // hr / rr / snoring are noisy intraday streams; HealthLog only
    // ingests stage-level data today, so request the minimum set.
  });

  const pageStart = performance.now();
  const res = await safeFetch(WITHINGS_SLEEP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${accessToken}`,
    },
    body: params.toString(),
  });
  const json = await res.json();
  const verdict = classifyWithingsResponse(res.status, json);
  getEvent()?.addExternalCall({
    service: "withings",
    method: "fetchWithingsSleep",
    duration_ms: Math.round(performance.now() - pageStart),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new WithingsApiError({
      verb: "sleep",
      classification: verdict.classification,
      withingsStatus: verdict.withingsStatus,
      reason: verdict.reason,
      upstreamError: typeof json?.error === "string" ? json.error : undefined,
    });
  }
  const series: WithingsSleepSegment[] = json.body?.series ?? [];
  return series;
}

/**
 * v1.18.10 — fetch the per-night sleep summaries (with vitals) for the
 * given window. `action=getsummary` keys by `lastupdate`/`startdateymd`; we
 * use the same unix-second window the segment fetch uses, expressed as the
 * `YYYY-MM-DD` form the summary endpoint expects. Returns the raw summaries
 * (no DB write) so the caller composes the upsert step.
 */
export async function fetchWithingsSleepSummary(
  accessToken: string,
  startymd: string,
  endymd: string,
  dataFields: readonly string[] = SLEEP_SUMMARY_DATA_FIELDS,
): Promise<WithingsSleepSummary[]> {
  const params = new URLSearchParams({
    action: "getsummary",
    startdateymd: startymd,
    enddateymd: endymd,
    data_fields: dataFields.join(","),
  });

  const pageStart = performance.now();
  const res = await safeFetch(WITHINGS_SLEEP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${accessToken}`,
    },
    body: params.toString(),
  });
  const json = await res.json();
  const verdict = classifyWithingsResponse(res.status, json);
  getEvent()?.addExternalCall({
    service: "withings",
    method: "fetchWithingsSleepSummary",
    duration_ms: Math.round(performance.now() - pageStart),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new WithingsApiError({
      verb: "sleep",
      classification: verdict.classification,
      withingsStatus: verdict.withingsStatus,
      reason: verdict.reason,
      upstreamError: typeof json?.error === "string" ? json.error : undefined,
    });
  }
  const series: WithingsSleepSummary[] = json.body?.series ?? [];
  return series;
}

/**
 * Sync sleep data for a single user. Walks the trailing 30-day window
 * (or whatever `SLEEP_BACKFILL_DAYS` is set to), writing one
 * Measurement row per stage segment. Returns the number of upserted
 * rows.
 *
 * Park behaviour mirrors `syncUserMeasurements` — a connection at
 * `error_reauth` short-circuits before the upstream call.
 */
export async function syncUserSleep(
  userId: string,
  opts: { fullSync?: boolean } = {},
): Promise<number> {
  if (await isReauthRequired(userId, "withings")) {
    getEvent()?.addWarning(
      `withings sleep sync skipped for ${userId}: parked at error_reauth`,
    );
    return 0;
  }

  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  // v1.4.26 — scope-skip guard. Sleep v2 shares the `user.activity`
  // scope gate with the activity endpoints; legacy v1.4.24- connections
  // 403 on every call. Park at `error_reauth` rather than retrying so
  // pg-boss stops queuing and the 3-strike alert doesn't fire for users
  // who haven't reconnected since W5d. See `sync-activity.ts` for the
  // full rationale.
  const connection = await prisma.withingsConnection.findUnique({
    where: { userId },
    select: { scope: true },
  });
  if (!hasActivityScope(connection?.scope ?? null)) {
    getEvent()?.addWarning(
      `withings sleep sync skipped for ${userId}: missing user.activity scope (legacy connection — reconnect required)`,
    );
    // v1.4.27 — silent park (BL-P3-2 parity with activity sync). The
    // scope-skip is a deliberate no-op; the 3-strike admin alert must
    // NOT fire from this branch. The defence-in-depth 403 catch-block
    // below stays on `recordSyncFailure` so a genuinely unexpected 403
    // after the scope-skip lands still pages admins.
    await parkIntegrationAtReauth({
      userId,
      integration: "withings",
      message:
        "Withings connection is missing the user.activity scope. Reconnect Withings in Settings to enable sleep sync.",
      errorCode: "scope_missing",
      leg: WITHINGS_LEG_SLEEP,
    });
    return 0;
  }

  const now = new Date();
  const start = new Date(
    now.getTime() - SLEEP_BACKFILL_DAYS * 24 * 60 * 60 * 1000,
  );
  const endUnix = Math.floor(now.getTime() / 1000);

  // The nights come first: `action=getsummary` lists every night of the
  // window (and carries its vitals), and the stage timeline is then read per
  // night. `action=get` answers only the first 24 hours after its
  // `startdate` ("If your input startdate and enddate are separated by more
  // than 24h, only the first 24h after startdate will be returned", Sleep v2
  // Get); asked for the whole window it returned the night a month back and
  // nothing since, so every night's stages arrived when the sliding window
  // reached it, weeks late.
  //
  // Withings API plans (2026-10-12): the sleep score, the overnight HRV and
  // the respiration rate are Advanced Biomarkers, and one of them in
  // `data_fields` has the whole summary refused with 277. Ask only for what
  // the plan allows, remember what it refused, and re-probe weekly.
  let summaries: WithingsSleepSummary[] = [];
  let summaryFailure: unknown = null;
  let nightsKnown = false;
  let stageReads: SleepStageReads = new Map();
  try {
    const planRow = await prisma.withingsConnection.findUnique({
      where: { userId },
      select: { apiPlanState: true, sleepStageReads: true },
    });
    stageReads = parseSleepStageReads(planRow?.sleepStageReads);
    const sleepPlan = parseWithingsApiPlanState(
      planRow?.apiPlanState,
    ).sleepSummary;
    const reprobed = isPlanReprobeDue(sleepPlan, now);
    const skip = planSkipFor(sleepPlan, now);
    const plan = await requestWithinPlan({
      keys: SLEEP_SUMMARY_DATA_FIELDS.filter((f) => !skip.includes(f)),
      knownGated: WITHINGS_ADVANCED_SLEEP_FIELDS,
      fetch: (fields) =>
        fetchWithingsSleepSummary(
          tokenInfo.accessToken,
          ymdUtc(start),
          ymdUtc(now),
          fields,
        ),
    });
    summaries = plan.results;
    nightsKnown = plan.acceptedAny;
    if (
      shouldPersistPlanLeg({
        gated: plan.gated,
        reprobed,
        acceptedAny: plan.acceptedAny,
      })
    ) {
      await persistWithingsPlanLeg(userId, "sleepSummary", {
        unavailable: [...skip, ...plan.unavailable],
        checkedAt: planCheckedAtFor(sleepPlan, reprobed, now),
      });
    }
  } catch (err) {
    // Booked as this leg's failure once the stages are written: the summary
    // carries the vitals and names the nights, and a run without it is not
    // a healthy one. It used to be a warning, and the leg read green.
    summaryFailure = err;
    getEvent()?.addWarning(
      `withings sleep: summary fetch failed for ${userId}: ${err}`,
    );
  }

  // Without the night list (the summary failed, or the plan refused every
  // field it was asked for) the last 24 hours are read as one slice, so last
  // night still lands. Such a slice can cut a night, so it is never swept.
  const windows: StageWindow[] = nightsKnown
    ? await stageWindowsToFetch(userId, summaries, now, {
        all: opts.fullSync === true,
        reads: stageReads,
      })
    : [
        {
          startdate: endUnix - DAY_SECONDS,
          enddate: endUnix,
          wholeNight: false,
          recent: true,
        },
      ];

  const segments: WithingsSleepSegment[] = [];
  const wholeNightSessions = new Set<number>();
  const seenSegments = new Set<string>();
  // How each night's read went, for the per-night record below.
  const outcomes = new Map<string, SleepStageReadOutcome>();
  // The first read that failed. The nights read before and after it are
  // still written, and the summary vitals with them; the failure is booked
  // as the leg's once they are, and the night is read first next run.
  let stageFailure: unknown = null;
  for (const window of windows) {
    let series: WithingsSleepSegment[];
    try {
      series = await fetchWithingsSleep(
        tokenInfo.accessToken,
        window.startdate,
        window.enddate,
      );
    } catch (err) {
      // The stage timeline is a free-plan biomarker, so a plan refusal here
      // is not expected. If Withings ever moves it, the leg reads no stages
      // rather than failing: a 277 must not climb the strike ladder and park
      // the measures, activity and ECG legs along with it.
      if (isPlanGatedError(err)) {
        annotate({ meta: { withings_sleep_segments_skipped: "api_plan" } });
        break;
      }
      if (window.nightKey) outcomes.set(window.nightKey, "failed");
      const reauth =
        err instanceof WithingsApiError &&
        (err.withingsStatus === 403 ||
          err.classification === "reauth_required");
      // An older night that will not read is that night's problem, not the
      // connection's: the rest synced, so it is a warning, and the record
      // gives the night up after a few tries. A recent night, the blind
      // slice, or a refused grant fails the leg.
      if (window.recent || reauth) {
        stageFailure ??= err;
      } else {
        getEvent()?.addWarning(
          `withings sleep: stage read failed for an older night of ${userId}: ${err}`,
        );
        annotate({ meta: { withings_sleep_older_night_failed: true } });
      }
      // A revoked grant or a missing scope refuses every night alike, so the
      // rest are not asked for.
      if (reauth) break;
      continue;
    }
    let staged = false;
    for (const segment of series) {
      if (mapWithingsSleepState(segment.state)) staged = true;
      // Two windows can return the same segment (a night longer than its
      // 24-hour slice, a nap inside a night); it is written once.
      const key = `${segment.id ?? "no-id"}:${segment.startdate}`;
      if (seenSegments.has(key)) continue;
      seenSegments.add(key);
      segments.push(segment);
      if (window.wholeNight && typeof segment.id === "number") {
        wholeNightSessions.add(segment.id);
      }
    }
    if (window.nightKey) {
      outcomes.set(window.nightKey, staged ? "staged" : "empty");
    }
  }

  let imported = 0;
  // v1.4.39.1 — track every (type, measuredAt) we touched so the
  // persistent rollup tier can be re-folded at the end. See sync.ts for
  // the full rationale.
  const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];
  const insertedSleepMeasuredAts: Date[] = [];
  // Fresh segment externalIds per session id, driving the session-scoped
  // sweep below. Segments without a session id can't be bounded to one night
  // and are excluded (their `no-id` prefix would span every id-less night in
  // history, not just this fetch).
  const freshBySession = new Map<number, string[]>();

  // A reconcile throw out of either sleep transaction propagated past the
  // success stamp and both callers (cron + webhook) swallowed it: neither
  // success NOR failure was recorded, so `lastAttemptAt` sat quietly stale
  // during a persistent write failure. Record a transient failure at the source
  // AND rethrow — preserving the callers' existing warn-and-continue cohort
  // semantics — so the write failure surfaces on the status card without
  // touching either caller. The fetch-side `WithingsApiError` path already
  // records + rethrows above, so it never reaches these blocks.
  const recordSleepWriteFailure = async (err: unknown): Promise<never> => {
    await recordSyncFailure({
      userId,
      integration: "withings",
      kind: "transient",
      message: `sleep write failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      leg: WITHINGS_LEG_SLEEP,
    });
    throw err;
  };

  await prisma
    .$transaction(
      async (tx) => {
        for (const segment of segments) {
          const stage = mapWithingsSleepState(segment.state);
          if (!stage) continue;

          const measuredAt = new Date(segment.enddate * 1000);
          const durationSec = Math.max(0, segment.enddate - segment.startdate);
          const minutes = Math.round(durationSec / 60);
          const externalId = `withings:sleep:${userId}:${segment.id ?? "no-id"}:${segment.startdate}`;
          if (typeof segment.id === "number") {
            const fresh = freshBySession.get(segment.id) ?? [];
            fresh.push(externalId);
            freshBySession.set(segment.id, fresh);
          }

          const verdict = await reconcileExternalMeasurement(
            tx,
            {
              userId,
              type: SLEEP_TYPE,
              value: minutes,
              unit: getUnitForType(SLEEP_TYPE),
              measuredAt,
              source: "WITHINGS",
              sleepStage: stage,
              externalId,
            },
            { exactExternalMatch: "update" },
          );
          if (verdict.status === "failed") {
            throw new MeasurementReconciliationError(verdict);
          }
          // Refused by the plausibility gate: nothing was written and nothing
          // was touched. The drop is already on the wide event.
          if (verdict.status === "rejected_range") continue;
          for (const dirty of verdict.dirtyIdentities ?? []) {
            touched.push(dirty);
          }
          if (verdict.status === "inserted") {
            insertedSleepMeasuredAts.push(measuredAt);
          }
          touched.push({ type: SLEEP_TYPE, measuredAt });
          imported++;
        }
      },
      { timeout: 60_000 },
    )
    .catch(recordSleepWriteFailure);

  // Session-scoped sweep (mirrors Google Health's replace-by-window): for each
  // session this fetch re-produced, soft-delete any live WITHINGS
  // SLEEP_DURATION row under the session's externalId prefix that is NOT in
  // the fresh set. Collapses re-aggregation orphans AND every legacy
  // running-index row for re-fetched sessions. Sessions absent from this fetch
  // are never touched; a sweep failure never fails the sync (the session stays
  // inside the rolling 30-day window, so the hourly cron retries it).
  const sweeps: SleepSegmentSweep[] = [...freshBySession]
    // Only a session read across its whole night is swept: a 24-hour slice
    // can cut one, and sweeping it would retire the part outside the slice.
    .filter(([sessionId]) => wholeNightSessions.has(sessionId))
    .map(([sessionId, keepIds]) => ({
      prefix: `withings:sleep:${userId}:${sessionId}:`,
      keepIds,
    }));
  await sweepStaleSleepSegments(userId, "WITHINGS", sweeps);

  // v1.18.10 — nightly sleep vitals (avg HR / respiratory rate / SDNN HRV
  // / avg SpO2 / sleep score) from the per-night summary read above. Database
  // failures are hard sync failures.
  await prisma
    .$transaction(
      async (tx) => {
        for (const summary of summaries) {
          const measuredAt = new Date(summary.enddate * 1000);
          const sessionId = summary.id ?? "no-id";
          for (const vital of mapWithingsSleepSummary(summary.data)) {
            const verdict = await reconcileExternalMeasurement(
              tx,
              {
                userId,
                type: vital.type,
                value: vital.value,
                unit: getUnitForType(vital.type),
                measuredAt,
                source: "WITHINGS",
                externalId: `withings:sleep:${userId}:${sessionId}:${vital.fieldTag}`,
              },
              { exactExternalMatch: "update" },
            );
            if (verdict.status === "failed") {
              throw new MeasurementReconciliationError(verdict);
            }
            // Refused by the plausibility gate: nothing was written and
            // nothing was touched. The drop is already on the wide event.
            if (verdict.status === "rejected_range") continue;
            for (const dirty of verdict.dirtyIdentities ?? []) {
              touched.push(dirty);
            }
            touched.push({ type: vital.type, measuredAt });
            imported++;
          }
        }
      },
      { timeout: 60_000 },
    )
    .catch(recordSleepWriteFailure);

  // v1.4.39.1 — refresh the persistent rollup table for every distinct
  // (type, day) the sync touched. Sleep segments collapse heavily —
  // ~10 stage rows per night land in one DAY recompute.
  // The shared tail: the rollups, the measurement read caches back to the
  // oldest touched reading, and the cached assessments of the types.
  await afterMeasurementMutation(userId, touched, {
    source: "sync",
    label: "withings sleep",
  });

  // If a stage segment for last night just landed, kick the debounced
  // morning refresh so the digest/score finalise with the current sleep. The
  // trigger judges "last night" in the user's profile tz and no-ops on a
  // backfill; fire-and-forget so a freshness enqueue never fails the sync.
  void maybeEnqueueMorningRefresh(userId, insertedSleepMeasuredAts).catch(
    () => {},
  );

  if (nightsKnown) {
    const windowNightKeys = new Set(summaries.map(sleepNightKey));
    try {
      await prisma.withingsConnection.update({
        where: { userId },
        data: {
          sleepStageReads: serialiseSleepStageReads(
            nextSleepStageReads(stageReads, outcomes, windowNightKeys),
          ),
        },
      });
    } catch (err) {
      // Bookkeeping only: without it the next run reads as it did before.
      getEvent()?.addWarning(
        `withings sleep: stage-read record not saved for ${userId}: ${err}`,
      );
    }
  }

  if (stageFailure !== null) {
    // v1.4.43 — typed-classification path (see sync-activity.ts for the full
    // rationale). The thrown `WithingsApiError` carries the classification
    // verdict; `recordWithingsSyncFailure` routes it through
    // `classifyError`, which falls back to the legacy regex for
    // un-prototyped errors (pg-boss JSON round-trip).
    //
    // BL-P3-2 defence-in-depth — symmetric to sync-activity. A 403 on this
    // scope-gated endpoint always means scope-missing or token-revoked; force
    // `reauth_required` so the 3-strike alert still pages on the unexpected
    // case.
    const withingsStatus =
      stageFailure instanceof WithingsApiError
        ? stageFailure.withingsStatus
        : undefined;
    if (withingsStatus === 403) {
      await recordSyncFailure({
        userId,
        integration: "withings",
        kind: "reauth_required",
        message:
          stageFailure instanceof Error
            ? stageFailure.message
            : String(stageFailure),
        errorCode: "403",
        leg: WITHINGS_LEG_SLEEP,
      });
    } else {
      await recordWithingsSyncFailure(userId, stageFailure, WITHINGS_LEG_SLEEP);
    }
    throw stageFailure;
  }
  if (summaryFailure !== null) {
    await recordWithingsSyncFailure(userId, summaryFailure, WITHINGS_LEG_SLEEP);
    return imported;
  }
  await recordSyncSuccess(userId, "withings", { leg: WITHINGS_LEG_SLEEP });
  return imported;
}

const DAY_SECONDS = 24 * 60 * 60;

/** Nights that ended this recently are read again on every run (re-scores). */
const RECENT_NIGHT_SECONDS = 2 * DAY_SECONDS;

/**
 * Stage reads per run beyond the recent nights. A new connection, or a
 * window the sleep-timeline backfill just cleared, fills in over a few runs
 * instead of firing thirty requests at once; a full sync reads every night.
 */
export const SLEEP_STAGE_NIGHTS_PER_RUN = 8;

/** One `action=get` read: a night's own span, at most 24 hours. */
interface StageWindow {
  startdate: number;
  enddate: number;
  /** The read covers the whole night, so its session may be swept. */
  wholeNight: boolean;
  /** The summary night it reads (`sleepNightKey`), absent for the blind slice. */
  nightKey?: string;
  /**
   * The night ended, or Withings changed it, in the last 48 hours (the blind
   * slice is always recent). Only a failed recent read fails the leg.
   */
  recent: boolean;
}

/**
 * The nights whose stage timeline this run reads, from the summary's night
 * list: every night that ended, or that Withings changed (`modified`), in the
 * last 48 hours, since Withings re-scores a night after the fact; then nights
 * that hold no Withings stage row yet,
 * up to `SLEEP_STAGE_NIGHTS_PER_RUN`. The missing nights rotate by the hour,
 * so a night that never carries stages (a tracker without them) cannot keep
 * the ones behind it waiting.
 */
async function stageWindowsToFetch(
  userId: string,
  summaries: readonly WithingsSleepSummary[],
  now: Date,
  opts: { all: boolean; reads: SleepStageReads },
): Promise<StageWindow[]> {
  const nights = new Map<
    string,
    { startdate: number; enddate: number; changed: number }
  >();
  for (const s of summaries) {
    if (!Number.isFinite(s.startdate) || !Number.isFinite(s.enddate)) continue;
    if (s.enddate <= s.startdate) continue;
    const modified = Number.isFinite(s.modified) ? s.modified! : 0;
    const key = `${s.startdate}:${s.enddate}`;
    nights.set(key, {
      startdate: s.startdate,
      enddate: s.enddate,
      changed: Math.max(s.enddate, modified, nights.get(key)?.changed ?? 0),
    });
  }
  const all = [...nights.values()].sort((x, y) => y.enddate - x.enddate);
  const nowUnix = Math.floor(now.getTime() / 1000);
  const toWindow = (n: {
    startdate: number;
    enddate: number;
    changed: number;
  }): StageWindow => ({
    startdate: n.startdate,
    enddate: Math.min(n.enddate, n.startdate + DAY_SECONDS),
    wholeNight: n.enddate - n.startdate <= DAY_SECONDS,
    nightKey: sleepNightKey(n),
    recent: n.changed >= nowUnix - RECENT_NIGHT_SECONDS,
  });
  if (opts.all || all.length === 0) return all.map(toWindow);

  // Recent: ended, or was changed by Withings, within the last 48 hours.
  const recent = all.filter((n) => n.changed >= nowUnix - RECENT_NIGHT_SECONDS);
  const older = all.filter((n) => n.changed < nowUnix - RECENT_NIGHT_SECONDS);
  if (older.length === 0) return recent.map(toWindow);

  // Segments are stamped at their END, so a night holds a stage row when one
  // ends inside (startdate, enddate]. One read over the span of the older
  // nights, on the `(user_id, type, measured_at)` index.
  const first = Math.min(...older.map((n) => n.startdate));
  const last = Math.max(...older.map((n) => n.enddate));
  const stored = await prisma.measurement.findMany({
    where: {
      userId,
      source: "WITHINGS",
      type: SLEEP_TYPE,
      deletedAt: null,
      measuredAt: { gt: new Date(first * 1000), lte: new Date(last * 1000) },
    },
    select: { measuredAt: true },
  });
  const endsAt = stored.map((row) => row.measuredAt.getTime() / 1000);
  // A night whose last read failed goes first. One that answered without a
  // stage `SLEEP_STAGE_MAX_EMPTY_READS` times is not asked again: the tracker
  // does not stage it, and reading it every run for a month cost a request
  // an hour for nothing.
  const record = (n: { startdate: number; enddate: number }) =>
    opts.reads.get(sleepNightKey(n));
  const missing = older
    .filter((n) => !endsAt.some((t) => t > n.startdate && t <= n.enddate))
    .filter((n) => !isSleepNightGivenUp(record(n)))
    .sort((x, y) => x.enddate - y.enddate);
  const failed = missing.filter((n) => record(n)?.failed === true);
  const rest = missing.filter((n) => record(n)?.failed !== true);
  const budget = Math.max(0, SLEEP_STAGE_NIGHTS_PER_RUN - recent.length);
  if (missing.length <= budget) {
    return [...recent, ...failed, ...rest].map(toWindow);
  }
  const restBudget = Math.max(0, budget - failed.length);
  const offset =
    rest.length === 0 ? 0 : Math.floor(nowUnix / 3600) % rest.length;
  const rotated = [...rest.slice(offset), ...rest.slice(0, offset)];
  return [
    ...recent,
    ...failed.slice(0, budget),
    ...rotated.slice(0, restBudget),
  ].map(toWindow);
}
