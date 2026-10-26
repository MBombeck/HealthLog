/**
 * v1.4.25 — Withings Activity sync.
 *
 * Pulls daily aggregates from `POST /v2/measure?action=getactivity`
 * and writes one Measurement row per (date, metric). The webhook
 * trigger (appli=16) drives most calls in production; the hourly
 * pg-boss cron (`withings-activity-sync`) is the safety net for the
 * 1 % of webhook deliveries Withings drops.
 *
 * Field mapping (research §1 + §4):
 *
 *   - `steps`     → ACTIVITY_STEPS         (count)
 *   - `distance`  → WALKING_RUNNING_DISTANCE (metres)
 *   - `calories`  → ACTIVE_ENERGY_BURNED   (kcal)
 *
 * `elevation`, `totalcalories`, soft/moderate/intense/active duration
 * are deliberately skipped — no clean MeasurementType counterpart
 * today. Re-evaluated when v1.5 ships the iOS workout passthrough.
 *
 * Idempotency: every row writes through the v1.4.25 W17b/c composite
 * unique (Migration 0055 — `(userId, type, measuredAt, source,
 * sleepStage)` with NULLS NOT DISTINCT). `sleepStage` is NULL for
 * every activity row, so the four-column dedup behaviour is unchanged
 * and the same date re-syncing simply updates `value`.
 *
 * Date semantics: Withings reports per-day aggregates with `date` as
 * `YYYY-MM-DD`. We anchor `measuredAt` at the day's noon UTC
 * (12:00:00Z) so the row's instant lands inside the local day for every
 * user timezone in the [-11, +12] range — a row tagged 2026-05-12 always
 * day-keys to 2026-05-12 whether the reader sits in Honolulu, Berlin or
 * Tokyo. Anchoring at 23:59:59Z (the v1.4.25 W17b shape) was wrong for
 * positive-offset users: a row from `date=2026-05-12` arrived as a
 * 2026-05-13 reading in Tokyo, off-by-one for every dashboard tile that
 * reads the row in user-local time.
 */
import type { MeasurementType } from "@/generated/prisma/client";

import { prisma } from "@/lib/db";
import { canonicalDailyTimestamp } from "@/lib/measurements/consolidation-tz";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { daysWithOtherStepSource } from "@/lib/withings/other-step-source-days";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";
import { getUnitForType } from "@/lib/validations/measurement";
import { dropImplausibleMeasurements } from "@/lib/measurements/plausibility-gate";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";

import { WITHINGS_MAX_PAGES, withingsNextOffset } from "./client";
import { hasActivityScope } from "./oauth";
import {
  WithingsApiError,
  classifyWithingsResponse,
} from "./response-classifier";
import {
  WITHINGS_LEG_ACTIVITY,
  getValidToken,
  recordWithingsSyncFailure,
} from "./sync";
import { isPlanGatedError } from "./api-plan";
import {
  isReauthRequired,
  parkIntegrationAtReauth,
  recordSyncFailure,
  recordSyncSuccess,
} from "@/lib/integrations/status";
import { walkPages } from "@/lib/integrations/page-walk";

const WITHINGS_MEASURE_URL = "https://wbsapi.withings.net/v2/measure";

/**
 * Default backfill window for the FIRST activity sync of a connection.
 * Matches the measurement-sync default in `sync.ts` so a freshly
 * reconnected user lights up the same 30 days of history across every
 * Withings ingest path.
 */
const ACTIVITY_BACKFILL_DAYS = 30;

/** `brand` of a Getactivity day that came from outside Withings. */
const WITHINGS_EXTERNAL_BRAND = 18;

/**
 * Withings `getactivity` response shape — one entry per calendar day.
 * Only the fields we consume are typed; the response carries 15+ more
 * fields that future waves may pull in.
 *
 * https://developer.withings.com/api-reference#tag/measure/operation/measurev2-getactivity
 */
export interface WithingsActivityEntry {
  date: string; // YYYY-MM-DD
  timezone?: string;
  steps?: number;
  distance?: number; // metres
  calories?: number; // active kcal (NOT totalcalories)
  /**
   * Where the day came from: 1 for a Withings device or the Health Mate
   * app's own tracker, 18 for "an external way" (Getactivity: "Value is 1
   * for Withings and 18 for external"), i.e. data another app wrote into
   * Health Mate, such as an Apple Health or Google Fit day.
   */
  brand?: number;
  // The fields below are not ingested today (see file header):
  elevation?: number;
  totalcalories?: number;
  soft?: number;
  moderate?: number;
  intense?: number;
  active?: number;
}

