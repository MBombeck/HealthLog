/**
 * `GET /api/workouts` — paginated workout list with cross-source
 * canonical-row dedup.
 *
 * Consumers (v1.4.32+):
 *   1. The `/insights/workouts` web surface reads from this endpoint so
 *      duplicate twin workouts (Apple Watch writing a workout that
 *      Withings also published over its server-to-server feed) collapse
 *      to a single canonical row per cluster.
 *   2. The native iOS app drains historical workouts through the same
 *      surface — Apple Health is the canonical ladder anchor, so an
 *      iOS-originated request typically returns its own rows back.
 *
 * Dedup contract:
 *   - The route runs `pickCanonicalWorkoutRows()` from v1.4.30 over the
 *     filtered row set. The picker reads the per-user
 *     `User.sourcePriorityJson` blob (falling back to
 *     `APPLE_HEALTH ≻ WITHINGS ≻ MANUAL ≻ IMPORT`) and buckets by
 *     `(startedAt slot-of-5-min, sportType)`. The highest-priority
 *     source's rows win each bucket; the rest are dropped.
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
 *   full filtered set per request is well within budget.
 *
 * Response shape (iOS contract):
 *   - `workouts: WorkoutListEntry[]` — each entry exposes
 *     `id, sportType, startedAt, endedAt, durationSec, distanceM,
 *     activeEnergyKcal, avgHr, maxHr, source, externalId`. Stable across
 *     iOS / web consumers.
 *   - `meta: { total, limit, offset, droppedDuplicates }`.
 *
 * v1.4.32 — swap the cluster-based dedup helper (v1.4.27 B7) for the
 * source-priority-aware `pickCanonicalWorkoutRows()` helper (v1.4.30)
 * so the per-user source ladder governs the canonical pick. Response
 * field names match the iOS handoff contract.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { pickCanonicalWorkoutRows } from "@/lib/measurements/pick-canonical-workout-rows";

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

  // Read the full filtered set, descending start. The picker requires
  // deterministic input order; the `(startedAt, id)` secondary sort
  // pins the tie-break for rows that share a millisecond stamp.
  const rows = await prisma.workout.findMany({
    where,
    orderBy: [{ startedAt: "desc" }, { id: "asc" }],
    select: {
      id: true,
      source: true,
      externalId: true,
      sportType: true,
      startedAt: true,
      endedAt: true,
      durationSec: true,
      totalDistanceM: true,
      totalEnergyKcal: true,
      avgHeartRate: true,
      maxHeartRate: true,
      createdAt: true,
    },
  });

  // Pass the user's source-priority blob so the picker honours the
  // per-user ladder. The picker preserves input order on the returned
  // subset; descending-start input → descending-start output.
  const userRow = await prisma.user.findUnique({
    where: { id: user.id },
    select: { sourcePriorityJson: true },
  });
  const canonical = pickCanonicalWorkoutRows(
    rows,
    userRow?.sourcePriorityJson ?? null,
  );

  const page = canonical.slice(offset, offset + limit).map((row) => ({
    id: row.id,
    sportType: row.sportType,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationSec: row.durationSec,
    distanceM: row.totalDistanceM,
    activeEnergyKcal: row.totalEnergyKcal,
    avgHr: row.avgHeartRate,
    maxHr: row.maxHeartRate,
    source: row.source,
    externalId: row.externalId,
  }));

  return apiSuccess({
    workouts: page,
    meta: {
      total: canonical.length,
      limit,
      offset,
      droppedDuplicates: rows.length - canonical.length,
    },
  });
});
