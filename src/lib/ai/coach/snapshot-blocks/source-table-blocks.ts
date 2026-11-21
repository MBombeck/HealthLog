/**
 * The sleep, sleep-rhythm, glucose and workouts blocks of the Coach
 * snapshot, in that order. Each is assembled in its own module from rows the
 * builder read in parallel (`snapshot-reads.ts`); this only applies each
 * block's source gate and hands it its inputs.
 */
import type { SleepStageRow } from "@/lib/analytics/sleep-night";
import { loadFreeWeekdaySpansForPrompt } from "@/lib/profile/life-circumstances";
import type { ReferenceMetric } from "@/lib/reference-ranges";
import type { RegisterBlock } from "../series-condense";
import type {
  CoachProvenance,
  CoachProvenanceMetric,
  CoachScopeSource,
} from "../types";
import { buildGlucoseBlock } from "./glucose-block";
import { buildSleepRhythmBlock, buildSleepTimelineBlock } from "./sleep-block";
import { buildWorkoutsBlock } from "./workouts-block";

type GlucoseInputs = Parameters<typeof buildGlucoseBlock>[0];
type WorkoutInputs = Parameters<typeof buildWorkoutsBlock>[0];

interface SourceTableBlocksContext {
  userId: string;
  sources: ReadonlySet<CoachScopeSource>;
  sleepRows: unknown[] | null;
  sleepRhythmRows: unknown[] | null;
  workoutRows: WorkoutInputs["workoutRows"] | null;
  measurementRows: GlucoseInputs["measurementRows"];
  glucoseClinicalRows: GlucoseInputs["glucoseClinicalRows"];
  additiveCutoff: (source: CoachScopeSource) => Date;
  sourcePriorityJson: unknown;
  glucoseUnit: GlucoseInputs["glucoseUnit"];
  unitPreference: WorkoutInputs["unitPreference"];
  ageYears: number | null;
  userTz: string;
  recentCutoff: Date;
  now: Date;
  snapshot: Record<string, unknown>;
  metrics: Set<CoachProvenanceMetric>;
  counts: NonNullable<CoachProvenance["counts"]>;
  registerBlock: RegisterBlock;
  groundingValues: Map<ReferenceMetric, number>;
}

export async function buildSourceTableBlocks(
  ctx: Readonly<SourceTableBlocksContext>,
): Promise<void> {
  const { sources, sleepRows, sleepRhythmRows, workoutRows } = ctx;
  const { userTz, recentCutoff, snapshot, metrics, counts, registerBlock } =
    ctx;
  // ── Sleep block (with optional per-stage enrichment) ───────
  // Assembled in `sleep-block.ts` from the dedicated stage-bearing rows read
  // in parallel.
  if (sources.has("sleep") && sleepRows) {
    buildSleepTimelineBlock({
      sleepRows: sleepRows as SleepStageRow[],
      sourcePriorityJson: ctx.sourcePriorityJson,
      userTz,
      recentCutoff,
      snapshot,
      metrics,
      counts,
      registerBlock,
      groundingValues: ctx.groundingValues,
    });
  }

  // ── Sleep-rhythm block (sleep-debt + chronotype) ──────────
  // Assembled in `sleep-block.ts` from the rhythm's own fixed trailing-42-day
  // rows read in parallel.
  if (sources.has("sleep") && sleepRhythmRows && sleepRhythmRows.length > 0) {
    buildSleepRhythmBlock({
      sleepRhythmRows: sleepRhythmRows as SleepStageRow[],
      sourcePriorityJson: ctx.sourcePriorityJson,
      userTz,
      ageYears: ctx.ageYears,
      freeWeekdaySpans: await loadFreeWeekdaySpansForPrompt(ctx.userId),
      snapshot,
      metrics,
      registerBlock,
    });
  }

  // ── Glucose block (per-context daily means) ────────────────
  // Assembled in `glucose-block.ts` from the shared measurement read + the
  // fixed-window clinical rows.
  if (sources.has("glucose")) {
    buildGlucoseBlock({
      measurementRows: ctx.measurementRows,
      glucoseCutoff: ctx.additiveCutoff("glucose"),
      glucoseClinicalRows: ctx.glucoseClinicalRows,
      glucoseUnit: ctx.glucoseUnit,
      recentCutoff,
      userTz,
      now: ctx.now,
      snapshot,
      metrics,
      counts,
      registerBlock,
      groundingValues: ctx.groundingValues,
    });
  }

  // ── Workouts block (capped list + per-sport rollup) ────────
  // Assembled in `workouts-block.ts` from the rows read in parallel.
  if (sources.has("workouts") && workoutRows) {
    buildWorkoutsBlock({
      workoutRows,
      sourcePriorityJson: ctx.sourcePriorityJson,
      userTz,
      snapshot,
      metrics,
      counts,
      registerBlock,
      unitPreference: ctx.unitPreference,
    });
  }
}
