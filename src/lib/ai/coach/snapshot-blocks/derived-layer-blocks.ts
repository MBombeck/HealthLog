/**
 * Derived wellness layer for the Coach snapshot: the derived block, the
 * WHOOP-native day strain, the short-horizon trajectory and the discovered
 * cross-metric drivers. All four are the `recovery` module's domain and are
 * attached only while `derivedActive` holds; their reads run in the parallel
 * batch (`snapshot-reads.ts`).
 */
import type { CoachProvenanceMetric, CoachScopeSource } from "../types";
import { buildDayStrainBlock } from "./context-blocks";

interface DerivedLayerBlocksContext {
  derivedActive: boolean;
  derivedBlock: unknown;
  dayStrainRows: ReadonlyArray<{ value: number; measuredAt: Date }> | null;
  trajectoryBlock: unknown;
  correlationsBlock: unknown;
  recentCutoff: Date;
  snapshot: Record<string, unknown>;
  metrics: Set<CoachProvenanceMetric>;
  registerBlock: (key: string, source: CoachScopeSource) => void;
}

// The composites + persisted scores the dashboard rings render, folded
// in as one tiny object per metric (value + band + coverage), NOT the
// raw series. So the Coach can say "your readiness is 64, low band" and
// ground it in the same number the user sees. Insufficient metrics are
// omitted (no "no data" noise). Reads the same `computeDerivedMetric`
// contract every surface uses — no recompute. Gated on at least one of
// the signals the composites are built from staying in-scope (HRV /
// resting HR / sleep / VO₂max), so a user who excludes those doesn't see
// the block. `derivedActive` + `derivedProfile` are resolved up front so
// the derived / trajectory reads can run in the parallel batch.
export function buildDerivedLayerBlocks(
  ctx: Readonly<DerivedLayerBlocksContext>,
): void {
  if (!ctx.derivedActive) return;
  const { snapshot, registerBlock } = ctx;
  if (ctx.derivedBlock) {
    snapshot.derived = ctx.derivedBlock;
    ctx.metrics.add("hrv");
    registerBlock("derived", "hrv");
  }

  buildDayStrainBlock({
    rows: ctx.dayStrainRows,
    recentCutoff: ctx.recentCutoff,
    snapshot,
    registerBlock,
  });

  // Short-horizon trajectory block. Additive, lowest-signal block: per
  // in-scope metric a compact direction + slope + projected
  // horizon-end-with-band, computed by the deterministic `computeTrajectory`
  // engine (NEVER recomputed here). The Coach narrates the range
  // conditionally (system-prompt rule 11 / ground rule 16) only when this
  // block is present. Registered under an `environment`-cluster source so
  // the soft-cap degrader sheds it FIRST, before any clinical cluster, under
  // prompt-budget pressure. Read in the parallel batch.
  if (ctx.trajectoryBlock) {
    snapshot.trajectory = ctx.trajectoryBlock;
    registerBlock("trajectory", "skin_temp");
  }

  // Discovered cross-metric drivers. The bounded top-N driver pairs (post
  // quality-gate, post-rank) from the SAME engine the get_correlations tool
  // reads, attached so the no-tools / local-provider path narrates the
  // cross-metric layer it was missing — closing the parity gap with the tool
  // path and making system-prompt rule 14's "any driver field the SNAPSHOT
  // carries" fallback real. Descriptive, never causal. Registered against
  // the lowest-priority `skin_temp` (environment) cluster so the budget
  // degrader sheds it before any clinical block under prompt-budget pressure.
  if (ctx.correlationsBlock) {
    snapshot.correlations = ctx.correlationsBlock;
    registerBlock("correlations", "skin_temp");
  }
}
