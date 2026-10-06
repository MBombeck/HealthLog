/**
 * v1.41 — the reasoning a Coach turn asks its provider for, resolved once
 * per turn: the person's level (`coachPrefsJson.reasoning`, absent meaning
 * `medium`), switched off or capped by the operator
 * (`app_settings.ai_reasoning_enabled` / `ai_reasoning_max_effort`), and
 * capped again at `medium` when the operator pays for the turn.
 *
 * The full resolver (what each provider supports, the source of the value
 * for `/api/auth/me`) is `src/lib/ai/reasoning/resolve.ts`; this is the
 * turn's own reading of the same three inputs, so the loop runs with the
 * right level before that module lands. Integration points it here at the
 * shared resolver.
 */
import { prisma } from "@/lib/db";
import {
  DEFAULT_REASONING_LEVEL,
  REASONING_MAX_EFFORTS,
  capReasoningLevel,
  type ReasoningLevel,
  type ReasoningMaxEffort,
} from "@/lib/ai/reasoning/levels";
import type { CoachPrefs } from "@/lib/validations/coach-prefs";
import type { BudgetCostOwner } from "@/lib/ai/coach/budget";

/** A turn the operator pays for thinks at most this hard. */
export const OPERATOR_REASONING_CAP: ReasoningMaxEffort = "medium";

export interface TurnReasoning {
  effort: ReasoningLevel;
  summaries: boolean;
}

function isMaxEffort(value: unknown): value is ReasoningMaxEffort {
  return (
    typeof value === "string" &&
    (REASONING_MAX_EFFORTS as readonly string[]).includes(value)
  );
}

/** Pure: the level from the three inputs. Exported for the tests. */
export function resolveTurnReasoningLevel(args: {
  prefs: CoachPrefs;
  operator: { enabled: boolean; maxEffort: ReasoningMaxEffort };
  payer: BudgetCostOwner;
}): TurnReasoning {
  if (!args.operator.enabled) return { effort: "off", summaries: false };
  // Absent means the default, as `coachReasoningLevel` reads it.
  let effort = capReasoningLevel(
    args.prefs.reasoning ?? DEFAULT_REASONING_LEVEL,
    args.operator.maxEffort,
  );
  if (args.payer === "operator") {
    effort = capReasoningLevel(effort, OPERATOR_REASONING_CAP);
  }
  return { effort, summaries: effort !== "off" };
}

/**
 * The turn's reasoning. An unreadable settings row reads as the defaults
 * (reasoning allowed, no cap): the person's own level still applies, and
 * the operator's payer cap still holds.
 */
export async function resolveTurnReasoning(args: {
  prefs: CoachPrefs;
  payer: BudgetCostOwner;
}): Promise<TurnReasoning> {
  let enabled = true;
  let maxEffort: ReasoningMaxEffort = "high";
  try {
    const row = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: { aiReasoningEnabled: true, aiReasoningMaxEffort: true },
    });
    if (row) {
      enabled = row.aiReasoningEnabled;
      if (isMaxEffort(row.aiReasoningMaxEffort)) {
        maxEffort = row.aiReasoningMaxEffort;
      }
    }
  } catch {
    // Defaults, as above.
  }
  return resolveTurnReasoningLevel({
    prefs: args.prefs,
    operator: { enabled, maxEffort },
    payer: args.payer,
  });
}
