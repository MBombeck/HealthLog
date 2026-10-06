/**
 * v1.41 — the contract of the Coach's memory inside a turn.
 *
 * The loop and the chat route reach facts and plans only through these
 * functions: the memory block that goes into every turn, the `remember_fact`
 * and `propose_plan` tools, the two decisions a person answers with a tap
 * (`memoryDecision`, `planDecision` on the chat request), and the progress
 * lines the daily briefing quotes.
 *
 * The implementations live beside this file (`context-block.ts`,
 * `remember.ts`, `propose-plan.ts`, `plan-progress.ts`); this module names
 * the shapes and re-exports them, so a caller depends on the contract and
 * never on a file behind it. Server-only: it reaches the database. The
 * client-safe constants and message keys live in `shared.ts`, re-exported
 * here unchanged.
 *
 * Rules every implementation keeps, so a caller can rely on them:
 * - a fact or plan a turn's tool keeps is written with the stored answer that
 *   carries it (`turn-writes.ts`), never by a turn that is blocked, fails or
 *   is abandoned;
 * - model-written plan text passes the outbound screen before it is kept;
 * - health facts (`condition`, `constraint`, `medication`) are only ever
 *   proposed, never saved without the person's tap;
 * - a fact comes from the person's current message, never from a document or
 *   a quote;
 * - the block is built only after the turn has passed its egress check, and
 *   never for a read-only sharing viewer;
 * - fact and plan text never reaches a log or `annotate()`; counts and ids do.
 */
import type { Locale } from "@/lib/i18n/config";
import type {
  CoachMemoryCategory,
  CoachMemoryNote,
  CoachPlanProposal,
} from "@/lib/ai/coach/types";

export * from "./shared";

// ── The memory block ───────────────────────────────────────────────────────

export interface MemoryContextBlock {
  /** The fenced `WHAT YOU KNOW ABOUT THIS PERSON` section; data, not orders. */
  text: string;
  /** The facts in the block, for `last_used_at` and the `memory` entry. */
  factIds: string[];
  planIds: string[];
  /**
   * The fact texts the block carries, for the owner-only trail
   * (`CoachTrail.recalled`). Never logged.
   */
  recalled: string[];
  /**
   * A health fact the background found and the person has not answered yet,
   * offered once: the turn sends it as the answer's `memoryNote` (with
   * `proposal: true`) and stores it as `CoachTrail.proposal`, exactly like a
   * proposal `remember_fact` made. It counts as the answer's one note. Marked
   * offered when the answer carrying it is stored, so it is offered once, and
   * offered again after a turn that never stored one.
   */
  pendingProposal?: CoachMemoryNote;
}

export interface BuildMemoryContextBlockArgs {
  userId: string;
  conversationId: string | undefined;
  locale: string;
  /**
   * The providers the turn is about to send to (the chain, in order). When
   * given, the block re-runs the wire egress check for exactly these and is
   * not built on a refusal; without it, the `coach` capability for the record
   * is re-checked instead.
   */
  providerTypes?: readonly string[];
  now?: Date;
}

// ── remember_fact ──────────────────────────────────────────────────────────

export interface RememberFactCall {
  category: CoachMemoryCategory;
  /** At most `REMEMBER_FACT_MAX_CHARS`. */
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

export interface RememberFactArgs {
  userId: string;
  conversationId: string;
  /** The person's current message, the only text a fact may come from. */
  userMessage: string;
  /**
   * The stored id of that message, for `coach_facts.source_message_id`.
   * Looked up as the conversation's newest user message when absent.
   */
  userMessageId?: string;
  call: RememberFactCall;
}

export type DecideFactProposalOutcome =
  { kind: "saved"; factId: string } | { kind: "declined" } | { kind: "stale" };

export interface DecideFactProposalArgs {
  userId: string;
  conversationId: string;
  messageId: string;
  proposalId: string;
  accept: boolean;
}

// ── propose_plan ───────────────────────────────────────────────────────────

export interface ProposePlanCall {
  metric: string;
  target?: string;
  ifCue: string;
  thenAction: string;
  /** `PLAN_REVIEW_DAYS`. */
  reviewInDays: number;
}

export type ProposePlanOutcome =
  | { kind: "proposed"; proposal: CoachPlanProposal }
  | {
      kind: "declined";
      reason:
        | "one_per_answer"
        | "too_many_open"
        | "invalid"
        | "unsafe"
        | "unavailable";
    };

export interface ProposePlanArgs {
  userId: string;
  conversationId: string;
  /** The person's locale, which the outbound screen reads the plan text in. */
  locale: Locale;
  /**
   * The turn's scheduled doses and medication names, which the screen reads
   * the plan text against; loaded for the person when absent.
   */
  scheduleDoses?: readonly number[];
  medicationNames?: readonly string[];
  call: ProposePlanCall;
}

export type DecidePlanProposalOutcome =
  | { kind: "activated"; reviewInDays: number }
  | { kind: "abandoned" }
  | { kind: "stale" };

export interface DecidePlanProposalArgs {
  userId: string;
  conversationId: string;
  messageId: string;
  planId: string;
  accept: boolean;
}

// ── The implementations ────────────────────────────────────────────────────

/**
 * The facts and active plans a turn starts with, or null when there are none
 * or memory is unavailable. Built only after the egress check passes.
 */
export { buildMemoryContextBlock } from "./context-block";

/**
 * Runs a `remember_fact` call; answers a fact proposal (the fact is read from
 * the trail stored on `messageId`, never from the request).
 */
export { rememberFactFromTool, decideFactProposal } from "./remember";

/**
 * Runs a `propose_plan` call (the plan is written as `proposed` with the
 * answer that carries it, and only after its text passed the outbound
 * screen); answers a plan
 * proposal (`active` on accept, `abandoned` on decline, only a plan the
 * assistant message proposed, only the person's own).
 */
export { proposePlanFromTool, decidePlanProposal } from "./propose-plan";

/**
 * One server-computed progress sentence per active plan, at most two, for
 * the daily briefing prompt. The model may quote one; it may not invent one.
 */
export { buildPlanProgressLines } from "./plan-progress";
