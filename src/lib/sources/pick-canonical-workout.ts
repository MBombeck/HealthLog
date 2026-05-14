/**
 * v1.4.25 W16a — cross-source workout canonical picker.
 *
 * Companion to `pickCanonicalSourceRows()` (the Measurement-row picker
 * in `src/lib/analytics/source-priority.ts`). Workouts have a similar
 * double-ingest problem coming in v1.5: the iOS app will write an
 * HKWorkout row at the same wall-clock time the Withings Activity API
 * already supplied — same run, two rows.
 *
 * This helper is scaffolding only — it returns the canonical workout
 * list, doesn't mutate the DB, and is not yet wired into any query
 * path. The wiring lands alongside the workout ingest endpoint
 * (W16b in the v1.4.25 plan) or with the v1.5 iOS rollout, whichever
 * arrives first.
 *
 * Algorithm
 * ─────────
 *
 *   1. Cluster workouts whose start timestamps land within
 *      `proximityMinutes` of each other (default 5 min — Apple's
 *      ScanWatch passthrough lag plus a small clock-skew buffer).
 *      Sport type must match across the cluster; a "Walking" workout
 *      and a "Running" workout starting at the same instant stay
 *      distinct rows so the cardio-vs-strength split stays clean.
 *   2. Per cluster, walk the per-user source-priority ladder for
 *      workouts (default `APPLE_HEALTH > WITHINGS > MANUAL > IMPORT`)
 *      and keep the first source that has a row in the cluster. All
 *      other rows from the same cluster are dropped from the
 *      canonical list.
 *   3. Single-element clusters (no near-duplicate) pass through
 *      unchanged regardless of source.
 *
 * Rationale for the default ladder
 * ────────────────────────────────
 *
 *   - `APPLE_HEALTH` first: the iOS-app passthrough carries the
 *     watch's per-second sample stream (energy, HR, optional GPS),
 *     so when both sources have the same workout it's the richer
 *     row.
 *   - `WITHINGS` second: ScanWatch syncs into Withings cloud too,
 *     but the API caps each workout at coarser aggregates (mean HR,
 *     totals, no per-sample HR series). Loses cleanly when paired
 *     with the HKWorkout twin.
 *   - `MANUAL` third: the user typed it; trust beats anything from
 *     `IMPORT` (CSV / XML) but loses to a sensor stream.
 *   - `IMPORT` last: bulk historical imports (Apple Health XML,
 *     Strava export, Garmin TCX) — useful when no live sensor source
 *     covers the period but the lowest fidelity when one does.
 *
 * The picker is deterministic on `(rows, ladder, proximityMinutes)`
 * and stable on input order. The caller is responsible for sorting
 * rows by `startedAt ASC, id ASC` before invocation so the picker's
 * cluster-building walks a fixed sequence.
 */

import type { MeasurementSource } from "@/generated/prisma/client";

import type { WorkoutSportType } from "@/lib/validations/workout";

/**
 * Minimum row shape the helper consults. Exposed as an interface so the
 * Prisma `Workout` model and the not-yet-existing ingest DTO both
 * compose with the picker without a transform step. Anything else on
 * the row (totals, HR aggregates, route blob, metadata) flows through
 * untouched — the picker filters but never mutates.
 */
export interface WorkoutPickerRow {
  /** Stable identifier — `id` for DB rows, externalId+source for
   *  not-yet-persisted ingest payloads. Used for deterministic
   *  tie-breaking when two sources both win the priority round. */
  id: string;
  startedAt: Date;
  source: MeasurementSource;
  /** Canonical sport string. Workouts of different sport types never
   *  collapse into one cluster — see step 1 of the algorithm. */
  sportType: WorkoutSportType | string;
}

/**
 * Per-user, per-source priority list for workouts. The shape is
 * parallel to `SOURCE_PRIORITY_METRIC_KEYS` entries but stored
 * separately because workouts are their own entity (not a Measurement
 * row), and the metric-priority Json blob on `User.sourcePriorityJson`
 * never carries a `workouts` key today.
 *
 * Persistence of the per-user value lands when the dedup wiring lands;
 * the helper accepts an explicit ladder so the future caller can pass
 * the merged value without dragging schema work into this file.
 */
export const DEFAULT_WORKOUT_SOURCE_PRIORITY: readonly MeasurementSource[] = [
  "APPLE_HEALTH",
  "WITHINGS",
  "MANUAL",
  "IMPORT",
] as const;

/**
 * Default proximity window. Apple's HealthKit passthrough is observed
 * to arrive 0–60 seconds after the watch closes the workout; Withings
 * Activity API rounds to the minute. 5 minutes covers both lags plus a
 * small clock-skew buffer between the iOS app's clock and the server.
 */
