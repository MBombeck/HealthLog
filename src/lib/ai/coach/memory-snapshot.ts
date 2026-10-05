/**
 * v1.11.0 W5a — Coach rolling-profile memory block (Pillar P2 2a).
 *
 * A ZERO-LLM, machine-derived "what was true recently + what the Coach
 * already noted" block folded into the Coach snapshot. It carries no raw
 * series and calls no model — it reads artefacts we already persist:
 *
 *  - `priorNarrative` — the most recent period-narrative (W3) headline +
 *    its driver list, so the Coach can say "as I noted at the start of the
 *    month, your resting HR drifted up" instead of re-deriving cold every
 *    turn. Source: `readPeriodNarrative` (stale-while-revalidate read of the
 *    typed `insight_narratives` row).
 *  - `trendMemory` — per in-scope vital, the band it held in the PRIOR
 *    period vs where its current-period center sits now. This generalises
 *    the per-status `memory.ts` previous-context primitive to the Coach.
 *    Source: the band transitions already computed by
 *    `buildPeriodNarrativeContext` (MAD baseline, prior-period band edges).
 *
 * Unencrypted by the same rule as `metricSourceJson` / the derived block:
 * it is the user's own labels + numbers + a provenance-grounded narrative
 * recall, never free conversational content (that lives in the encrypted
 * W5b summary). Per-source fault isolation: a transient failure on either
 * sub-source drops that sub-block and never sinks the Coach turn.
 *
 * Lowest snapshot priority by design — wired into `snapshot.ts` so
 * `degradeToBudget` sheds it FIRST under the char cap, before any clinical
 * cluster.
 *
 * Server-only — reads `@/lib/db` transitively through the two sources.
 */
import {
  readPeriodNarrative,
  type NarrativeRead,
} from "@/lib/insights/narrative/period-narrative-generate";
import {
  buildPeriodNarrativeContext,
  type NarrativePeriod,
  type BandTransition,
} from "@/lib/insights/narrative/period-narrative";
import type { BaselineProfile } from "@/lib/insights/derived";
import type { Locale } from "@/lib/i18n/config";
import { buildCoachFactsBlock } from "./facts";
import { dayKeyAsUtcMidnight } from "@/lib/tz/date-only";
import {
  UNBOUNDED_REACH,
  fitsReach,
  isBounded,
  withinReach,
  type CoachHistoryReach,
} from "./history-reach";
import {
  buildCoachPlansBlock,
  buildCoachRemindersBlock,
  type CoachPlanInjectEntry,
  type CoachReminderInjectEntry,
} from "./plans";

/** The period the rolling profile recalls — month is the high-signal beat. */
const MEMORY_PERIOD: NarrativePeriod = "month";

/**
 * How far back the narrative and the band memory reach: the prior month
 * against the current one. A shorter lookback limit leaves both out; facts,
 * plans and reminders are what the person told the Coach, not readings, and
 * stay.
 */
const MEMORY_HISTORY_HORIZON_DAYS = 2 * 30; // two `PERIOD_DAYS.month`

/** True when the history a narrative dated `dateKey` describes lies inside the limit. */
function narrativeWithinReach(
  dateKey: string,
  reach: CoachHistoryReach,
  now: Date,
): boolean {
  if (!isBounded(reach)) return true;
  // The narrative row's own day key, compared as its date, not a local day.
  const end = dayKeyAsUtcMidnight(dateKey).getTime();
  if (!Number.isFinite(end)) return false;
  return withinReach(
    new Date(end - MEMORY_HISTORY_HORIZON_DAYS * 86_400_000),
    reach,
    now,
  );
}

/** Cap the recalled narrative so a verbose row cannot bloat the snapshot. */
const NARRATIVE_HEADLINE_CHARS = 600;
/** Drivers are conservative one-liners; a handful is plenty of recall. */
const MAX_RECALLED_DRIVERS = 4;

/** A band a metric held: inside its personal range, or above/below it. */
type TrendBand = "in" | "above" | "below";

/** Per-metric trend recall: where it sat in the prior period vs now. */
export interface TrendMemoryEntry {
  /** Where the metric sat over the prior period (its baseline = "in"). */
  priorBand: TrendBand;
  /** Where the current-period center sits relative to the prior band. */
  currentBand: TrendBand;
  /** The prior period this recall compares against. */
  priorPeriod: NarrativePeriod;
}

/** The machine-derived narrative recall the Coach can ground a callback in. */
export interface PriorNarrativeRecall {
  /** The narrative prose, capped — the Coach paraphrases, never quotes raw. */
  headline: string;
  /** The conservative, descriptive driver one-liners, verbatim. */
  drivers: string[];
}

/** The rolling-profile memory block folded under `snapshot.memory`. */
export interface CoachMemoryBlock {
  priorNarrative?: PriorNarrativeRecall;
  trendMemory: Record<string, TrendMemoryEntry>;
  /**
   * v1.11.1 — durable personal facts the Coach has learned (top-N, ranked by
   * confidence then recency). Descriptive, never diagnostic. Absent when none.
   */
  facts?: Array<{ category: string; text: string }>;
  /**
   * v1.21.3 (B1) — the user's ACTIVE goal / if-then plans (top-N, newest
   * first). Only confirmed (`active`) plans appear here — a `proposed` plan is
   * still awaiting the user's confirmation. Absent when none.
   */
  plans?: CoachPlanInjectEntry[];
  /**
   * v1.22 (B2/B3) — the user's near/overdue or already-surfaced episodic
   * reminders ("remind me about X"), top-N soonest first. Lets the Coach
   * reference them unprompted next turn — the progress-reflection reflex.
   * Absent when none.
   */
  reminders?: CoachReminderInjectEntry[];
}

