/**
 * `GET /api/workouts/{id}` — single-workout detail.
 *
 * v1.4.32 — paired with `GET /api/workouts` so the iOS workout-detail
 * screen + the new `/insights/workouts/[id]` web page consume one
 * canonical envelope per workout. The endpoint:
 *
 *   - Returns the canonical row when the requested id wins its
 *     `(startedAt slot, sportType)` cluster against the user's
 *     source-priority ladder. The picker reuses
 *     `pickCanonicalWorkoutRows()` from v1.4.30 so the dedup contract
 *     stays in sync with the list endpoint.
 *   - When the requested id is a non-canonical twin (e.g. the user
 *     opened a deep-link to a Withings row but the cluster's winner is
 *     Apple Health), the response still resolves the requested row
 *     directly and exposes `canonicalId` pointing at the cluster
 *     winner. The web detail page can redirect via that field; the iOS
 *     client may surface it inline.
 *   - Loads the optional `WorkoutRoute` GeoJSON LineString when
 *     present. Absent for Withings-sourced workouts (Withings ships no
 *     route geometry); absent for manual entries.
 *   - Ownership-gated: a row owned by another user resolves as 404 so
 *     the existence channel never leaks.
 *
 * `DELETE /api/workouts/{id}` removes a workout entered by hand. Only a
 * `MANUAL` row: a synced workout would come back with the next sync, so
 * deleting it here would be a promise the record cannot keep. See the
 * handler below.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { enqueuePrDetection } from "@/lib/jobs/pr-detection";
import {
  lockPersonalRecordsForUser,
  workoutPrSlotsForSport,
} from "@/lib/personal-records/pr-detection-worker";
import { pickCanonicalWorkoutRows } from "@/lib/measurements/pick-canonical-workout-rows";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { aiCapabilityToServe } from "@/lib/ai/capabilities/gate";
import { getAgeFromDateOfBirth } from "@/lib/analytics/pulse-targets";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { buildWorkoutHrSeries } from "@/lib/workouts/hr-series";
import {
  computeZones,
  hrMaxFromAge,
  parseWhoopZoneDurations,
} from "@/lib/workouts/zones";
import { computeSplits } from "@/lib/workouts/splits";
import { buildSportContext } from "@/lib/workouts/sport-context";
import type { RouteCoordinate } from "@/lib/workouts/route-svg";
import { readRouteGeometry } from "@/lib/workouts/route-geometry-cipher";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { userDayKey } from "@/lib/tz/format";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;
    // Web always sends `compact=1` to drop the raw 30k-sample / route
    // timestamp blobs. Absent the param the response is byte-identical to
    // the v1.4.32 contract → iOS is untouched, no coordination ticket.
    const compact = request.nextUrl.searchParams.get("compact") === "1";

    annotate({ action: { name: "workouts.detail" }, meta: { workoutId: id } });

    // v1.18.0 B1 — gate the detail surface behind the workouts module.
    const gate = await requireModuleEnabled(user.id, "workouts");
    if (!gate.enabled) return gate.response;
    // The stored Activity Insight paragraph is model text: it is read and
    // served only while `workoutInsights` is available (operator switch, the
    // AI analysis opt-out, provider presence, consent). Otherwise the row is
    // not even loaded, `aiInsight` is null, and `ai` says why.
    const ai = await aiCapabilityToServe(user.id, "workoutInsights");

    const row = await prisma.workout.findUnique({
      where: { id },
      include: {
        route: {
          select: {
            id: true,
            geometry: true,
            geometryEncrypted: true,
            sampleTimestamps: true,
            createdAt: true,
          },
        },
        samples: {
          select: {
            samples: true,
            sampleCount: true,
          },
        },
        insight: ai.available
          ? {
              select: { paragraphEncrypted: true, generatedAt: true },
            }
          : false,
      },
    });

    // Cross-user 404 guard. The user can only fetch rows they own; any
    // other id surfaces as "not found" so the existence channel stays
    // sealed.
    if (!row || row.userId !== user.id) {
      return apiError("Workout not found", 404);
    }

    // Resolve the canonical winner for the row's cluster. The picker
    // reads every workout in the same 5-minute slot and sport-type
    // bucket; in practice that's ≤ 4 rows (Apple + Withings + the two
    // legacy sources). The query is bounded so the round-trip is cheap.
    const slotMs = 5 * 60 * 1000;
    const slotStart = new Date(
      Math.floor(row.startedAt.getTime() / slotMs) * slotMs,
    );
    const slotEnd = new Date(slotStart.getTime() + slotMs);

    const clusterRows = await prisma.workout.findMany({
      where: {
        userId: user.id,
        sportType: row.sportType,
        startedAt: { gte: slotStart, lt: slotEnd },
      },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        source: true,
        startedAt: true,
        sportType: true,
        // Part of the canonical session identity consulted by
        // `pickCanonicalWorkoutRows` below — without it a HealthKit re-send of
        // this very workout stays in the cluster and the deep link can resolve
        // to the duplicate instead of the row the list shows.
        durationSec: true,
        avgHeartRate: true,
        maxHeartRate: true,
        metadata: true,
      },
    });

    const userRow = await prisma.user.findUnique({
      where: { id: user.id },
      select: { sourcePriorityJson: true, dateOfBirth: true },
    });
    // The local calendar day this session belongs to. Resolved here, in the
    // user's timezone, so the day linkage stays server-authoritative — a
    // client that derived it from `startedAt` would fall back to the browser
    // zone and put a late-evening session on the wrong day whenever the two
    // disagree.
    const timezone = await resolveUserTimezone(user.id);
    const dayKey = userDayKey(row.startedAt, timezone);

    const canonicalCluster = pickCanonicalWorkoutRows(
      clusterRows,
      userRow?.sourcePriorityJson ?? null,
    );
    // The canonical pick may carry multiple rows (same winning source);
    // pick the closest in time to the requested row so deep-link
    // redirects land on the most similar twin.
    const canonical =
      canonicalCluster.find((c) => c.id === row.id) ??
      canonicalCluster[0] ??
      null;
    const effectiveAvgHeartRate = canonical?.avgHeartRate ?? row.avgHeartRate;
    const effectiveMaxHeartRate = canonical?.maxHeartRate ?? row.maxHeartRate;

    // ── Enrichment reads (all over existing tables — no migration) ────

    // Heart-rate curve: stored series first, pulse-window fallback
    // second, hide third. One server path, one DTO with provenance.
    const hrSeries = await buildWorkoutHrSeries({
      userId: user.id,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationSec: row.durationSec,
      storedSamples: row.samples?.samples ?? null,
    });
    annotate({
      action: { name: "workouts.detail.hr_series" },
      meta: {
        source: hrSeries?.source ?? "none",
        points: hrSeries?.points.length ?? 0,
      },
    });

    // Effort zones: WHOOP device durations win; else %HRmax fold from
    // the series when profile age exists; else null.
    const ageYears = getAgeFromDateOfBirth(userRow?.dateOfBirth ?? null);
    const zones = computeZones({
      hrMax: hrMaxFromAge(ageYears),
      series: hrSeries?.points ?? [],
      bucketSec: hrSeries?.bucketSec ?? 0,
      whoopZoneDurations: parseWhoopZoneDurations(
        canonical?.metadata ?? row.metadata,
      ),
    });

    // Per-km splits computed server-side from the geometry + timestamps
    // so the web client keeps dropping the raw timestamp blob under
    // `compact=1` while still rendering splits (server-authoritative
    // parity — iOS gets the same resolved figures).
    // v1.39.4 — the track is stored sealed; the legacy readable column is
    // read only for a row the backfill has not reached yet.
    const routeGeometry = row.route ? readRouteGeometry(row.route) : null;
    const geometryCoords =
      routeGeometry &&
      typeof routeGeometry === "object" &&
      Array.isArray((routeGeometry as { coordinates?: unknown }).coordinates)
        ? (routeGeometry as { coordinates: RouteCoordinate[] }).coordinates
        : null;
    const splits =
      geometryCoords && Array.isArray(row.route?.sampleTimestamps)
        ? computeSplits(geometryCoords, row.route.sampleTimestamps as string[])
        : null;

    // Sport context: the user's own last-180-days average for this
    // sport, cross-source-collapsed so twins don't double-count.
    const sportContext = await buildSportContext(
      user.id,
      row.sportType,
      userRow?.sourcePriorityJson ?? null,
      row.id,
    );

    // The session before this one in the same sport. "How does this compare
    // to last time?" is the most likely next question after reading a
    // workout, and today it costs a trip back to the list plus a scan.
    // Scoped to rows that start before this cluster's slot, so a twin of THIS
    // session can never be offered as the previous one, and run through the
    // same canonical picker so the link lands on the row the list shows.
    const previousRows = await prisma.workout.findMany({
      where: {
        userId: user.id,
        sportType: row.sportType,
        startedAt: { lt: slotStart },
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      // Enough to survive a run of same-session twins and re-sends without
      // reading the whole history; the picker collapses them to a handful.
      take: 20,
      select: {
        id: true,
        source: true,
        startedAt: true,
        sportType: true,
        durationSec: true,
        avgHeartRate: true,
        maxHeartRate: true,
        metadata: true,
      },
    });
    // The picker takes rows in ascending order and does not promise to hand
    // them back sorted, so pick the newest survivor explicitly.
    const previousWorkoutId =
      pickCanonicalWorkoutRows(
        [...previousRows].reverse(),
        userRow?.sourcePriorityJson ?? null,
      ).reduce<{ id: string; startedAt: Date } | null>(
        (newest, candidate) =>
          newest === null || candidate.startedAt > newest.startedAt
            ? candidate
            : newest,
        null,
      )?.id ?? null;

    // A route whose track cannot be read (a sealed value that no longer
    // opens, or an old row stored as a JSON null) is reported as no route at
    // all: clients decode `route.geometry` as required, so a route object
    // with a null geometry would fail the whole workout detail for them.
    const route =
      row.route && routeGeometry
        ? {
            geometry: routeGeometry,
            // `compact=1` drops the (up to 20k-entry) timestamp array; the
            // SVG needs geometry, not the per-sample timestamps, and the
            // splits above are already derived from them server-side.
            sampleTimestamps: compact
              ? null
              : (row.route.sampleTimestamps ?? null),
          }
        : null;

    // v1.10.0 — route-independent per-workout HR series. Present for
    // both indoor (no route) and outdoor workouts that shipped a
    // `samples` array on ingest; null otherwise. `compact=1` keeps the
    // denormalised count but drops the raw sample blob (the web curve
    // reads `hrSeries` instead).
    const samples = row.samples
      ? {
          sampleCount: row.samples.sampleCount,
          samples: compact ? null : row.samples.samples,
        }
      : null;

    // Decrypt the stored paragraph. Fail-SOFT here and only here: `decrypt` is
    // fail-closed by design, so a rotated-away key would otherwise turn the
    // whole workout-detail page into a 500 over a garnish field. An
    // undecryptable paragraph degrades to no card, exactly like a workout that
    // never had one.
    let aiInsight: { paragraph: string; generatedAt: string } | null = null;
    if (ai.available && row.insight) {
      try {
        aiInsight = {
          paragraph: decryptFromBytes(row.insight.paragraphEncrypted),
          generatedAt: row.insight.generatedAt.toISOString(),
        };
      } catch {
        annotate({
          action: { name: "workouts.detail.insight_undecryptable" },
          meta: { workoutId: row.id },
        });
      }
    }

    return apiSuccess({
      id: row.id,
      sportType: row.sportType,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      // `YYYY-MM-DD` in the user's timezone. Additive; it addresses the
      // day-scoped reads (intraday pulse, that night's sleep, the day's
      // mood) the detail surface renders around the session.
      dayKey,
      durationSec: row.durationSec,
      distanceM: row.totalDistanceM,
      activeEnergyKcal: row.totalEnergyKcal,
      avgHr: effectiveAvgHeartRate,
      maxHr: effectiveMaxHeartRate,
      minHr: row.minHeartRate,
      // The row's own heart rate. `avgHr` / `maxHr` above may be filled in
      // from a twin by the canonical picker, which is right for display and
      // wrong for an edit: re-posting them would store the twin's values on
      // the hand-entered row (#1162).
      storedAvgHr: row.avgHeartRate,
      storedMaxHr: row.maxHeartRate,
      stepCount: row.stepCount,
      elevationM: row.elevationM,
      pauseDurationSec: row.pauseDurationSec,
      source: row.source,
      externalId: row.externalId,
      metadata: row.metadata,
      route,
      samples,
      // #67 enrichment — all additive, all over existing tables.
      hrSeries,
      zones,
      splits,
      sportContext,
      // The per-workout Activity Insight. A pure READ of a row the
      // `workout-insight-generate` worker wrote when this workout landed —
      // this route never generates, never enqueues, and never falls back to
      // a provider. A workout with no row (every historical one, every
      // re-synced one, every one on a provider-less install) serves null and
      // the page's `{aiInsight ? <card/> : null}` renders nothing.
      aiInsight,
      // Whether the Activity Insight can be shown, and why not.
      ai,
      // v1.4.32 — when the requested id is a non-canonical twin the
      // caller can redirect to `canonicalId` to land on the cluster
      // winner. `canonicalId === id` when the requested row already
      // is the winner.
      canonicalId: canonical?.id ?? row.id,
      // The canonical previous session in this sport, or null when this is
      // the first one on record. Additive; a client that does not read it is
      // unaffected.
      previousWorkoutId,
    });
  },
);

/**
 * `DELETE /api/workouts/{id}` — remove a workout that was entered by hand.
 *
 * - Own record only: `requireAuth()` with no scope admits a cookie session or
 *   a wildcard token and refuses an acting-account carrier, the same arm the
 *   detail read above uses. A narrow token is refused.
 * - Ownership: another user's row answers 404, like the read.
 * - `MANUAL` only. Every other source is a sync, and the next sync would
 *   write the row back, so it answers 409 instead of pretending.
 * - Not module-gated: deleting is cleanup of the person's own rows, which
 *   the data layer allows whatever the module says
 *   (`module-route-gate-inventory.test.ts`).
 *
 * The workout table carries no tombstone, so the row is removed outright;
 * route, samples and insight rows cascade with it. The insight's generation
 * claim stays behind with a null workout id: it is the day's cap ledger, and
 * a delete must not hand the slot back. A personal record
 * the workout set would otherwise outlive it (the detector only ever raises
 * a stored best), so the records keyed on this workout go in the same
 * transaction and a silent detection pass re-derives the honest best.
 */
