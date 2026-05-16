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
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { pickCanonicalWorkoutRows } from "@/lib/measurements/pick-canonical-workout-rows";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    annotate({ action: { name: "workouts.detail" }, meta: { workoutId: id } });

    const row = await prisma.workout.findUnique({
      where: { id },
      include: {
        route: {
          select: {
            id: true,
            geometry: true,
            sampleTimestamps: true,
            createdAt: true,
          },
        },
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
      },
    });

    const userRow = await prisma.user.findUnique({
      where: { id: user.id },
      select: { sourcePriorityJson: true },
    });
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

    const route = row.route
      ? {
          geometry: row.route.geometry,
          sampleTimestamps: row.route.sampleTimestamps ?? null,
        }
      : null;

    return apiSuccess({
      id: row.id,
      sportType: row.sportType,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationSec: row.durationSec,
      distanceM: row.totalDistanceM,
      activeEnergyKcal: row.totalEnergyKcal,
      avgHr: row.avgHeartRate,
      maxHr: row.maxHeartRate,
      minHr: row.minHeartRate,
      stepCount: row.stepCount,
      elevationM: row.elevationM,
      pauseDurationSec: row.pauseDurationSec,
      source: row.source,
      externalId: row.externalId,
      metadata: row.metadata,
      route,
      // v1.4.32 — when the requested id is a non-canonical twin the
      // caller can redirect to `canonicalId` to land on the cluster
      // winner. `canonicalId === id` when the requested row already
      // is the winner.
      canonicalId: canonical?.id ?? row.id,
    });
  },
);
