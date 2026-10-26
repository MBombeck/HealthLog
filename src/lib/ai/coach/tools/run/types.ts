/** The shapes the Coach tool executor answers with and is handed. */
import type { Locale } from "@/lib/i18n/config";
import type { CoachResultTable } from "@/lib/ai/coach/types";
import type {
  PriorResultTurn,
  ResultRefAllocator,
} from "@/lib/ai/coach/results/refs";
import type { CoachDomainAvailability } from "../availability";

/** A read-only structured tool result. Serialised to a `role:"tool"` turn. */
export interface CoachToolResult {
  present: boolean;
  /** Short machine reason on a `present: false` result (no PII). */
  reason?: string;
  /** The domain payload on a `present: true` result (the snapshot section). */
  data?: unknown;
  /**
   * Optional citation-coupled reference grounding for the fetched metric —
   * published population bands + the user's placement, general guidance only.
   */
  grounding?: string;
  /** The window an empty read searched, so a miss describes its own scope. */
  searchedWindow?: string;
  /**
   * On a `present: false` result whose reason is `outside_window` /
   * `unavailable_in_scope`: what the record holds for this domain over its whole
   * history — count, date range, and a bounded per-series aggregate. These are
   * server-computed figures the model MAY cite; they ride the authoritative set
   * for the prose number-verifier exactly like a present result's payload.
   */
  available?: CoachDomainAvailability;
  /**
   * The name of the table this call produced (`r1`..`r8`), so the
   * model can mark the prose that relies on it with `result:rN`. Only in a
   * chat turn; absent when no table was made.
   */
  resultRef?: string;
  /**
   * The full table, for the person. NEVER serialised to the model:
   * the loop strips it before the tool-result turn, and the model reads the
   * compact summary in `data` instead. Only in a chat turn.
   */
  table?: CoachResultTable;
}

/**
 * What a chat turn hands the executor so a call can produce a
 * table and name it, and `show_result` can find an earlier one. Absent on
 * every other caller (MCP), which then gets the plain result.
 */
export interface CoachToolTurnContext {
  /** The conversation the turn belongs to, already narrowed to its owner. */
  conversationId: string;
  locale: Locale;
  /** The earlier tables of THIS conversation, as the context named them. */
  priorResults: ReadonlyArray<PriorResultTurn>;
  refs: ResultRefAllocator;
  now?: Date;
}

/** What the route persists onto provenance: which tools ran, did data exist. */
export interface CoachToolTrace {
  name: string;
  present: boolean;
  /**
   * The call's arguments as their schema validated them; absent
   * when they did not validate. Turn-internal (steps, method, chips): never
   * persisted, the provenance keeps `{ name, present }` only.
   */
  args?: Record<string, unknown>;
}
