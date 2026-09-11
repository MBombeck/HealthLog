/**
 * v1.25.0 — AI enrichment for the proactive Coach nudge (opt-in).
 *
 * The deterministic warm template (`buildCoachNudgePayload`) is always the
 * DEFAULT and the fail-closed fallback. When the user opted in
 * (`coach.nudgeAiComposed`) AND a provider is healthy, the 05:15 tick composes
 * the nudge BODY through the model instead — the greeting title stays
 * deterministic so the warm, name-led opener is guaranteed regardless of the
 * model's output.
 *
 * Hard guards (non-negotiable):
 *   - a CONSENT gate: a chain that could egress via the operator's
 *     server-managed credential requires an active `ai_coach` / `ai_full`
 *     receipt. The PHI volume here is small (an abstract trigger topic plus
 *     the deterministic template body) but it is still the user's health
 *     situation leaving the server on a credential they did not contract, and
 *     this tick runs unattended — so it carries the same receipt requirement
 *     as the interactive Coach;
 *   - per-user daily BUDGET gate (the same reserve/reconcile ledger the Coach
 *     chat uses, with the chain-aware daily cap);
 *   - a tight per-call TIMEOUT (≤ ~9 s) on both the provider `timeoutMs` and a
 *     belt-and-suspenders `AbortSignal`;
 *   - a per-tick CEILING (a call count + a wall-clock deadline) so the
 *     SEQUENTIAL tick cannot stall across the user base on provider latency;
 *   - ANY error / timeout / budget refusal / unsafe output → return null and
 *     the caller keeps the template.
 *
 * The same content rules as the template apply to the model's output, enforced
 * server-side: the outbound safety screen (`screenCoachReply`) rejects a
 * dose-prescription or a fabricated risk score, the prompt forbids quoting the
 * user's words / inventing figures / imperatives, and the body is length- and
 * shape-bounded before it can ship. The user's raw self-context focus is NEVER
 * passed to the model — only its presence, abstractly.
 */
import type { CoachNudgeTrigger } from "@/lib/jobs/coach-nudge";
import type { Locale } from "@/lib/i18n/config";
import { resolveProviderChain } from "@/lib/ai/provider";
import {
  chainRequiresServerManagedConsent,
  hasActiveConsentForSurface,
} from "@/lib/ai/consent-guard";
import {
  buildDateKey,
  reconcileSpend,
  reserveBudget,
  resolveCostOwner,
  resolveDailyCap,
} from "@/lib/ai/coach/budget";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { singleUserTurn } from "@/lib/ai/types";
import { screenCoachReply } from "@/lib/ai/coach/outbound-guard";
import { extractAssessmentSummary } from "@/lib/insights/status-shared";
import { annotate } from "@/lib/logging/context";

/** Per-call upstream timeout — kept inside the spec's ≤8–10 s window. */
export const COACH_NUDGE_AI_CALL_TIMEOUT_MS = 9_000;
/** Per-tick ceiling: max AI compositions before the rest fall to template. */
export const COACH_NUDGE_AI_MAX_PER_TICK = 25;
/** Per-tick ceiling: wall-clock budget for ALL AI compositions this tick. */
export const COACH_NUDGE_AI_TICK_BUDGET_MS = 90_000;
/** Hard cap on a composed body before it ships (else fall back). */
export const COACH_NUDGE_AI_MAX_BODY_CHARS = 320;

/**
 * Shared, mutable per-tick budget. One instance is created per
 * `runCoachNudgeTick` and threaded into every composition so the sequential
 * pass can't blow past the count or the wall-clock deadline.
 */
export interface NudgeAiTickBudget {
  remainingCount: number;
  /** Epoch ms (real wall clock) after which no further AI call is started. */
  deadline: number;
}

export function createNudgeAiTickBudget(): NudgeAiTickBudget {
  return {
    remainingCount: COACH_NUDGE_AI_MAX_PER_TICK,
    deadline: Date.now() + COACH_NUDGE_AI_TICK_BUDGET_MS,
  };
}

export interface ComposeNudgeParams {
  userId: string;
  trigger: CoachNudgeTrigger;
  locale: Locale;
  name: string | null;
  hasCoachFocus: boolean;
  /** The deterministic template — handed to the model as a style reference. */
  template: { title: string; body: string };
  tickBudget: NudgeAiTickBudget;
}

export type ComposeNudgeWithAI = (
  params: ComposeNudgeParams,
) => Promise<{ title: string; body: string } | null>;

/**
 * Abstract, vendor-/figure-free topic phrase per trigger. The model writes the
 * actual copy in the user's locale; this only tells it WHAT the nudge is
 * about, never quoting any of the user's own words or readings.
 */
const TRIGGER_TOPIC: Record<CoachNudgeTrigger, string> = {
  compliance: "their medication intake has been a bit irregular this week",
  bp: "their blood pressure has run a touch above their usual target this week",
  score: "their recovery has been easing off over the last few days",
  weight: "their weight has been drifting away from their target range",
  sleepDebt: "they have had several short nights this week",
  measurementGap: "they have not logged any readings for about a week",
  selfContext:
    "a quick refresh of their self-description would help the coach know them better",
};