/**
 * Per-row mapping table. Each entry tells the writer: which field on
 * the activity entry to read, which MeasurementType bucket to write,
 * and which canonical unit string to stamp on the row. Adding a new
 * field (e.g. `elevation` once FLIGHTS_CLIMBED canonicalisation
 * settles) is one row here plus no other code change.
 */
const ACTIVITY_FIELD_MAP: ReadonlyArray<{
  field: keyof Pick<WithingsActivityEntry, "steps" | "distance" | "calories">;
  type: MeasurementType;
}> = [
  { field: "steps", type: "ACTIVITY_STEPS" },
  { field: "distance", type: "WALKING_RUNNING_DISTANCE" },
  { field: "calories", type: "ACTIVE_ENERGY_BURNED" },
];

/**
 * Where the per-day activity rows sat up to v1.39.2: noon UTC of the date.
 * Still read, so a row written under that anchor is found and moved to the
 * local-noon anchor instead of being duplicated.
 */
function legacyActivityMeasuredAt(yyyymmdd: string): Date {
  return new Date(`${yyyymmdd}T12:00:00.000Z`);
}

/**
 * Fetch activity entries from Withings for the given user. Returns
 * the raw entries (no DB write) so callers can compose the write
 * step (which itself uses Prisma helpers).
 */
export async function fetchWithingsActivity(
  accessToken: string,
  startdateymd: string,
  enddateymd: string,
): Promise<WithingsActivityEntry[]> {
  const baseParams: Record<string, string> = {
    action: "getactivity",
    startdateymd,
    enddateymd,
    // The Withings getactivity response carries optional fields only
    // when explicitly listed in `data_fields`. Steps + distance +
    // calories cover the W17b mapping; future expansion adds fields
    // here without touching the write path.
    data_fields: "steps,distance,calories",
  };

  const walk = await walkPages<number, WithingsActivityEntry>(
    "withings.activity",
    WITHINGS_MAX_PAGES,
    async (cursor, page) => {
      const offset = cursor ?? 0;
      const params = new URLSearchParams({
        ...baseParams,
        offset: String(offset),
      });
      const pageStart = performance.now();
      const res = await safeFetch(WITHINGS_MEASURE_URL, {
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
        method: `fetchWithingsActivity(page=${page})`,
        duration_ms: Math.round(performance.now() - pageStart),
        status: res.status,
        error:
          verdict.classification === "success" ? undefined : verdict.reason,
      });
      if (verdict.classification !== "success") {
        throw new WithingsApiError({
          verb: "activity",
          classification: verdict.classification,
          withingsStatus: verdict.withingsStatus,
          reason: verdict.reason,
          upstreamError:
            typeof json?.error === "string" ? json.error : undefined,
        });
      }
      const body = json.body ?? {};
      const activities: WithingsActivityEntry[] = body.activities ?? [];
      return { items: activities, next: withingsNextOffset(body, offset) };
    },
    0,
  );
  return walk.items;
}

/**
 * Sync activity data for a single user. Writes one Measurement row
 * per (date, metric) where the corresponding Withings field is
 * present and finite. Returns the number of upserted rows.
 *
 * Parks at `error_reauth` short-circuit identical to
 * `syncUserMeasurements` — the user has to redo OAuth before the next
 * cron tick will attempt anything.
 */
