/**
 * Shared cached workouts-list read for the two entry points:
 *
 *   - `GET /api/workouts` (the client cell's endpoint), and
 *   - the workouts RSC wrapper (`src/app/insights/workouts/page.tsx`), which
 *     server-prefetches the same payload into a dehydrated TanStack cache so
 *     the first HTML paints the workout rows instead of a skeleton-until-JS
 *     flash (the "Sport lädt langsam" report).
 *
 * Both read through the SAME `caches.workouts` projection cell (keyed on the
 * FILTER `userId|since|until|sportType`, deliberately WITHOUT `offset`/`limit`
 * so every page of one filter shares one deduped projection), so an RSC
 * prefetch warms the API path and vice versa — the dedup pass never runs twice
 * for one filter within the 60 s TTL. Mirrors `src/lib/medications/list-read.ts`
 * and `src/lib/dashboard/snapshot-read.ts`.
 */
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { pickCanonicalWorkoutRows } from "@/lib/measurements/pick-canonical-workout-rows";
import { cached, caches } from "@/lib/cache/server-cache";
import { workoutSportTypeEnum } from "@/lib/validations/workout";

function emptyQueryValueToUndefined(value: unknown): unknown {
  if (value == null) return undefined;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

const normalizedTimestampFilter = z
  .preprocess(
    emptyQueryValueToUndefined,
    z.iso
      .datetime({ offset: true })
      .transform((value) => new Date(value).toISOString())
      .optional(),
  )
  .transform((value) => value ?? null);

const normalizedSportTypeFilter = z
  .preprocess(emptyQueryValueToUndefined, workoutSportTypeEnum.optional())
  .transform((value) => value ?? null);

export const workoutListFilterSchema = z
  .object({
    since: normalizedTimestampFilter,
    until: normalizedTimestampFilter,
    sportType: normalizedSportTypeFilter,
  })
  .superRefine((filters, ctx) => {
    if (
      filters.since !== null &&
      filters.until !== null &&
      filters.since > filters.until
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["until"],
        message: "until must be at or after since",
      });
    }
  });

export type WorkoutFilterParams = z.infer<typeof workoutListFilterSchema>;

interface CanonicalWorkoutRow {
  id: string;
  source: string;
  externalId: string | null;
  sportType: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  durationSec: number | null;
  totalDistanceM: number | null;
  totalEnergyKcal: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  createdAt: Date;
  // #67 list glyphs — cheap relation-id selects so the list can flag
  // which sessions open into a rich detail (map / HR curve).
  route: { id: string } | null;
  samples: { sampleCount: number } | null;
}

/** The cached, deduped, most-recent-first row set for one filter combination. */
export interface WorkoutsProjection {
  canonical: CanonicalWorkoutRow[];
  rawCount: number;
}

export interface WorkoutsResult {
  workouts: Array<{
    id: string;
    sportType: string | null;
    startedAt: Date | null;
    endedAt: Date | null;
    durationSec: number | null;
    distanceM: number | null;
    activeEnergyKcal: number | null;
    avgHr: number | null;
    maxHr: number | null;
    source: string;
    externalId: string | null;
    hasRoute: boolean;
    hasHrSeries: boolean;
  }>;
  meta: {
    total: number;
    limit: number;
    offset: number;
    droppedDuplicates: number;
  };
}

export async function buildWorkoutsProjection(
  userId: string,
  params: WorkoutFilterParams,
): Promise<WorkoutsProjection> {
  const { since, until, sportType } = params;

  const where: Record<string, unknown> = { userId };
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

  // Independent reads — the sourcePriorityJson lookup doesn't depend on the
  // row read, so run them concurrently rather than paying two sequential
  // round trips.
  const [rows, userRow] = await Promise.all([
    prisma.workout.findMany({
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
        route: { select: { id: true } },
        samples: { select: { sampleCount: true } },
      },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { sourcePriorityJson: true },
    }),
  ]);

  const canonical = pickCanonicalWorkoutRows(
    rows,
    userRow?.sourcePriorityJson ?? null,
  );

  // `pickCanonicalWorkoutRows` re-sorts its output to `startedAt ASC` (its
  // documented contract for the rollup callers). This surface is a
  // most-recent-first list, so the DB `orderBy startedAt desc` must be
  // re-established AFTER the pick — otherwise `offset`/`limit` slice the
  // OLDEST page and a user with a long history never sees recent workouts.
  canonical.sort((a, b) => {
    const delta = (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0);
    if (delta !== 0) return delta;
    return a.id.localeCompare(b.id);
  });

  return { canonical, rawCount: rows.length };
}

export function sliceWorkoutsProjection(
  projection: WorkoutsProjection,
  limit: number,
  offset: number,
): WorkoutsResult {
  const page = projection.canonical
    .slice(offset, offset + limit)
    .map((row) => ({
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
      hasRoute: row.route != null,
      hasHrSeries: row.samples != null && row.samples.sampleCount > 0,
    }));

  return {
    workouts: page,
    meta: {
      total: projection.canonical.length,
      limit,
      offset,
      droppedDuplicates: projection.rawCount - projection.canonical.length,
    },
  };
}

/**
 * Cached read for one page of the deduped workouts list. The projection cell
 * is shared with the API route; the slice is per-request. Both callers hand
 * the same filter, so a route call and an RSC prefetch collapse to one dedup
 * pass within the TTL.
 */
export async function readWorkoutsListCached(
  userId: string,
  params: {
    limit: number;
    offset: number;
    since: string | null;
    until: string | null;
    sportType: string | null;
  },
): Promise<WorkoutsResult> {
  const filters = workoutListFilterSchema.parse({
    since: params.since,
    until: params.until,
    sportType: params.sportType,
  });

  // Deliberately excludes `limit`/`offset` — every page of one normalized
  // filter combination shares this cached projection.
  const projectionKey = `${userId}|${filters.since ?? ""}|${filters.until ?? ""}|${filters.sportType ?? ""}`;

  const projection = await cached(
    caches.workouts,
    projectionKey,
    () => buildWorkoutsProjection(userId, filters),
    annotate,
  );

  return sliceWorkoutsProjection(projection, params.limit, params.offset);
}
