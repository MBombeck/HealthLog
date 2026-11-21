/**
 * Workouts block for the Coach snapshot (v1.7.0).
 *
 * The Workout model is never dumped row-for-row. The block carries
 * the most recent `WORKOUT_RECENT_CAP` sessions (sport, duration,
 * energy, distance, avg/max HR) plus a per-sport weekly count + total
 * duration/energy rollup for the tail so the prompt stays bounded
 * even for a heavy-training account at a long window.
 *
 * Split out of `snapshot.ts`; the builder passes the rows it already
 * read plus the shared accumulators, so the emitted shape and ordering
 * are unchanged.
 *
 * v1.30.4 — `GET /api/workouts` collapses cross-source duplicate
 * sessions (e.g. Apple Watch + WHOOP recording the same run) with
 * `pickCanonicalWorkoutRows()` before the UI ever sees them; this block
 * read `prisma.workout.findMany` raw, so a dual-source user's Coach
 * prompt (and the `get_workouts` MCP tool, which re-exports this same
 * block) double-counted sessions and inflated the per-sport rollup vs.
 * the UI. Run the SAME picker here, keyed off the user's own
 * `sourcePriorityJson`, so both surfaces agree.
 */
import {
  applyDisplayTransform,
  getQuantityTransform,
  type UnitPreference,
} from "@/lib/measurements/display-transform";
import {
  canonicalWorkoutsInRange,
  type WindowedWorkouts,
} from "@/lib/workouts/canonical-read";
import type { MeasurementSource } from "@/generated/prisma/client";
import { annotate } from "@/lib/logging/context";
import { tzWeekday } from "../snapshot-series";
import type {
  CoachProvenance,
  CoachProvenanceMetric,
  CoachScopeSource,
} from "../types";
import { userDayKey } from "@/lib/tz/format";

/**
 * v1.7.0 — the workouts block never dumps every session. It carries
 * the most-recent N sessions verbatim plus a per-sport rollup for the
 * tail, so a heavy-training account at a long window stays bounded.
 */
const WORKOUT_RECENT_CAP = 15;

interface WorkoutsBlockContext {
  workoutRows: WindowedWorkouts<{
    id: string;
    sportType: string;
    startedAt: Date;
    durationSec: number;
    totalEnergyKcal: number | null;
    totalDistanceM: number | null;
    avgHeartRate: number | null;
    maxHeartRate: number | null;
    source: MeasurementSource;
  }>;
  // v1.30.4 — the user's own source-priority blob, same shape
  // `pickCanonicalWorkoutRows` and the sleep block already consume.
  // `null` falls back to the canonical default ladder.
  sourcePriorityJson: unknown;
  userTz: string;
  snapshot: Record<string, unknown>;
  metrics: Set<CoachProvenanceMetric>;
  counts: NonNullable<CoachProvenance["counts"]>;
  registerBlock: (key: string, source: CoachScopeSource) => void;
  /** The reader's metric/imperial choice; distances are stated in it. */
  unitPreference: UnitPreference;
}

export function buildWorkoutsBlock(ctx: Readonly<WorkoutsBlockContext>): void {
  const {
    workoutRows: rawWorkoutRows,
    sourcePriorityJson,
    userTz,
    snapshot,
    metrics,
    counts,
    registerBlock,
    unitPreference,
  } = ctx;
  const distanceTransform = getQuantityTransform("distance", unitPreference);
  // The workout sessions are read in parallel by the builder, raw
  // (every source, every duplicate). Collapse cross-source duplicates
  // with the same picker the UI uses before narrating anything.
  // `pickCanonicalWorkoutRows` always returns its output sorted
  // `startedAt` ASC (its documented contract) — the builder wants
  // most-recent-first for the capped `recent` list, so re-establish
  // DESC order after the pick, same as `GET /api/workouts` does.
  const workoutRows = canonicalWorkoutsInRange(
    rawWorkoutRows,
    sourcePriorityJson ?? null,
  ).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  if (workoutRows.length === 0) {
    annotate({
      action: { name: "coach.cluster.empty_skipped" },
      meta: { cluster: "workouts", source: "workouts" },
    });
  } else {
    const recentList = workoutRows.slice(0, WORKOUT_RECENT_CAP).map((w) => ({
      date: userDayKey(w.startedAt, userTz),
      weekday: tzWeekday(w.startedAt, userTz),
      sport: w.sportType,
      durationMin: Math.round(w.durationSec / 60),
      energyKcal: w.totalEnergyKcal ?? null,
      distance:
        w.totalDistanceM == null
          ? null
          : applyDisplayTransform(w.totalDistanceM, distanceTransform),
      avgHr: w.avgHeartRate ?? null,
      maxHr: w.maxHeartRate ?? null,
    }));
    // Per-sport rollup over the whole window.
    const bySport = new Map<
      string,
      { count: number; durationMin: number; energyKcal: number }
    >();
    for (const w of workoutRows) {
      const e = bySport.get(w.sportType) ?? {
        count: 0,
        durationMin: 0,
        energyKcal: 0,
      };
      e.count += 1;
      e.durationMin += Math.round(w.durationSec / 60);
      e.energyKcal += w.totalEnergyKcal ?? 0;
      bySport.set(w.sportType, e);
    }
    const sportRollup = Array.from(bySport.entries())
      .map(([sport, v]) => ({
        sport,
        count: v.count,
        totalDurationMin: v.durationMin,
        totalEnergyKcal: Math.round(v.energyKcal),
      }))
      .sort((a, b) => b.count - a.count);
    snapshot.workouts = {
      distanceUnit: distanceTransform.displayUnit,
      recent: recentList,
      perSport: sportRollup,
      totalInWindow: workoutRows.length,
    };
    metrics.add("workouts");
    counts.workouts = workoutRows.length;
    registerBlock("workouts", "workouts");
  }
}
