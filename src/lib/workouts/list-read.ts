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
import {
  canonicalWorkoutsInRange,
  readWorkoutsAroundRange,
  rowsInRange,
} from "@/lib/workouts/canonical-read";
import { cached, caches } from "@/lib/cache/server-cache";
import { workoutSportTypeEnum } from "@/lib/validations/workout";
import { isoDateTime } from "@/lib/validations/datetime";
import {
  readTrainingLoad,
  type TrainingLoad,
} from "@/lib/insights/training-load";

function emptyQueryValueToUndefined(value: unknown): unknown {
  if (value == null) return undefined;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

const normalizedTimestampFilter = z
  .preprocess(
    emptyQueryValueToUndefined,
    isoDateTime()
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
  metadata: unknown;
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
  /**
   * v1.44 — fitness, fatigue and form from the stored training impulse.
   * Account-wide (no filter applies) and on the first page only, so a client
   * paging through history does not recompute it per page.
   */
  trainingLoad?: TrainingLoad;
  /**
   * The sports the account has, most frequent first, over the whole deduped
   * history whatever the filter: the vocabulary of the sport filter, so
   * choosing one sport never empties the menu it was chosen from. First page
   * only.
   */
  sports?: Array<{ sportType: string; count: number }>;
  /** The sources the account's workouts come from, most frequent first. First page only. */
  sources?: string[];
}

/** Count a projection's rows by a key, most frequent first, ties by key. */
function countBy(
  rows: readonly CanonicalWorkoutRow[],
  keyOf: (row: CanonicalWorkoutRow) => string | null,
): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export async function buildWorkoutsProjection(
  userId: string,
  params: WorkoutFilterParams,
): Promise<WorkoutsProjection> {
  const { since, until, sportType } = params;

  const parse = (value: string | null): Date | null => {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const range = {
    from: parse(since),
    to: parse(until),
    inclusiveEnd: true,
  };

  // Independent reads — the sourcePriorityJson lookup doesn't depend on the
  // row read, so run them concurrently rather than paying two sequential
  // round trips. The rows come through the windowed reader: a twin just past
  // `until`, or a cluster that began just before `since`, decides which row
  // of the range is canonical exactly as it does for the detail route.
  const [userRow, around] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { sourcePriorityJson: true },
    }),
    readWorkoutsAroundRange(range, (bounds) =>
      prisma.workout.findMany({
        where: {
          userId,
          startedAt: bounds,
          ...(sportType ? { sportType } : {}),
        },
        orderBy: [{ startedAt: "asc" }, { id: "asc" }],
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
          metadata: true,
          createdAt: true,
          route: { select: { id: true } },
          samples: { select: { sampleCount: true } },
        },
      }),
    ),
  ]);

  const canonical: CanonicalWorkoutRow[] = canonicalWorkoutsInRange(
    around,
    userRow?.sourcePriorityJson ?? null,
  );
  const rawCount = rowsInRange(around).length;

  // The canonical pick comes back in `startedAt ASC` order (its
  // documented contract for the rollup callers). This surface is a
  // most-recent-first list, so the DB `orderBy startedAt desc` must be
  // re-established AFTER the pick — otherwise `offset`/`limit` slice the
  // OLDEST page and a user with a long history never sees recent workouts.
  canonical.sort((a, b) => {
    const delta = (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0);
    if (delta !== 0) return delta;
    return a.id.localeCompare(b.id);
  });

  return { canonical, rawCount };
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
  const projectionFor = (f: WorkoutFilterParams) =>
    cached(
      caches.workouts,
      `${userId}|${f.since ?? ""}|${f.until ?? ""}|${f.sportType ?? ""}`,
      () => buildWorkoutsProjection(userId, f),
      annotate,
    );

  const projection = await projectionFor(filters);

  const page = sliceWorkoutsProjection(projection, params.limit, params.offset);
  if (params.offset !== 0) return page;
  // The facets describe the whole history: an unfiltered request reuses its
  // own projection, a filtered one reads the unfiltered cell beside it.
  const unfiltered =
    filters.since === null &&
    filters.until === null &&
    filters.sportType === null
      ? projection
      : await projectionFor({ since: null, until: null, sportType: null });
  return {
    ...page,
    trainingLoad: await readTrainingLoad(userId),
    sports: countBy(unfiltered.canonical, (row) => row.sportType).map(
      ({ key, count }) => ({ sportType: key, count }),
    ),
    sources: countBy(unfiltered.canonical, (row) => row.source).map(
      ({ key }) => key,
    ),
  };
}
