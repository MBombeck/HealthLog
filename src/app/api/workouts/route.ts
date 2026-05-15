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
 * v1.4.27 B7 / BL-P2-3 — wires `pickCanonicalWorkout()` into the read
 * path so the workout dedup contract finally has a consumer. The
 * picker stays a pure function — the route owns the query window and
 * the response shaping.
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
// The picker can collapse heavy two-source ingest by ~50%; fetching a
// 2× window ahead of pagination keeps the page full without leaving
// the server fetching unbounded.
const FETCH_MULTIPLIER = 2;

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

  const rawTake = Math.min(
    limit * FETCH_MULTIPLIER,
    MAX_LIMIT * FETCH_MULTIPLIER,
  );

  const rows = await prisma.workout.findMany({
    where,
    orderBy: { startedAt: "desc" },
    take: rawTake,
    skip: offset,
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

  const page = canonical.slice(0, limit);

  return apiSuccess({
    workouts: page,
    meta: {
      total: canonical.length,
      limit,
      offset,
      droppedDuplicates: rows.length - canonical.length,
      clusters: clusters.length,
    },
  });
});