export const DEFAULT_WORKOUT_PROXIMITY_MINUTES = 5;

export interface PickCanonicalWorkoutOptions {
  /**
   * Per-user source ladder. Defaults to
   * `DEFAULT_WORKOUT_SOURCE_PRIORITY`. The picker walks left-to-right
   * and keeps the first source present in each cluster.
   */
  sourcePriority?: readonly MeasurementSource[];
  /**
   * Cluster window. Defaults to `DEFAULT_WORKOUT_PROXIMITY_MINUTES`.
   * Workouts whose start timestamps are within ±this many minutes of
   * an already-clustered workout join the same cluster; outside the
   * window they form a new cluster even with the same sport type.
   */
  proximityMinutes?: number;
}

/**
 * Pick the canonical-source workout list. See file-level docs for the
 * algorithm; returns a subset of the input plus a per-cluster pick
 * record useful for debug overlays / audit logging.
 */
export function pickCanonicalWorkout<T extends WorkoutPickerRow>(
  rows: readonly T[],
  options: PickCanonicalWorkoutOptions = {},
): {
  canonical: T[];
  /**
   * One entry per cluster. Useful when the caller wants to log
   * "we dropped a WITHINGS row in favour of an APPLE_HEALTH twin"
   * without re-running the picker.
   */
  clusters: Array<{
    members: T[];
    pickedSource: MeasurementSource;
    picked: T;
  }>;
} {
  if (rows.length === 0) {
    return { canonical: [], clusters: [] };
  }

  const ladder =
    options.sourcePriority ?? DEFAULT_WORKOUT_SOURCE_PRIORITY;
  const proximityMinutes =
    options.proximityMinutes ?? DEFAULT_WORKOUT_PROXIMITY_MINUTES;
  const proximityMs = proximityMinutes * 60_000;

  // Sort by startedAt so cluster building is a single linear pass.
  // Stable secondary sort on `id` keeps determinism on ties — two rows
  // recorded at the exact same instant with the same id ordering give
  // the same picker output on every call.
  const sorted = [...rows].sort((a, b) => {
    const dt = a.startedAt.getTime() - b.startedAt.getTime();
    if (dt !== 0) return dt;
    return a.id.localeCompare(b.id);
  });

  // Build clusters keyed by sport type (a Walking + Running pair
  // starting at the same instant must stay distinct — different
  // workouts entirely).
  const clusters: T[][] = [];
  for (const row of sorted) {
    // Find an existing cluster of the same sport type whose latest
    // member is within the proximity window. Walking from the most
    // recent cluster backward is O(k) per row where k is the open
    // cluster count; for the workout volume HealthLog ingests (single
    // user, tens of workouts per week) this is well below the
    // measurement bucket-map cost.
    let placed = false;
    for (let i = clusters.length - 1; i >= 0; i--) {
      const cluster = clusters[i];
      const head = cluster[0];
      if (head.sportType !== row.sportType) continue;
      const last = cluster[cluster.length - 1];
      if (row.startedAt.getTime() - last.startedAt.getTime() <= proximityMs) {
        cluster.push(row);
        placed = true;
        break;
      }
      // Sorted input + outside-window: every earlier cluster of the
      // same sport is even further away, no point continuing.
      if (head.sportType === row.sportType) break;
    }
    if (!placed) {
      clusters.push([row]);
    }
  }

  // Per-cluster: walk the ladder, keep the first source with a row.
  // Ties within a source are broken by the sorted-id order baked in
  // above.
  const canonical: T[] = [];
  const clusterRecords: Array<{
    members: T[];
    pickedSource: MeasurementSource;
    picked: T;
  }> = [];
  for (const cluster of clusters) {
    // Single-element fast path — no contention.
    if (cluster.length === 1) {
      const only = cluster[0];
      canonical.push(only);
      clusterRecords.push({
        members: cluster,
        pickedSource: only.source,
        picked: only,
      });
      continue;
    }

    let pickedSource: MeasurementSource | undefined;
    for (const candidate of ladder) {
      if (cluster.some((row) => row.source === candidate)) {
        pickedSource = candidate;
        break;
      }
    }
    // Fallback: none of the ladder entries appear in the cluster
    // (impossible with the current four-member enum + four-member
    // default ladder, but the helper accepts a custom ladder). Keep
    // every row so the picker never silently drops data.
    if (!pickedSource) {
      canonical.push(...cluster);
      clusterRecords.push({
        members: cluster,
        pickedSource: cluster[0].source,
        picked: cluster[0],
      });
      continue;
    }
    const winning = cluster.find((row) => row.source === pickedSource)!;
    canonical.push(winning);
    clusterRecords.push({
      members: cluster,
      pickedSource,
      picked: winning,
    });
  }

  return { canonical, clusters: clusterRecords };
}
