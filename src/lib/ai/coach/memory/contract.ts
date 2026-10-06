/**
 * v1.41 — the contract of the Coach's memory inside a turn.
 *
 * The loop and the chat route reach facts and plans only through these
 * functions: the memory block that goes into every turn, the `remember_fact`
 * and `propose_plan` tools, the two decisions a person answers with a tap
 * (`memoryDecision`, `planDecision` on the chat request), and the progress
 * lines the daily briefing quotes.
 *
 * Until the implementations land, every function is a stub that answers "not
 * available" and touches nothing: no block is built, no fact is written, no
 * plan changes state. A turn behaves exactly as it did before.
 *
 * Rules every implementation keeps, so a caller can rely on them:
 * - health facts (`condition`, `constraint`, `medication`) are only ever
 *   proposed, never saved without the person's tap;
 * - a fact comes from the person's current message, never from a document or
 *   a quote;
 * - the block is built only after the turn has passed its egress check, and
 *   never for a read-only sharing viewer;
 * - fact and plan text never reaches a log or `annotate()`; counts and ids do.
 */
import type {
  CoachMemoryCategory,
  CoachMemoryNote,
  CoachPlanProposal,
} from "@/lib/ai/coach/types";

/** Who put a fact into `coach_facts.source`. */
export const COACH_FACT_SOURCES = [
  "user",
  "coach",
  "extracted",
  "pattern",
] as const;

/** The categories that are proposed and never saved without a tap. */
export const HEALTH_MEMORY_CATEGORIES: ReadonlySet<CoachMemoryCategory> =
  new Set(["condition", "constraint", "medication"]);

/** A remembered fact, as `remember_fact` may write it. */
export const REMEMBER_FACT_MAX_CHARS = 160;

/** The memory block in a turn's context, never trimmed before the inventory. */
export const MEMORY_BLOCK_MAX_CHARS = 1_500;

/** A proposed plan's review window, in days. */
export const PLAN_REVIEW_DAYS = { min: 7, max: 56 } as const;

// ── The memory block ───────────────────────────────────────────────────────

export interface MemoryContextBlock {
  /** The fenced `WHAT YOU KNOW ABOUT THIS PERSON` section; data, not orders. */
  text: string;
  /** The facts in the block, for `last_used_at` and the `memory` entry. */
  factIds: string[];
  planIds: string[];
}

/**
 * The facts and active plans a turn starts with, or null when there are none
 * or memory is unavailable. The caller has already passed the egress check.
 */
export async function buildMemoryContextBlock(_args: {
  userId: string;
  conversationId: string | undefined;
  locale: string;
}): Promise<MemoryContextBlock | null> {
  return null;
}

// ── remember_fact ──────────────────────────────────────────────────────────

export interface RememberFactCall {
  category: CoachMemoryCategory;
  /** At most {@link REMEMBER_FACT_MAX_CHARS}. */
  fact: string;
  why: string;
}

export type RememberFactOutcome =
  | { kind: "saved"; note: CoachMemoryNote }
  | { kind: "proposed"; note: CoachMemoryNote }
  | {
      kind: "declined";
      reason:
        | "duplicate"
        | "not_from_message"
        | "one_per_answer"
        | "invalid"
        | "unavailable";
    };

/**
 * Runs a `remember_fact` call. `userMessage` is the person's current message,
 * the only text a fact may come from.
 */
export async function rememberFactFromTool(_args: {
  userId: string;
  conversationId: string;
  userMessage: string;
  call: RememberFactCall;
}): Promise<RememberFactOutcome> {
  return { kind: "declined", reason: "unavailable" };
}

/**
 * Answers a fact proposal. The fact is read from the trail stored on
 * `messageId`, never from the request.
 */
export async function decideFactProposal(_args: {
  userId: string;
  conversationId: string;
  messageId: string;
  proposalId: string;
  accept: boolean;
}): Promise<
  { kind: "saved"; factId: string } | { kind: "declined" } | { kind: "stale" }
> {
  return { kind: "stale" };
}

// ── propose_plan ───────────────────────────────────────────────────────────

export interface ProposePlanCall {
  metric: string;
  target?: string;
  ifCue: string;
  thenAction: string;
  /** {@link PLAN_REVIEW_DAYS}. */
  reviewInDays: number;
}

export type ProposePlanOutcome =
  | { kind: "proposed"; proposal: CoachPlanProposal }
  | {
      kind: "declined";
      reason: "one_per_answer" | "too_many_open" | "invalid" | "unavailable";
    };

/** Runs a `propose_plan` call: writes the plan as `proposed`. */
export async function proposePlanFromTool(_args: {
  userId: string;
  conversationId: string;
  call: ProposePlanCall;
}): Promise<ProposePlanOutcome> {
  return { kind: "declined", reason: "unavailable" };
}

/**
 * Answers a plan proposal: `active` on accept, `abandoned` on decline. Only a
 * plan the assistant message proposed, and only the person's own.
 */
export async function decidePlanProposal(_args: {
  userId: string;
  conversationId: string;
  messageId: string;
  planId: string;
  accept: boolean;
}): Promise<
  | { kind: "activated"; reviewInDays: number }
  | { kind: "abandoned" }
  | { kind: "stale" }
> {
  return { kind: "stale" };
}

// ── The briefing ───────────────────────────────────────────────────────────

/**
 * One server-computed progress sentence per active plan, at most two, for
 * the daily briefing prompt. The model may quote one; it may not invent one.
 */
export async function buildPlanProgressLines(
  _userId: string,
): Promise<string[]> {
  return [];
}

// ── Message keys ────────────────────────────────────────────────────────────

/** The memory note under an answer, and its two replies. */
export const COACH_MEMORY_KEYS = {
  saved: "insights.coach.memory.saved",
  undo: "insights.coach.memory.undo",
  accept: "insights.coach.memory.accept",
  decline: "insights.coach.memory.decline",
  confirmed: "insights.coach.memory.confirmed",
} as const;

/** A plan proposal's two replies, and the line a decision turn answers with. */
export const COACH_PLAN_KEYS = {
  accept: "insights.coach.plan.accept",
  decline: "insights.coach.plan.decline",
  confirmed: "insights.coach.plan.confirmed",
} as const;

/** The memory list in settings, and the link to it from the Coach. */
export const COACH_MEMORY_LIST_KEYS = {
  link: "insights.coach.memoryLink",
  edit: "settings.coach.memory.edit",
  sourceUser: "settings.coach.memory.source.user",
  sourceCoach: "settings.coach.memory.source.coach",
  categoryMedication: "settings.ai.coachMemory.categoryMedication",
} as const;