export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const row = await prisma.workout.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        source: true,
        externalId: true,
        startedAt: true,
        sportType: true,
      },
    });
    if (!row || row.userId !== user.id) {
      return apiError("Workout not found", 404);
    }
    if (row.source !== "MANUAL") {
      annotate({
        action: {
          name: "workout.delete",
          entity_type: "workout",
          entity_id: id,
        },
        meta: { outcome: "synced_source", source: row.source },
      });
      return apiError(
        "Only a workout entered by hand can be deleted here",
        409,
        { errorCode: "workout.delete.synced_source" },
      );
    }

    const removedRecords = await prisma.$transaction(async (tx) => {
      // The detector reads the best workout and writes its record under this
      // same lock, so it either wrote before this delete (and the record goes
      // below) or reads after it (and never sees the workout).
      await lockPersonalRecordsForUser(tx, user.id);
      const records = await tx.personalRecord.deleteMany({
        where: {
          userId: user.id,
          source: "MANUAL",
          ...(row.externalId !== null
            ? { metricSlot: { not: null }, externalId: row.externalId }
            : {
                // A legacy record carries no external id, so the start time
                // is all that ties it to this workout. Scope it to the slots
                // of this workout's sport so a record another sport set at
                // the same instant stays.
                metricSlot: { in: workoutPrSlotsForSport(row.sportType) },
                externalId: null,
                achievedAt: row.startedAt,
              }),
        },
      });
      await tx.workout.delete({ where: { id: row.id } });
      return records.count;
    });

    await auditLog("workout.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        workoutId: id,
        sportType: row.sportType,
        personalRecordsRemoved: removedRecords,
      },
    });
    annotate({
      action: { name: "workout.delete", entity_type: "workout", entity_id: id },
      meta: { outcome: "deleted", personalRecordsRemoved: removedRecords },
    });

    invalidateUserMeasurements(user.id, { evict: true });

    if (removedRecords > 0) {
      try {
        await enqueuePrDetection(user.id, { silent: true });
      } catch (err) {
        annotate({
          action: { name: "personal_records.detection_enqueue_failed" },
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    return apiSuccess({ deleted: true });
  },
);