export async function syncUserActivity(
  userId: string,
  opts: { fullSync?: boolean } = {},
): Promise<number> {
  if (await isReauthRequired(userId, "withings")) {
    getEvent()?.addWarning(
      `withings activity sync skipped for ${userId}: parked at error_reauth`,
    );
    return 0;
  }

  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  // v1.4.26 — scope-skip guard. The W17b activity endpoint is gated on
  // `user.activity`; legacy v1.4.24-and-earlier connections sit on
  // `user.metrics` only and Withings returns HTTP 200 / status 403 for
  // every request. Without this short-circuit the call fires, the
  // catch-block classifies the 403 as `"transient"` (the refresh-token
  // worked; only the resource call failed), pg-boss retries, and the
  // 3-strike alert fires for every legacy user that hasn't reconnected
  // since W5d. The Settings reconnect-banner is already in place — the
  // sync just has to stop hammering the endpoint until the user acts.
  //
  // Park behaviour: mark the connection `error_reauth` so the next
  // hourly cron tick also short-circuits via `isReauthRequired` above
  // (cheap query, no upstream call). `getValidToken` already fetched
  // the connection row to refresh the access token; we re-read the
  // `scope` column with a `select` so the call is one indexed lookup.
  const connection = await prisma.withingsConnection.findUnique({
    where: { userId },
    select: { scope: true },
  });
  if (!hasActivityScope(connection?.scope ?? null)) {
    getEvent()?.addWarning(
      `withings activity sync skipped for ${userId}: missing user.activity scope (legacy connection — reconnect required)`,
    );
    // v1.4.27 — silent park. The scope-skip is a deliberate no-op, not
    // a failure burst, so the 3-strike admin alert must NOT fire from
    // this branch. `parkIntegrationAtReauth` sets the row to
    // `error_reauth` without incrementing the failure counter and
    // without entering the threshold ladder. The defence-in-depth 403
    // catch-block below stays on `recordSyncFailure` — a 403 reaching
    // the catch IS unexpected once the scope-skip lands.
    await parkIntegrationAtReauth({
      userId,
      integration: "withings",
      message:
        "Withings connection is missing the user.activity scope. Reconnect Withings in Settings to enable activity sync.",
      errorCode: "scope_missing",
      leg: WITHINGS_LEG_ACTIVITY,
    });
    return 0;
  }

  // 30-day rolling window keeps the call cheap (≤ one page) and
  // self-heals stale rows from a clock skew or a backfill replay.
  // The webhook-driven path narrows naturally to today/yesterday;
  // the cron fallback walks the full window.
  void opts.fullSync; // reserved for future expansion
  // Withings activity is keyed by the user's calendar date, so the window
  // is cut on the user's own days: a UTC cut left "today" out of the fetch
  // until UTC caught up with a zone ahead of it.
  const timeZone = await resolveUserTimezone(userId);
  const today = userDayKey(new Date(), timeZone);

  let entries: WithingsActivityEntry[];
  try {
    entries = await fetchWithingsActivity(
      tokenInfo.accessToken,
      shiftDateKey(today, -ACTIVITY_BACKFILL_DAYS),
      today,
    );
  } catch (err) {
    // v1.4.43 — typed-classification path. The thrown
    // `WithingsApiError` from `fetchWithingsActivity` carries the
    // verdict + `withingsStatus` directly; `recordWithingsSyncFailure`
    // routes it through `classifyError`, which falls back to the regex
    // parse for plain `Error` instances (e.g. a pg-boss retry that lost
    // the prototype during JSON round-trip). Pre-v1.4.43 this branch
    // re-parsed the message via `extractWithingsStatus` +
    // `isWithingsRefreshReauthFailure`, duplicating logic the
    // response-classifier already owns.
    //
    // BL-P3-2 defence-in-depth — a Withings 403 on this scope-gated
    // endpoint always means scope-missing or token-revoked; force the
    // verdict to `reauth_required` so pg-boss stops retrying and the
    // 3-strike alert still pages on the unexpected case. The
    // response-classifier's body-status taxonomy doesn't list 403
    // (Withings emits 403 only through the HTTP layer for scope-gated
    // resources), so the override has to live at the call site rather
    // than in the shared classifier.
    //
    // Steps, distance and calories are free-plan biomarkers, so a plan refusal
    // (277) is not expected. If Withings ever moves one, the leg reads nothing
    // rather than failing, so a plan limit cannot park every Withings leg.
    if (isPlanGatedError(err)) {
      getEvent()?.addWarning(
        "withings activity: refused by the API plan (277), skipped",
      );
      await recordSyncSuccess(userId, "withings", {
        leg: WITHINGS_LEG_ACTIVITY,
      });
      return 0;
    }
    const withingsStatus =
      err instanceof WithingsApiError ? err.withingsStatus : undefined;
    if (withingsStatus === 403) {
      await recordSyncFailure({
        userId,
        integration: "withings",
        kind: "reauth_required",
        message: err instanceof Error ? err.message : String(err),
        errorCode: "403",
        leg: WITHINGS_LEG_ACTIVITY,
      });
      throw err;
    }
    await recordWithingsSyncFailure(userId, err, WITHINGS_LEG_ACTIVITY);
    throw err;
  }

  let imported = 0;
  // A swallowed batch-write must not read as a clean sync. The catch
  // below sets this so the tail stamps success ONLY when the write landed; a
  // persistent write bug then accrues strikes instead of being reset by its
  // own success stamp every tick.
  let writeFailed = false;
  // v1.4.39.1 — track every (type, measuredAt) we touched so the
  // persistent rollup tier can be re-folded at the end of the sync.
  // See sync.ts header for the full rationale; the chart's
  // `source=rollup` fast-path otherwise misses Withings activity days.
  const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];

  // v1.20.2 — flatten (entry × field) into the concrete rows the sync
  // wants to land, then batch the reads + writes. The pre-v1.20.2 shape
  // ran a per-(entry, field) `findFirst` + `update`/`create`, i.e.
  // ~entries × 3 × 2 round-trips (≈ 2,190 on a 365-day backfill). The
  // overwrite contract is unchanged: an existing WITHINGS row for the
  // `(type, measuredAt)` slot has its `value` rewritten (the four-column
  // dedup keys on `(userId, type, measuredAt, source, sleepStage=null)`),
  // a fresh slot is inserted with the stable `externalId`.
  interface PlannedRow {
    type: MeasurementType;
    measuredAt: Date;
    /** The pre-v1.39.3 noon-UTC anchor of the same date. */
    legacyMeasuredAt: Date;
    value: number;
    externalId: string;
  }
  const collected: PlannedRow[] = [];
  // A day Health Mate holds from another app is that app's data. When the
  // app reaches HealthLog through its own integration (Apple Health, Health
  // Connect, Google Health, a wearable), the WITHINGS import was a second
  // copy under the wrong name, and on a day that copy was the only Withings
  // row it could outrank a native source further down the ladder. When
  // nothing else delivered steps that day, Health Mate is the account's only
  // way in for them, so the day is kept.
  const externalDates = entries
    .filter((e) => e.date && e.brand === WITHINGS_EXTERNAL_BRAND)
    .map((e) => e.date);
  const duplicateDays = await daysWithOtherStepSource(
    userId,
    externalDates,
    timeZone,
  );
  let external = 0;
  for (const entry of entries) {
    if (!entry.date) continue;
    if (
      entry.brand === WITHINGS_EXTERNAL_BRAND &&
      duplicateDays.has(entry.date)
    ) {
      external++;
      continue;
    }
    // Local noon of the date in the user's zone: the instant reads the same
    // calendar day there. Noon UTC read as the next day from UTC+13 on
    // (Auckland in summer, Tonga, Samoa), so every daily total landed a day
    // late for those users.
    const measuredAt = canonicalDailyTimestamp(entry.date, timeZone);
    for (const { field, type } of ACTIVITY_FIELD_MAP) {
      const raw = entry[field];
      // Withings returns 0 for "active but no movement" — that's
      // valid (a day of rest still records 0 steps). Only skip
      // undefined / null / NaN.
      if (raw == null || !Number.isFinite(raw)) continue;
      collected.push({
        type,
        measuredAt,
        legacyMeasuredAt: legacyActivityMeasuredAt(entry.date),
        value: raw,
        externalId: `withings:activity:${userId}:${entry.date}:${field}`,
      });
    }
  }

  if (external > 0) {
    getEvent()?.addWarning(
      `withings activity: skipped ${external} day(s) Health Mate holds from another app that syncs its own steps`,
    );
  }

  // A daily-activity total the app's own band calls impossible (a step count
  // past 200 000, a negative distance) is a provider artefact, not a day. Drop
  // it before the plan is read against the table, so it can neither insert a
  // fresh impossible slot nor overwrite a good stored one.
  const planned = dropImplausibleMeasurements("withings", collected, (p) => ({
    type: p.type,
    value: p.value,
  }));

  if (planned.length > 0) {
    const slotKey = (type: MeasurementType, measuredAt: Date) =>
      `${type}|${measuredAt.getTime()}`;

    try {
      // One read for the whole batch: every existing WITHINGS / non-sleep
      // row for a planned day, found by its stable `externalId` or, for a
      // row written before it carried one, by the day's old noon-UTC slot.
      // A match is rewritten in place, including its `measuredAt`, so a row
      // written under the old anchor moves to local noon on the next sync
      // rather than being duplicated beside it.
      const distinctTypes = [...new Set(planned.map((p) => p.type))];
      const existingRows = await prisma.measurement.findMany({
        where: {
          userId,
          source: "WITHINGS",
          sleepStage: null,
          type: { in: distinctTypes },
          OR: [
            { externalId: { in: planned.map((p) => p.externalId) } },
            {
              measuredAt: {
                in: [
                  ...new Map(
                    planned.flatMap((p) => [
                      [p.measuredAt.getTime(), p.measuredAt],
                      [p.legacyMeasuredAt.getTime(), p.legacyMeasuredAt],
                    ]),
                  ).values(),
                ],
              },
            },
          ],
        },
        select: {
          id: true,
          type: true,
          measuredAt: true,
          externalId: true,
          value: true,
          deletedAt: true,
        },
      });
      type Existing = (typeof existingRows)[number];
      const byExternalId = new Map<string, Existing>();
      const bySlot = new Map<string, Existing>();
      for (const row of existingRows) {
        if (row.externalId) byExternalId.set(row.externalId, row);
        bySlot.set(slotKey(row.type, row.measuredAt), row);
      }

      const toCreate: PlannedRow[] = [];
      const toUpdate: Array<{ id: string; p: PlannedRow }> = [];
      for (const p of planned) {
        const existing =
          byExternalId.get(p.externalId) ??
          bySlot.get(slotKey(p.type, p.measuredAt)) ??
          bySlot.get(slotKey(p.type, p.legacyMeasuredAt));
        if (existing) {
          // Only write when something moved — a re-sync of an unchanged LIVE
          // day is then a pure no-op on the write path. A TOMBSTONED row
          // always writes: the update is what resurrects it (`deletedAt:
          // null`) — Withings is the source of truth for its own rows
          // (mirrors Google / Fitbit).
          const moved =
            existing.measuredAt.getTime() !== p.measuredAt.getTime();
          if (
            existing.value !== p.value ||
            existing.deletedAt !== null ||
            moved ||
            existing.externalId !== p.externalId
          ) {
            toUpdate.push({ id: existing.id, p });
          }
          // The day the row leaves needs its rollup refolded too.
          if (moved) {
            touched.push({ type: p.type, measuredAt: existing.measuredAt });
          }
        } else {
          toCreate.push(p);
        }
        touched.push({ type: p.type, measuredAt: p.measuredAt });
        imported++;
      }

      // One insert for every fresh slot. `skipDuplicates` tolerates a
      // concurrent sibling sync landing the same slot between the read
      // and this write (the four-column unique catches it).
      if (toCreate.length > 0) {
        await prisma.measurement.createMany({
          data: toCreate.map((p) => ({
            userId,
            type: p.type,
            value: p.value,
            unit: getUnitForType(p.type),
            measuredAt: p.measuredAt,
            source: "WITHINGS" as const,
            externalId: p.externalId,
          })),
          skipDuplicates: true,
        });
      }

      // Values differ per row, so the overwrites can't collapse into one
      // `updateMany`; run them in a single transaction so the batch is one
      // round-trip rather than one per row.
      if (toUpdate.length > 0) {
        await prisma.$transaction(
          toUpdate.map((u) =>
            prisma.measurement.update({
              where: { id: u.id },
              // `deletedAt: null` — no-op on a live row, deliberate
              // RESURRECTION on a tombstoned one (see the skip above).
              data: {
                value: u.p.value,
                measuredAt: u.p.measuredAt,
                externalId: u.p.externalId,
                deletedAt: null,
              },
            }),
          ),
        );
      }
    } catch (err) {
      // Data is lost for this tick and the pill would otherwise read green. Keep
      // the no-rethrow (sibling day-chunks + the rollup fold still run) but
      // record a transient failure and refuse the success stamp below.
      // `transient` because the next hourly tick re-walks the fixed 30-day
      // window, so a transient DB error self-heals while a persistent one now
      // surfaces on the status card instead of resetting itself.
      writeFailed = true;
      getEvent()?.addWarning(
        `Failed to batch-upsert ${planned.length} activity rows for ${userId}: ${err}`,
      );
      await recordSyncFailure({
        userId,
        integration: "withings",
        kind: "transient",
        message: `activity batch write failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        leg: WITHINGS_LEG_ACTIVITY,
      });
    }
  }

  // v1.4.39.1 — refresh the persistent rollup table for every distinct
  // (type, day) the sync touched. Collapsed so a multi-day Withings
  // catch-up costs at most ~N (type, day) recomputes.
  // The shared tail: the rollups, the measurement read caches back to the
  // oldest touched reading, and the cached assessments of the types.
  await afterMeasurementMutation(userId, touched, {
    source: "sync",
    label: "withings activity",
  });

  // Only a clean write stamps success. A swallowed batch-write left the
  // ledger honest via the transient failure recorded above.
  if (!writeFailed) {
    await recordSyncSuccess(userId, "withings", {
      leg: WITHINGS_LEG_ACTIVITY,
    });
  }
  return imported;
}
