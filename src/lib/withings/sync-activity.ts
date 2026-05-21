/**
 * v1.4.25 W17b — Withings Activity sync.
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
import { getEvent } from "@/lib/logging/context";
import { getUnitForType } from "@/lib/validations/measurement";
import {
  collapseToTypeDayKeys,
  recomputeBucketsForMeasurement,
} from "@/lib/rollups/measurement-rollups";

import { hasActivityScope } from "./client";
import {
  extractWithingsStatus,
  isWithingsRefreshReauthFailure,
} from "./sync";
import { getValidToken } from "./sync";
import {
  isReauthRequired,
  parkIntegrationAtReauth,
  recordSyncFailure,
  recordSyncSuccess,
} from "@/lib/integrations/status";

const WITHINGS_MEASURE_URL = "https://wbsapi.withings.net/v2/measure";

/**
 * Default backfill window for the FIRST activity sync of a connection.
 * Matches the measurement-sync default in `sync.ts` so a freshly
 * reconnected user lights up the same 30 days of history across every
 * Withings ingest path.
 */
const ACTIVITY_BACKFILL_DAYS = 30;

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
 * Anchor a per-day activity row at noon UTC. Chosen so the instant
 * always lands inside the local day for users in the [-11, +12] zone
 * range — anchoring at end-of-day UTC (the v1.4.25 W17b shape) sent
 * Tokyo readings into the *following* local day, mis-bucketing every
 * positive-offset user's "today" tile. Noon UTC is the standard
 * "calendar-day with no clock" representation per RFC 3339 §5.6 and
 * the JS `Date` analytics layer day-keys it cleanly in every
 * supported user timezone.
 */
function activityMeasuredAt(yyyymmdd: string): Date {
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

  const results: WithingsActivityEntry[] = [];
  let offset = 0;
  let pageCount = 0;
  while (true) {
    const params = new URLSearchParams({
      ...baseParams,
      offset: String(offset),
    });
    const pageStart = performance.now();
    const res = await fetch(WITHINGS_MEASURE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${accessToken}`,
      },
      body: params.toString(),
    });
    const json = await res.json();
    getEvent()?.addExternalCall({
      service: "withings",
      method: `fetchWithingsActivity(page=${pageCount})`,
      duration_ms: Math.round(performance.now() - pageStart),
      status: res.status,
      error: json.status !== 0 ? `status=${json.status}` : undefined,
    });
    if (json.status !== 0) {
      throw new Error(`Withings activity error: ${json.status}`);
    }

    const body = json.body ?? {};
    const activities: WithingsActivityEntry[] = body.activities ?? [];
    for (const entry of activities) {
      results.push(entry);
    }

    const hasMore = body.more === true || body.more === 1;
    if (!hasMore) break;
    const nextOffset = Number(body.offset);
    if (!Number.isFinite(nextOffset) || nextOffset <= offset) break;
    offset = nextOffset;
    pageCount += 1;
    if (pageCount > 1000) break;
  }
  return results;
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
    });
    return 0;
  }

  // 30-day rolling window keeps the call cheap (≤ one page) and
  // self-heals stale rows from a clock skew or a backfill replay.
  // The webhook-driven path narrows naturally to today/yesterday;
  // the cron fallback walks the full window.
  void opts.fullSync; // reserved for future expansion
  const now = new Date();
  const start = new Date(
    now.getTime() - ACTIVITY_BACKFILL_DAYS * 24 * 60 * 60 * 1000,
  );
  const ymd = (d: Date) => d.toISOString().slice(0, 10);

  let entries: WithingsActivityEntry[];
  try {
    entries = await fetchWithingsActivity(
      tokenInfo.accessToken,
      ymd(start),
      ymd(now),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = extractWithingsStatus(message);
    // v1.4.26 defence-in-depth — a 403 from a scope-gated endpoint
    // always means scope-missing or token-revoked. Park at
    // `error_reauth` rather than `transient` so pg-boss stops
    // retrying and the 3-strike alert doesn't fire. The early
    // scope-skip above covers the common case; this catches the
    // race where Withings revokes scope between OAuth and the next
    // sync without invalidating the refresh token.
    const isReauth =
      isWithingsRefreshReauthFailure(message) || status === "403";
    await recordSyncFailure({
      userId,
      integration: "withings",
      kind: isReauth ? "reauth_required" : "transient",
      message,
      errorCode: status,
    });
    throw err;
  }

  let imported = 0;
  // v1.4.39.1 — track every (type, measuredAt) we touched so the
  // persistent rollup tier can be re-folded at the end of the sync.
  // See sync.ts header for the full rationale; the chart's
  // `source=rollup` fast-path otherwise misses Withings activity days.
  const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];
  for (const entry of entries) {
    if (!entry.date) continue;
    const measuredAt = activityMeasuredAt(entry.date);
    for (const { field, type } of ACTIVITY_FIELD_MAP) {
      const raw = entry[field];
      // Withings returns 0 for "active but no movement" — that's
      // valid (a day of rest still records 0 steps). Only skip
      // undefined / null / NaN.
      if (raw == null || !Number.isFinite(raw)) continue;
      try {
        const existing = await prisma.measurement.findFirst({
          where: {
            userId,
            type,
            measuredAt,
            source: "WITHINGS",
            sleepStage: null,
          },
          select: { id: true },
        });
        if (existing) {
          await prisma.measurement.update({
            where: { id: existing.id },
            data: { value: raw },
          });
        } else {
          await prisma.measurement.create({
            data: {
              userId,
              type,
              value: raw,
              unit: getUnitForType(type),
              measuredAt,
              source: "WITHINGS",
              externalId: `withings:activity:${userId}:${entry.date}:${field}`,
            },
          });
        }
        touched.push({ type, measuredAt });
        imported++;
      } catch (err) {
        getEvent()?.addWarning(
          `Failed to upsert activity row (${type}, ${entry.date}): ${err}`,
        );
      }
    }
  }

  // v1.4.39.1 — refresh the persistent rollup table for every distinct
  // (type, day) the sync touched. Collapsed so a multi-day Withings
  // catch-up costs at most ~N (type, day) recomputes.
  try {
    const keys = collapseToTypeDayKeys(touched);
    for (const k of keys) {
      await recomputeBucketsForMeasurement(userId, k.type, k.measuredAt);
    }
  } catch (err) {
    getEvent()?.addWarning(
      `withings activity: rollup recompute failed for ${userId}: ${err}`,
    );
  }

  await recordSyncSuccess(userId, "withings");
  return imported;
}
