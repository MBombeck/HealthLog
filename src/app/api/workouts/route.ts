/**
 * `GET /api/workouts` — paginated workout list with canonical-source
 * deduplication.
 *
 * Consumers (v1.4.27+):
 *   1. The /insights workouts surface (and future /workouts page) reads
 *      from this endpoint so duplicate twin workouts (Apple Watch
 *      writing a workout that Withings also published over its server-
 *      to-server feed) collapse to a single canonical row.
 *   2. The native iOS app drains historical workouts through the same
 *      surface — Apple Health is the canonical ladder anchor, so an
 *      iOS-originated request typically returns its own rows back.
 *
 * Dedup contract:
 *   - The route reads `DEFAULT_WORKOUT_SOURCE_PRIORITY` from
 *     `pick-canonical-workout.ts` (APPLE_HEALTH > WITHINGS > MANUAL >
 *     IMPORT) with the ±5 min cluster window. A per-user workout
 *     ladder override is reserved for the v1.5 Settings surface; the
 *     server already honours it transparently through the picker's
 *     options bag when the field lands in `User.sourcePriorityJson`.
 *   - Per-cluster the picker keeps the row from the highest-priority
 *     source present; the others are dropped from the canonical list.
 *
 * Query params:
 *   - `limit` (default 50, max 200)
 *   - `offset` (default 0)
 *   - `since` / `until` — ISO timestamps, inclusive. Optional.
 *   - `sportType` — narrow to one HKWorkoutActivityType. Optional.
 *
 * Pagination contract:
 *   Dedup runs over the full filtered row set, then `offset` / `limit`
 *   slice the canonical projection. A naive `skip` + per-window dedup
 *   double-counts boundary clusters across pages because a cluster
 *   whose first member sits in page N-1 and whose later member sits in
 *   page N would be dropped on N-1 and surface again on N. Workout
 *   volume for HealthLog is bounded (single user, tens of workouts per
 *   week — single-digit MB at the table's busiest), so reading the
 *   full filtered set per request is well within budget. If the
 *   workload ever grows to where this matters, a `(startedAt, id)`
 *   cursor with a deterministic over-fetch window is the next step.
 *
 * v1.4.27 B7 / BL-P2-3 — wires `pickCanonicalWorkout()` into the read
 * path. v1.4.27 R4 RC3 — corrects the pagination so `meta.total`
 * reflects the deduped count and cluster boundaries no longer leak
 * across pages.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import {
  pickCanonicalWorkout,
  DEFAULT_WORKOUT_SOURCE_PRIORITY,
  DEFAULT_WORKOUT_PROXIMITY_MINUTES,
  type WorkoutPickerRow,
} from "@/lib/sources/pick-canonical-workout";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "workouts.list" } });

  const { searchParams } = new URL(request.url);
  const limit = Math.min(
    Math.max(
      1,
      parseInt(searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10) ||
        DEFAULT_LIMIT,
    ),
    MAX_LIMIT,
  );
  const offset = Math.max(
    0,
    parseInt(searchParams.get("offset") ?? "0", 10) || 0,
  );
  const since = searchParams.get("since");
  const until = searchParams.get("until");
  const sportType = searchParams.get("sportType");

  const where: Record<string, unknown> = { userId: user.id };
  if (since || until) {
    const range: Record<string, Date> = {};
    if (since) {
      const d = new Date(since);
      if (!Number.isNaN(d.getTime())) range.gte = d;
    }
    if (until) {
      const d = new Date(until);
      if (!Number.isNaN(d.getTime())) range.lte = d;
    }
    if (Object.keys(range).length > 0) {
      where.startedAt = range;
    }
  }
  if (sportType) {
    where.sportType = sportType;
  }

  // Read the full filtered set then dedupe once. See the file-level
  // "Pagination contract" note for the reason this is preferred over
  // a per-page over-fetch + slice. The picker is O(n) on cluster
  // building plus O(k) per cluster (k = open clusters of the same
  // sport type) and the workout table is bounded.
  const rows = await prisma.workout.findMany({
    where,
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      source: true,
      externalId: true,
      sportType: true,
      startedAt: true,
      endedAt: true,
      durationSec: true,
      distanceMeters: true,
      avgHeartRate: true,
      maxHeartRate: true,
      energyKcal: true,
      createdAt: true,
    },
  });

  // The picker only inspects `source`, `startedAt`, `sportType`, and
  // `id`. The rest of the selected columns ride through untouched on
  // the returned subset.
  const pickerRows = rows as Array<(typeof rows)[number] & WorkoutPickerRow>;
  const { canonical, clusters } = pickCanonicalWorkout(pickerRows, {
    sourcePriority: DEFAULT_WORKOUT_SOURCE_PRIORITY,
    proximityMinutes: DEFAULT_WORKOUT_PROXIMITY_MINUTES,
  });

  // The picker sorts ascending for deterministic cluster building.
  // Restore descending order on the canonical projection so the API
  // matches the orderBy contract above.
  const canonicalDesc = [...canonical].sort(
    (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
  );

  const page = canonicalDesc.slice(offset, offset + limit);

  return apiSuccess({
    workouts: page,
    meta: {
      total: canonicalDesc.length,
      limit,
      offset,
      droppedDuplicates: rows.length - canonicalDesc.length,
      clusters: clusters.length,
    },
  });
});
