/**
 * v1.4.30 — cross-source canonical-row picker for `Workout` rows.
 *
 * Same intent as `pickCanonicalSourceRows()` in
 * `src/lib/analytics/source-priority.ts`, applied to workouts. A user
 * wearing an Apple Watch + a Withings ScanWatch records the same run
 * once via each integration; the dashboard "Recent workouts" tile
 * would otherwise show the run twice.
 *
 * Algorithm (v1.4.30 — matches the measurement ladder per R-F open
 * question #4):
 *   1. Bucket workouts by the rounded start timestamp + sport-type
 *      (`<5-minute slot>:<sport>`). Two HKWorkout entries for the same
 *      logical run start within a minute of each other on both
 *      sources; the rounding gives the cross-source matcher slack
 *      without collapsing distinct back-to-back workouts.
 *   2. For each bucket, walk the SOURCE priority ladder
 *      (`APPLE_HEALTH ≻ WITHINGS ≻ MANUAL ≻ IMPORT` per the existing
 *      source-priority validator's default) and pick the FIRST
 *      source that has any row in that bucket. Keep every row from
 *      the winning source; drop the rest.
 *   3. Rows whose source isn't in the ladder pass through untouched
 *      (fallback intent — never silently drop signal).
 *
 * Determinism precondition: input rows MUST be in deterministic order
 * (typically `ORDER BY startedAt ASC, id ASC` from the caller's
 * Prisma read). The output preserves input order.
 *
 * Future v1.5.x tune: metric-aware picker per R-F open question #4 —
 * route → Apple wins, HR zones → Withings wins. Out of scope for
 * v1.4.30; the existing ladder ships first so the dashboard tile is
 * unambiguous.
 */
import type {
  MeasurementSource,
} from "@/generated/prisma/client";

import {
  getSourceLadder,
  parseSourcePriority,
} from "@/lib/validations/source-priority";

/**
 * Minimum row shape — same posture as `SourcePickerRow`. The helper
 * only consults the three fields; downstream callers can read every
 * other column they fetched alongside.
 */
export interface WorkoutPickerRow {
  startedAt: Date;
  sportType: string;
  source: MeasurementSource;
}

/**
 * Bucket-slot length. Two workouts whose `startedAt` falls in the
 * same 5-minute slot AND share the same sportType are treated as the
 * "same" workout from different sources. Tightens further than the
 * 1-minute clock skew between HK + Withings would suggest because
 * iOS posts HK `startDate` rounded to the second but Withings stamps
 * its `startdate` independently — five minutes gives both heads
 * enough slack on a heavy-traffic morning sync without crossing the
 * "two back-to-back runs" boundary (a user does NOT do two ten-minute
 * runs five minutes apart in practice).
 */
const BUCKET_SLOT_MS = 5 * 60 * 1000;

function bucketKey(row: WorkoutPickerRow): string {
  const slot = Math.floor(row.startedAt.getTime() / BUCKET_SLOT_MS);
  return `${slot}:${row.sportType}`;
}

/**
 * Pick canonical rows across sources for a user's workouts.
 *
 * @param rows               input rows (deterministic order required)
 * @param userPriorityJson   the user's `sourcePriorityJson` blob — same
 *                           shape the measurement picker consults.
 *                           Falls back to the canonical default ladder
 *                           when null / unparseable.
 * @returns the subset of input rows that survives the picker. Insertion
 *          order preserved.
 */
export function pickCanonicalWorkoutRows<T extends WorkoutPickerRow>(
  rows: readonly T[],
  userPriorityJson: unknown = null,
): T[] {
  if (rows.length === 0) return [];

  // Workouts ride the `steps` metric's source ladder — the
  // canonical-activity bucket. The user's iOS Settings → Sources UI
  // configures the same ladder for the workout dashboard tile;
  // unifying on "steps" keeps a single configuration surface rather
  // than introducing a new `workouts` metric key. Future ladders for
  // workout-specific tunes (route-vs-zones) ride a v1.5.x change.
  const resolved = parseSourcePriority(userPriorityJson);
  const sourceLadder = getSourceLadder(resolved, "steps");

  const buckets = new Map<
    string,
    {
      rows: T[];
      sources: Set<MeasurementSource>;
    }
  >();
  for (const row of rows) {
    const key = bucketKey(row);
    const slot = buckets.get(key) ?? { rows: [], sources: new Set() };
    slot.rows.push(row);
    slot.sources.add(row.source);
    buckets.set(key, slot);
  }

  const canonical: T[] = [];
  for (const [, slot] of buckets) {
    if (slot.rows.length === 1) {
      // No cross-source overlap → keep the single row regardless of
      // ladder membership.
      canonical.push(slot.rows[0]);
      continue;
    }

    let picked: MeasurementSource | undefined;
    for (const source of sourceLadder) {
      if (slot.sources.has(source)) {
        picked = source;
        break;
      }
    }

    if (!picked) {
      // None of the bucket's sources are listed in the ladder — never
      // silently drop. Keep every row in the bucket; downstream
      // callers can choose to surface a "duplicate from unrecognised
      // sources" diagnostic.
      canonical.push(...slot.rows);
      continue;
    }

    for (const row of slot.rows) {
      if (row.source === picked) canonical.push(row);
    }
  }

  // Re-sort to preserve input order — the bucket map iterates in
  // insertion order but the per-bucket fan-out can interleave rows
  // from later buckets ahead of earlier-bucket survivors. Caller
  // wants the same `startedAt ASC` order it passed in.
  canonical.sort((a, b) => {
    const delta = a.startedAt.getTime() - b.startedAt.getTime();
    if (delta !== 0) return delta;
    // Stable-tiebreak on sportType so the output is deterministic
    // even when two surviving rows share startedAt (rare; manual
    // entries on the same second).
    return a.sportType.localeCompare(b.sportType);
  });
  return canonical;
}
