/**
 * Block registry for the Coach snapshot. Maps each emitted snapshot top-level
 * key to the cluster it belongs to so the soft-cap degradation pass can walk
 * blocks in reverse cluster-priority order and shed the lowest-signal detail
 * first. Core legacy blocks register too so the degrader can reach them as a
 * last resort.
 */
import type { CoachDataCluster } from "@/lib/validations/coach-prefs";
import { sourceCluster } from "../clusters";
import type { DailySeries, RegisterBlock } from "../series-condense";
import type { ReferenceMetric } from "@/lib/reference-ranges";
import type { CoachProvenance, CoachScopeSource } from "../types";

export interface SnapshotBlockRegistry {
  blockClusters: Map<string, CoachDataCluster>;
  /**
   * The source each block was built for, so a single-source read can tell
   * which blocks it asked for (see `degradeToBudget`).
   */
  blockSources: Map<string, CoachScopeSource>;
  /** A series block's daily values, read only if the block is condensed. */
  blockDaily: Map<string, () => DailySeries>;
  registerBlock: RegisterBlock;
}

export function createSnapshotBlockRegistry(): SnapshotBlockRegistry {
  const blockClusters = new Map<string, CoachDataCluster>();
  const blockSources = new Map<string, CoachScopeSource>();
  const blockDaily = new Map<string, () => DailySeries>();
  const registerBlock: RegisterBlock = (key, source, daily) => {
    const cluster = sourceCluster(source);
    if (cluster) blockClusters.set(key, cluster);
    blockSources.set(key, source);
    if (daily) blockDaily.set(key, daily);
  };
  return { blockClusters, blockSources, blockDaily, registerBlock };
}

/** The snapshot record and the accumulators every block writes into. */
export interface SnapshotAccumulators {
  snapshot: Record<string, unknown>;
  windows: Set<CoachProvenance["windows"][number]>;
  metrics: Set<CoachProvenance["metrics"][number]>;
  counts: NonNullable<CoachProvenance["counts"]>;
  groundingValues: Map<ReferenceMetric, number>;
  registry: SnapshotBlockRegistry;
}

export function createSnapshotAccumulators(
  window: CoachProvenance["windows"][number],
): SnapshotAccumulators {
  // Trim down to the metrics the Coach narrates. extractFeatures
  // returns more (sleep, steps, etc.) — the Coach surface keeps the
  // snapshot tight so each turn fits inside the provider's context
  // budget for free-tier accounts.
  const snapshot: Record<string, unknown> = {};
  const windows = new Set<CoachProvenance["windows"][number]>();
  // Seed the provenance window set with the user's resolved scope so the
  // year-in-review window surfaces in the provenance envelope even when the
  // per-metric branches only emit `last30days` / `last90days` chips. Older
  // windows are added by the metric branches as before.
  if (window === "lastYear" || window === "allTime") {
    windows.add(window);
  }
  const metrics = new Set<CoachProvenance["metrics"][number]>();
  const counts: NonNullable<CoachProvenance["counts"]> = {};

  // Representative scalar per reference-covered metric, in the metric's
  // reference unit, collected as the blocks build. Feeds the citation-aware
  // grounding block (population band + the user's placement). Each entry
  // reads the SAME number the snapshot already surfaces — no independent
  // recompute — so the grounding can never cite a value the snapshot doesn't
  // carry. A metric with a block but no clean scalar is left unset (the
  // grounding line still cites its band with an insufficient placement only
  // if it is added with a null value; we omit such metrics).
  const groundingValues = new Map<ReferenceMetric, number>();

  return {
    snapshot,
    windows,
    metrics,
    counts,
    groundingValues,
    registry: createSnapshotBlockRegistry(),
  };
}