function buildNudgeSystemPrompt(locale: Locale): string {
  const language = locale === "de" ? "German" : "English";
  return `You write a single, very short proactive message from a calm, caring personal-health coach. It will appear as a phone notification body.

Hard rules:
- Write ONLY in ${language}.
- One or two short sentences, warm and observational, ending in a GENTLE INVITE — never an imperative, never pushy.
- Do NOT open with a greeting or the person's name; the app prepends the greeting.
- Mention exactly ONE idea. No lists.
- No numbers, no measurements, no figures of any kind.
- No medical advice, no diagnosis, no medication or dose suggestions, no risk scores.
- Never quote the person's own words and never invent details about them.
- Plain text only — no markdown, no quotation marks around the message, no emoji.`;
}

function buildNudgeUserPrompt(params: ComposeNudgeParams): string {
  const focusLine = params.hasCoachFocus
    ? "They have set a personal focus they want to keep an eye on; you may gently acknowledge that they care about it, WITHOUT repeating or guessing what it is.\n"
    : "";
  return `Context: ${TRIGGER_TOPIC[params.trigger]}.
${focusLine}For reference, a deterministic version of this message reads: "${params.template.body}"

Rephrase it warmly and naturally in your own words, following every rule. Return only the message text.`;
}

/**
 * Normalise the model's output into a shippable body, or null when it is
 * unusable (empty / over-length / unsafe). Strips wrapping quotes and collapses
 * whitespace; rejects rather than mid-word-clamping an over-long reply.
 */
export function sanitiseAiBody(raw: string, locale: Locale): string | null {
  let text = (raw ?? "").trim();
  if (!text) return null;
  // v1.32.20 — the same structured-envelope detection the status cards run
  // (`extractAssessmentSummary`). A nudge body is one plain sentence; a
  // brace-led or fenced `{"line":"…"}` / `{"body":"…"}` reply — or a truncated
  // envelope under the char cap — is a broken contract and must resolve to the
  // deterministic template rather than render raw JSON. Only genuine prose
  // (`kind === "prose"`) passes.
  if (extractAssessmentSummary(text).kind !== "prose") return null;
  // Strip a single layer of wrapping quotes the model sometimes adds.
  text = text
    .replace(/^["“”'`]+/, "")
    .replace(/["“”'`]+$/, "")
    .trim();
  text = text.replace(/\s+/g, " ");
  if (!text) return null;
  if (text.length > COACH_NUDGE_AI_MAX_BODY_CHARS) return null;
  // Same outbound content fence the Coach reply path runs: a dose-prescription
  // or a fabricated risk score is rejected, falling back to the template.
  if (screenCoachReply(text, locale).block) return null;
  return text;
}

export const composeNudgeWithAI: ComposeNudgeWithAI = async (params) => {
  const { tickBudget } = params;

  // Per-tick ceiling — count and wall-clock. Exhausted → template.
  if (tickBudget.remainingCount <= 0 || Date.now() >= tickBudget.deadline) {
    return null;
  }

  try {
    const chain = await resolveProviderChain(params.userId);
    if (chain.length === 0) return null;

    // Consent gate — before the budget reservation, so a user without a
    // receipt never spends a slot or a token. Skip-shaped like every other
    // guard here: no receipt → return null and the caller ships the
    // deterministic template, so the nudge itself is never lost. BYOK / local
    // / ChatGPT-OAuth chains are the user's own egress and stay ungated.
    if (
      chainRequiresServerManagedConsent(chain) &&
      !(await hasActiveConsentForSurface(params.userId, "coach"))
    ) {
      annotate({ action: { name: "coach.nudge.ai.consent_required" } });
      return null;
    }

    const budget = AI_BUDGETS.coachNudge;
    const maxTokens = budget.maxTokens ?? 160;
    const dailyCap = resolveDailyCap(chain);
    const dateKey = buildDateKey();

    // Per-user budget gate (atomic reserve; refunds itself on refusal).
    const reservation = await reserveBudget(
      params.userId,
      maxTokens,
      dateKey,
      dailyCap,
      resolveCostOwner(chain),
    );
    if (!reservation.allowed) {
      annotate({ action: { name: "coach.nudge.ai.budget_exceeded" } });
      return null;
    }

    // Committed to a real call — spend a per-tick slot.
    tickBudget.remainingCount -= 1;

    let result;
    try {
      const provider = chain[0].instance;
      result = await provider.generateCompletion(
        singleUserTurn({
          system: buildNudgeSystemPrompt(params.locale),
          user: buildNudgeUserPrompt(params),
          temperature: budget.temperature,
          maxTokens,
          timeoutMs: COACH_NUDGE_AI_CALL_TIMEOUT_MS,
          signal: AbortSignal.timeout(COACH_NUDGE_AI_CALL_TIMEOUT_MS + 1_000),
        }),
      );
    } catch {
      // Timeout / network / provider error → refund what wasn't spent and
      // fall back to the template.
      await reconcileSpend(params.userId, reservation.reserved, 0, dateKey, 0, {
        servedBy: null,
        reservedOwner: reservation.owner,
      }).catch(() => {});
      annotate({ action: { name: "coach.nudge.ai.fallback" } });
      return null;
    }

    await reconcileSpend(
      params.userId,
      reservation.reserved,
      result.tokensUsed ?? 0,
      dateKey,
      result.cachedInputTokens ?? 0,
      { servedBy: chain[0].providerType, reservedOwner: reservation.owner },
    ).catch(() => {});

    const body = sanitiseAiBody(result.content, params.locale);
    if (!body) {
      annotate({ action: { name: "coach.nudge.ai.fallback" } });
      return null;
    }

    annotate({ action: { name: "coach.nudge.ai.composed" } });
    return { title: params.template.title, body };
  } catch {
    // Defensive: any unexpected failure keeps the template.
    return null;
  }
};
