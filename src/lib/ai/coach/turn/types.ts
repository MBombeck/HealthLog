/**
 * Shared shapes of one Coach chat turn (`POST /api/insights/chat`).
 *
 * The turn runs as a pipeline: resolve the conversation, assemble the
 * context, resolve the provider chain, reserve the budget, then — inside the
 * SSE stream — run the model, guard the reply, surface the cards, build the
 * provenance, persist, and emit. Each step lives in its own module under
 * `src/lib/ai/coach/turn/`; these are the values that pass between them.
 *
 * Deliberately free of the tool registry and the snapshot builder, so the
 * wire modules (`sse.ts`, `errors.ts`) can import from here without pulling
 * either into their import graph.
 */
import type { Locale } from "@/lib/i18n/config";
import type { CoachTurn } from "@/lib/ai/coach/chat-request-builder";
import type { PriorResultTurn } from "@/lib/ai/coach/results/refs";
import type { LatestMessagesLoader } from "@/lib/ai/coach/latest-messages";
import type { CoachSuggestedAction } from "@/lib/ai/coach/suggest-action";
import type {
  CoachClarification,
  CoachFollowUp,
  CoachMemoryNote,
  CoachPlanProposal,
  CoachProvenance,
  CoachResultTable,
  CoachScope,
  CoachStop,
  CoachStreamEvent,
  CoachSuggestion,
} from "@/lib/ai/coach/types";

/** The validated request, narrowed to the caller, ready for the pipeline. */
export interface TurnInput {
  userId: string;
  locale: Locale;
  /** The request's abort signal, threaded into every provider call. */
  signal: AbortSignal;
  conversationId: string | undefined;
  message: string;
  scope: CoachScope | undefined;
  guidedQuestion: string | undefined;
  workoutId: string | undefined;
  /** v1.39.4 — the follow-up chip this message came from, if any. */
  followUp: { messageId: string; id: string } | undefined;
  /** v1.39.4 — the clarifying question this message answers, if any. */
  clarification: { messageId: string; choiceId?: string } | undefined;
  /** v1.41 — the fact proposal this message answers with a tap, if any. */
  memoryDecision?: { messageId: string; proposalId: string; accept: boolean };
  /** v1.41 — the plan proposal this message answers with a tap, if any. */
  planDecision?: { messageId: string; planId: string; accept: boolean };
  /**
   * v1.41 — gives back the person's turn slot (at most two turns at once).
   * The route takes the slot; the pipeline gives it back when the turn is
   * over, however it ended.
   */
  releaseSlot?: () => void;
  /**
   * The `coach` capability gate, re-run at the egress site. Owned by the
   * route (the capability inventory reads it there); returns the refusal
   * response, or null when the Coach is still available.
   */
  recheckCapability: () => Promise<Response | null>;
}

/** The conversation a turn continues (or the one it just created). */
export interface TurnConversation {
  conversationId: string;
  priorTurns: CoachTurn[];
  /**
   * v1.32.9 (Coach Guard II / G2) — cross-turn Grounding Ledger sources. Prior
   * USER messages (numbers the user themselves stated) and the persisted
   * per-turn tool figures of prior turns (`groundedFigures` — server-computed
   * magnitudes, NEVER the assistant's prose, per D3). Both feed reconciliation
   * so a figure recalled a turn later is not stripped, without a laundering
   * path through assistant narration.
   */
  priorUserMessages: string[];
  priorToolFigures: number[];
  /**
   * v1.11.1 — rolling summary of the elided older turns, read stale-while-
   * revalidate; null for a fresh conversation or when none is on file.
   */
  priorSummary: string | null;
  /**
   * v1.39.4 — the earlier assistant messages that hold tables, with the
   * names the turn's context gives them. Absent or empty on a new
   * conversation.
   */
  priorResults?: PriorResultTurn[];
  /**
   * v1.39.4 — the turn's one read of the conversation's newest messages,
   * shared by the chip, clarification, "keep looking" and repeat-question
   * checks. Absent on a new conversation.
   */
  latestMessages?: LatestMessagesLoader;
}

/**
 * The client-visible frame channel of one turn. Created inside
 * `createSseStream` and threaded to the model step, so a step can put a frame
 * on the wire while the turn is still running.
 */
export interface TurnEmitter {
  emit(frame: CoachStreamEvent): void;
  /** True once the consumer cancelled the stream (client disconnect). */
  aborted(): boolean;
}

/** What the in-stream producer hands back for client-visible emission. */
export type ReplyOutcome =
  | {
      ok: true;
      replyText: string;
      provenance: CoachProvenance;
      suggestion: CoachSuggestion | null;
      action: CoachSuggestedAction | null;
      /** v1.39.4 — tables streamed after the provenance, owner only. */
      results: CoachResultTable[];
      /** v1.39.4 — the chips under the reply. */
      followUps: CoachFollowUp[];
      /** v1.39.4 — the choices, when the reply is a question. */
      clarification: CoachClarification | null;
      messageId: string;
      totalTokens: number;
      model: string | null;
      /** v1.41 — the fact this reply saved or proposes, owner only. */
      memoryNote?: CoachMemoryNote | null;
      /** v1.41 — the plan this reply proposes, owner only. */
      planProposal?: CoachPlanProposal | null;
      /** v1.41 — why the answer was forced, when it was. */
      stop?: CoachStop;
      /** v1.41 — interim tables went out and the reply was blocked. */
      withheldResults?: boolean;
    }
  | { ok: false; code: string };