/** Pull the headline + driver recall off the latest period narrative. */
function recallNarrative(row: NarrativeRead): PriorNarrativeRecall {
  const headline =
    row.text.length > NARRATIVE_HEADLINE_CHARS
      ? row.text.slice(0, NARRATIVE_HEADLINE_CHARS) + "…"
      : row.text;
  // The typed narrative row carries no structured driver list (the prose
  // already folds them in); we surface the headline as the primary recall
  // and keep drivers empty unless the row ever carries them — never
  // fabricate.
  return { headline, drivers: [] };
}

/** Map a band transition onto the {prior,current} band pair. */
function trendFromTransition(b: BandTransition): TrendMemoryEntry {
  // The band edges are established over the PRIOR period, so by construction
  // the prior-period center sat inside its own band → priorBand = "in". The
  // current-period direction is the live placement.
  return {
    priorBand: "in",
    currentBand: b.direction,
    priorPeriod: MEMORY_PERIOD,
  };
}

/**
 * Build the rolling-profile memory block, or `null` when neither sub-source
 * yields anything (no narrative on file AND no band transitions). Each
 * sub-source is fault-isolated: a failure on one never sinks the other or
 * the Coach turn.
 *
 * `profile` is accepted for parity with `buildDerivedSnapshotBlock` and to
 * keep the call site uniform; the current sub-sources read their own
 * baselines internally.
 */
export async function buildCoachMemoryBlock(
  userId: string,
  _profile: BaselineProfile,
  now: Date,
  /**
   * The reader's UI locale — the narrative row is keyed by it, across the full
   * six-locale union. Narrowing it here would read a row the narrative
   * pipeline never writes for that user.
   */
  locale: Locale,
  reach: CoachHistoryReach = UNBOUNDED_REACH,
): Promise<CoachMemoryBlock | null> {
  const historyAllowed = fitsReach(MEMORY_HISTORY_HORIZON_DAYS, reach);
  let priorNarrative: PriorNarrativeRecall | undefined;
  // Sub-source 1: the latest period-narrative headline + driver recall. The
  // row is whatever was last written, of any age; under a limit it counts
  // only when the history it describes lies inside the limit.
  try {
    const row = historyAllowed
      ? await readPeriodNarrative(userId, MEMORY_PERIOD, locale)
      : null;
    if (
      row &&
      row.text.trim().length > 0 &&
      narrativeWithinReach(row.dateKey, reach, now)
    ) {
      const recall = recallNarrative(row);
      recall.drivers = recall.drivers.slice(0, MAX_RECALLED_DRIVERS);
      priorNarrative = recall;
    }
  } catch {
    // A narrative read failure is non-fatal — the trend memory still stands.
    priorNarrative = undefined;
  }

  // Sub-source 2: per-metric band movement (prior period vs now). Reuses the
  // SAME MAD-baseline band transitions the narrative context computes — no
  // parallel aggregation, no recompute beyond the one assembly call.
  const trendMemory: Record<string, TrendMemoryEntry> = {};
  try {
    const ctx = historyAllowed
      ? await buildPeriodNarrativeContext(userId, {
          period: MEMORY_PERIOD,
          now,
          locale,
        })
      : null;
    if (ctx?.status === "ready") {
      for (const transition of ctx.bandTransitions) {
        trendMemory[transition.type] = trendFromTransition(transition);
      }
    }
  } catch {
    // A context failure leaves trendMemory empty — never sinks the turn.
  }

  // Sub-source 3 (v1.11.1): durable personal facts the Coach has extracted.
  // Fault-isolated like the others — a read/decrypt failure drops the facts
  // sub-block and never sinks the turn.
  let facts: Array<{ category: string; text: string }> | undefined;
  try {
    const factsBlock = await buildCoachFactsBlock(userId);
    if (factsBlock && factsBlock.facts.length > 0) {
      facts = factsBlock.facts;
    }
  } catch {
    facts = undefined;
  }

  // Sub-source 4 (v1.21.3 B1): the user's confirmed goal / if-then plans.
  // Fault-isolated like the facts block; only `active` plans are injected.
  let plans: CoachPlanInjectEntry[] | undefined;
  try {
    const plansBlock = await buildCoachPlansBlock(userId);
    if (plansBlock && plansBlock.plans.length > 0) {
      plans = plansBlock.plans;
    }
  } catch {
    plans = undefined;
  }

  // Sub-source 5 (v1.22 B2/B3): the user's near/overdue or surfaced episodic
  // reminders. Fault-isolated like the others; the read half lives in plans.ts
  // alongside the plan-injection block.
  let reminders: CoachReminderInjectEntry[] | undefined;
  try {
    const remindersBlock = await buildCoachRemindersBlock(userId, now);
    if (remindersBlock && remindersBlock.reminders.length > 0) {
      reminders = remindersBlock.reminders;
    }
  } catch {
    reminders = undefined;
  }

  if (
    !priorNarrative &&
    Object.keys(trendMemory).length === 0 &&
    !facts &&
    !plans &&
    !reminders
  ) {
    return null;
  }

  const block: CoachMemoryBlock = { trendMemory };
  if (priorNarrative) block.priorNarrative = priorNarrative;
  if (facts) block.facts = facts;
  if (plans) block.plans = plans;
  if (reminders) block.reminders = reminders;
  return block;
}
