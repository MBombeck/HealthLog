/**
 * v1.4.25 W17c — Withings Sleep v2 sync.
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
 * Idempotency: every segment writes through the v1.4.25 W17b/c
 * composite (Migration 0055 — `(userId, type, measuredAt, source,
 * sleepStage)` with NULLS NOT DISTINCT). The five-tuple guarantees a
 * re-sync upserts the same row rather than inserting a duplicate, even
 * when Withings re-emits the night with adjusted segment boundaries.
 *
 * Date semantics: each segment's `measuredAt` is the segment's
 * `startdate` (unix seconds → `Date`). The duration in minutes lands
 * in `value`. The HealthLog analytics aggregator already groups
 * stage rows under their parent night via the per-night `dayKey`
 * helper, so the segment-level timestamp is the canonical sort key.
 */
import type { MeasurementType, SleepStage } from "@/generated/prisma/client";

import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { getUnitForType } from "@/lib/validations/measurement";
import {
  collapseToTypeDayKeys,
  recomputeBucketsForMeasurement,
} from "@/lib/rollups/measurement-rollups";

import { hasActivityScope } from "./client";
import {
  WithingsApiError,
  classifyWithingsResponse,
} from "./response-classifier";
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

const WITHINGS_SLEEP_URL = "https://wbsapi.withings.net/v2/sleep";

/**
 * Default backfill window for the first sleep sync of a connection.
 * Matches every other Withings ingest path so a reconnect lights up
 * 30 days of stage data.
 */
const SLEEP_BACKFILL_DAYS = 30;

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
  const res = await fetch(WITHINGS_SLEEP_URL, {
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
    });
    return 0;
  }

  void opts.fullSync;
  const now = new Date();
  const start = new Date(
    now.getTime() - SLEEP_BACKFILL_DAYS * 24 * 60 * 60 * 1000,
  );
  const startUnix = Math.floor(start.getTime() / 1000);
  const endUnix = Math.floor(now.getTime() / 1000);

  let segments: WithingsSleepSegment[];
  try {
    segments = await fetchWithingsSleep(
      tokenInfo.accessToken,
      startUnix,
      endUnix,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = extractWithingsStatus(message);
    // v1.4.26 defence-in-depth — see sync-activity.ts. A 403 on a
    // scope-gated endpoint always means scope-missing or token-revoked.
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
  let segmentIndex = 0;
  // v1.4.39.1 — track every (type, measuredAt) we touched so the
  // persistent rollup tier can be re-folded at the end. See sync.ts for
  // the full rationale.
  const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];
  for (const segment of segments) {
    const stage = mapWithingsSleepState(segment.state);
    if (!stage) {
      // State 4 (manual / synthetic marker) is ignored — see file
      // header.
      segmentIndex++;
      continue;
    }
    const measuredAt = new Date(segment.startdate * 1000);
    const durationSec = Math.max(0, segment.enddate - segment.startdate);
    // Canonical SLEEP_DURATION unit is minutes (Apple Health alignment,
    // v1.4.23 schema note). Round so re-sync doesn't flip values on
    // floating-point noise.
    const minutes = Math.round(durationSec / 60);

    const externalId = `withings:sleep:${userId}:${segment.id ?? "no-id"}:${segmentIndex}`;

    try {
      const existing = await prisma.measurement.findFirst({
        where: {
          userId,
          type: SLEEP_TYPE,
          measuredAt,
          source: "WITHINGS",
          sleepStage: stage,
        },
        select: { id: true },
      });
      if (existing) {
        await prisma.measurement.update({
          where: { id: existing.id },
          data: { value: minutes },
        });
      } else {
        await prisma.measurement.create({
          data: {
            userId,
            type: SLEEP_TYPE,
            value: minutes,
            unit: getUnitForType(SLEEP_TYPE),
            measuredAt,
            source: "WITHINGS",
            sleepStage: stage,
            externalId,
          },
        });
      }
      touched.push({ type: SLEEP_TYPE, measuredAt });
      imported++;
    } catch (err) {
      getEvent()?.addWarning(
        `Failed to upsert sleep segment (${stage}, ${measuredAt.toISOString()}): ${err}`,
      );
    }
    segmentIndex++;
  }

  // v1.4.39.1 — refresh the persistent rollup table for every distinct
  // (type, day) the sync touched. Sleep segments collapse heavily —
  // ~10 stage rows per night land in one DAY recompute.
  try {
    const keys = collapseToTypeDayKeys(touched);
    for (const k of keys) {
      await recomputeBucketsForMeasurement(userId, k.type, k.measuredAt);
    }
  } catch (err) {
    getEvent()?.addWarning(
      `withings sleep: rollup recompute failed for ${userId}: ${err}`,
    );
  }

  await recordSyncSuccess(userId, "withings");
  return imported;
}
