/**
 * Block assembly for the Coach snapshot: every block builder, called in the
 * order the provenance and the block registration depend on, then the scope
 * block. The reads it consumes come from `snapshot-reads.ts`; `snapshot.ts`
 * compacts, degrades and grounds the result.
 */
import type { extractFeatures } from "@/lib/insights/features";
import type { UnitPreferences } from "@/lib/measurements/display-transform";
import {
  DAILY_TIMELINE_DAYS,
  type readSnapshotMeasurementRows,
  type resolveSnapshotCutoffs,
  type resolveSnapshotPrelude,
} from "../snapshot-prelude";
import type { CoachHistoryReach } from "../history-reach";
import type { CoachScope } from "../types";
import type { SnapshotAccumulators } from "./block-registry";
import type {
  readCoreCoarseTails,
  readSnapshotBlockInputs,
  resolveDerivedGate,
} from "./snapshot-reads";
import { buildComplianceBlock } from "./compliance-block";
import { buildCoreMetricsBlocks } from "./core-metrics-block";
import { buildValueSeriesBlocks } from "./value-series-blocks";
import { buildProfileContextBlocks } from "./context-blocks";
import { buildSourceTableBlocks } from "./source-table-blocks";
import { buildDerivedLayerBlocks } from "./derived-layer-blocks";
import { buildNarrativeContextBlocks } from "./narrative-context-blocks";
import { buildCrossCuttingBlocks } from "./cross-cutting-blocks";

type SnapshotPrelude = Awaited<ReturnType<typeof resolveSnapshotPrelude>>;

export interface SnapshotAssemblyInput {
  userId: string;
  scope: CoachScope | undefined;
  reach: CoachHistoryReach;
  window: SnapshotPrelude["window"];
  sources: SnapshotPrelude["sources"];
  units: UnitPreferences;
  sourcePriorityJson: unknown;
  bounded: boolean;
  excludesMedications: boolean;
  excludesAnthropometrics: boolean;
  cutoffs: Pick<
    ReturnType<typeof resolveSnapshotCutoffs>,
    "cutoff" | "recentCutoff" | "additiveCutoff"
  >;
  now: Date;
  userTz: string;
  features: Awaited<ReturnType<typeof extractFeatures>>;
  measurementRows: Awaited<ReturnType<typeof readSnapshotMeasurementRows>>;
  coarseTails: Awaited<ReturnType<typeof readCoreCoarseTails>>;
  reads: Awaited<ReturnType<typeof readSnapshotBlockInputs>>;
  derived: ReturnType<typeof resolveDerivedGate>;
  acc: SnapshotAccumulators;
}

/**
 * Build every block into the snapshot, in the order the provenance and the
 * block registration depend on, then pin the scope block.
 */
export async function assembleSnapshotBlocks(
  input: SnapshotAssemblyInput,
): Promise<void> {
  const { userId, scope, reach, window, sources, units, bounded } = input;
  const { excludesMedications, excludesAnthropometrics, now, userTz } = input;
  const { features, measurementRows, coarseTails, reads } = input;
  const { cutoff, recentCutoff, additiveCutoff } = input.cutoffs;
  const { derivedProfile, derivedActive } = input.derived;
  const { snapshot, windows, metrics, counts, groundingValues } = input.acc;
  const { registerBlock } = input.acc.registry;
  const glucoseUnit = units.glucoseUnit;
  const accumulators = { snapshot, metrics, counts, registerBlock };
  buildCoreMetricsBlocks({
    sources,
    features,
    measurementRows,
    moodRows: reads.moodRows,
    recentCutoff,
    userTz,
    coarseTails,
    windows,
    ...accumulators,
    groundingValues,
    units,
  });
  // Medication compliance lives outside the structured features — the block
  // is assembled in `snapshot-blocks/compliance-block.ts` from the ledger
  // reads above.
  if (sources.has("compliance") && reads.complianceMeds) {
    buildComplianceBlock({
      complianceMeds: reads.complianceMeds,
      userTz,
      cutoff,
      recentCutoff,
      now,
      ...accumulators,
    });
  }

  buildValueSeriesBlocks({
    sources,
    measurementRows,
    additiveCutoff,
    recentCutoff,
    userTz,
    ...accumulators,
    groundingValues,
    units,
  });
  // Sleep, glucose and workouts, each from the reads above.
  await buildSourceTableBlocks({
    userId,
    sources,
    sleepRows: reads.sleepRows,
    sleepRhythmRows: reads.sleepRhythmRows,
    workoutRows: reads.workoutRows,
    measurementRows,
    glucoseClinicalRows: reads.glucoseClinicalRows,
    additiveCutoff,
    sourcePriorityJson: input.sourcePriorityJson,
    glucoseUnit,
    unitPreference: units.system,
    ageYears: derivedProfile.ageYears,
    userTz,
    recentCutoff,
    now,
    ...accumulators,
    groundingValues,
  });

  buildProfileContextBlocks({
    excludesMedications,
    excludesAnthropometrics,
    glp1Block: reads.glp1Block,
    profile: features.context,
    snapshot,
    metrics,
    registerBlock,
  });

  // ── Derived wellness layer (compact summaries) ─────────────
  buildDerivedLayerBlocks({
    derivedActive,
    derivedBlock: reads.derivedBlock,
    dayStrainRows: reads.dayStrainRows,
    trajectoryBlock: reads.trajectoryBlock,
    correlationsBlock: reads.correlationsBlock,
    recentCutoff,
    snapshot,
    metrics,
    registerBlock,
  });

  // Memory, cycle, illness, labs and visits.
  buildNarrativeContextBlocks({
    memoryBlock: reads.memoryBlock,
    cycleBlock: reads.cycleBlock,
    illnessBlock: reads.illnessBlock,
    labsBlock: reads.labsBlock,
    visitsBlock: reads.visitsBlock,
    energyBalanceBlock: reads.energyBalanceBlock,
    snapshot,
    registerBlock,
  });

  // ── Adherence storyline (B5), changepoints (C1), signal-trust (C3).
  await buildCrossCuttingBlocks({
    userId,
    userTz,
    now,
    scope,
    reach,
    excludesMedications,
    snapshot,
  });

  if (Object.keys(snapshot).length === 0) {
    metrics.add("general");
  }

  // Pin the scope onto the snapshot itself so the model knows which
  // windows + sources are in-bounds for the reply. The system prompt
  // tells the model to read from this block for day-level questions.
  snapshot.scope = {
    window,
    sources: Array.from(sources),
    timelineRecentDays: DAILY_TIMELINE_DAYS,
    // Named only under a limit, so an unlimited snapshot stays as it was.
    ...(bounded ? { lookbackLimit: reach.window } : {}),
  };
}
