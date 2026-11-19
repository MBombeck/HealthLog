/**
 * v1.41 — the reasoning a Coach turn asks its provider for.
 *
 * The effective level (the person's choice after the operator's switch and
 * highest level) is resolved once, outside the turn, and handed in on the
 * turn's input (`TurnInput.reasoningLevel`). The turn adds the one cap that
 * depends on the chain it runs on: a turn the operator pays for thinks at
 * most at `medium`, whatever the person chose.
 *
 * Pure: no database, no provider.
 */
import {
  capReasoningLevel,
  type ReasoningLevel,
  type ReasoningMaxEffort,
} from "@/lib/ai/reasoning/levels";
import type { BudgetCostOwner } from "@/lib/ai/coach/budget";

/** A turn the operator pays for thinks at most this hard. */
export const OPERATOR_REASONING_CAP: ReasoningMaxEffort = "medium";

export interface TurnReasoning {
  effort: ReasoningLevel;
  summaries: boolean;
  maxEffort?: ReasoningLevel;
  explicit?: boolean;
}

/** The turn's reasoning from the effective level and who pays. */
export function reasoningForTurn(
  level: ReasoningLevel,
  payer: BudgetCostOwner,
  adminCeiling?: ReasoningLevel,
  explicit?: boolean,
): TurnReasoning {
  let ceiling: ReasoningLevel | undefined = adminCeiling;
  if (payer === "operator") {
    ceiling = ceiling
      ? capReasoningLevel(ceiling, OPERATOR_REASONING_CAP)
      : OPERATOR_REASONING_CAP;
  }
  const effort = ceiling
    ? capReasoningLevel(level, ceiling as ReasoningMaxEffort)
    : level;
  return {
    effort,
    summaries: effort !== "off",
    ...(ceiling ? { maxEffort: ceiling } : {}),
    ...(explicit !== undefined ? { explicit } : {}),
  };
}
