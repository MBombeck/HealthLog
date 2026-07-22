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
 *   page N would be dropped on N-1 and surface again on N.
 *
 *   The canonical projection (the deduped, sorted row set) is cached
 *   keyed on the FILTER (`userId|since|until|sportType`) — deliberately
 *   WITHOUT `offset`/`limit` — so every page of a drain shares one cache
 *   entry: the first page's request builds it (one `findMany` + one
 *   dedup pass), every later page in the same TTL window slices the
 *   already-built array for free. Before this, each page carried its own
 *   cache key, so a full historical drain (the iOS app's "drain
 *   historical workouts" path, potentially thousands of rows on a
 *   10-year Apple Health import) re-ran the full read + dedup once per
 *   page — O(pages × rows) instead of O(rows).
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

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import {
  readWorkoutsListCached,
  workoutListFilterSchema,
} from "@/lib/workouts/list-read";
import { requireModuleEnabled } from "@/lib/modules/gate";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "workouts.list" } });

  // v1.18.0 B1 — the workouts surface is a toggleable module. A disabled
  // account must not be able to read the list even with a valid Bearer
  // token. The batch INGEST route stays ungated so synced data still
  // lands while the surface is hidden.
  const gate = await requireModuleEnabled(user.id, "workouts");
  if (!gate.enabled) return gate.response;

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
  const filterResult = workoutListFilterSchema.safeParse({
    since: searchParams.get("since"),
    until: searchParams.get("until"),
    sportType: searchParams.get("sportType"),
  });
  if (!filterResult.success) {
    return returnAllZodIssues(filterResult.error);
  }

  const result = await readWorkoutsListCached(user.id, {
    limit,
    offset,
    ...filterResult.data,
  });

  return apiSuccess(result);
});
