/**
 * Narrative context for the Coach snapshot: rolling-profile memory, the
 * cycle/phase block, illness, labs, the seizure diary, doctor visits and the
 * energy balance.
 * Each is built by its own helper (read in the parallel batch,
 * `snapshot-reads.ts`) and attached here in a fixed order; some register for
 * budget degradation, some do not.
 */
import type { CoachScopeSource } from "../types";

interface NarrativeContextBlocksContext {
  memoryBlock: unknown;
  cycleBlock: unknown;
  illnessBlock: unknown;
  labsBlock: unknown;
  seizuresBlock: unknown;
  visitsBlock: unknown;
  energyBalanceBlock: unknown;
  snapshot: Record<string, unknown>;
  registerBlock: (key: string, source: CoachScopeSource) => void;
}

export function buildNarrativeContextBlocks(
  ctx: Readonly<NarrativeContextBlocksContext>,
): void {
  const { snapshot, registerBlock } = ctx;

  // Rolling-profile memory. Zero-LLM longitudinal recall: the latest
  // period-narrative headline + a per-metric prior-vs-current band memory,
  // assembled from artefacts we already persist. Lets the Coach reference
  // "as I noted at the start of the month…" instead of re-deriving cold
  // every turn. Folded under the `memory` key and registered against the
  // LOWEST-signal cluster (`environment`, the tail of CLUSTER_PRIORITY) so
  // `degradeToBudget` sheds it FIRST under the char cap — before any
  // clinical cluster. The builder is fault-isolated per sub-source and
  // returns null when neither a narrative nor any band movement is on file.
  if (ctx.memoryBlock) {
    snapshot.memory = ctx.memoryBlock;
    // `skin_temp` maps to the `environment` cluster — the lowest priority
    // in CLUSTER_PRIORITY — so this block degrades before everything else.
    registerBlock("memory", "skin_temp");
  }

  // Cycle/phase block. Present only for a cycle-enabled account (the
  // promise is null otherwise, so this is byte-for-byte unchanged for
  // everyone else). The block names the current phase + day-of-cycle, the
  // next predicted event (period range + confidence + method; fertile window
  // goal-gated), and the headline phase-correlation finding — all from the
  // same deterministic engine the calendar + insights surface use, never
  // re-derived. The Coach's cycle ground rule keeps replies descriptive:
  // never contraception-grade, never a "safe day" claim. Registered against
  // the lowest-priority `skin_temp` source so the soft-cap degrader sheds it
  // before any clinical cluster.
  if (ctx.cycleBlock) {
    snapshot.cycle = ctx.cycleBlock;
    registerBlock("cycle", "skin_temp");
  }

  // Illness/condition context. Small + load-bearing, so it is attached
  // WITHOUT a cluster registration (like scope/anthropometrics): the budget
  // degrader never sheds it, the Coach always knows whether the user is in
  // Rest Mode. Labels + lifecycle + dates only — no decrypted note.
  if (ctx.illnessBlock) {
    snapshot.illness = ctx.illnessBlock;
  }

  // Lab-result context (#65). Attached WITHOUT a cluster registration (like
  // illness/scope): the budget degrader never sheds it, so the Coach can
  // always answer a lab question from the user's own readings.
  // Server-authoritative + grounded — resolved name/value/unit/range per
  // biomarker, never the decrypted note.
  if (ctx.labsBlock) {
    snapshot.labs = ctx.labsBlock;
  }

  // The seizure diary: counts, clusters and dates only. Like illness and
  // labs it is attached WITHOUT a cluster registration, so the budget
  // degrader never sheds it.
  if (ctx.seizuresBlock) {
    snapshot.seizures = ctx.seizuresBlock;
  }

  // Doctor-visit context. Registered for degradation, and placed EXPLICITLY
  // rather than left to inherit the tail of the list by accident: a visit
  // history is low-frequency, high-signal-but-losable context, so it maps to
  // `skin_temp` (the `environment` cluster, the tail of CLUSTER_PRIORITY),
  // which puts it among the first blocks the budget degrader sheds — before
  // any clinical cluster. Unlike illness (which carries the Rest Mode safety
  // flag) there is no reason to protect it from truncation.
  if (ctx.visitsBlock) {
    snapshot.visits = ctx.visitsBlock;
    registerBlock("visits", "skin_temp");
  }

  // The energy balance: window means only, registered on its own source so
  // the degrader sheds it with the activity cluster under budget pressure.
  if (ctx.energyBalanceBlock) {
    snapshot.energyBalance = ctx.energyBalanceBlock;
    registerBlock("energyBalance", "active_energy");
  }
}
