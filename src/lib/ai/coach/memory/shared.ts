/**
 * v1.41 — the client-safe half of the Coach memory contract: the limits, the
 * closed source and category sets, and the message keys the memory note, the
 * plan replies and the memory list render.
 *
 * `contract.ts` re-exports all of it next to the server functions, so server
 * code keeps one import. A client component imports from here: `contract.ts`
 * reaches the database and must never enter a browser bundle.
 *
 * Client-safe: no server import.
 */
import type { CoachMemoryCategory } from "@/lib/ai/coach/types";

/**
 * What `coach_facts.source` holds. `user` (the remember button, or a proposal
 * the person confirmed), `coach` (saved during a turn), `extracted` (the
 * background extraction, and every row written before the column existed),
 * `pattern` (the deterministic matcher). `proposed` is a health fact the
 * background found and the person has not answered yet: it is never used in
 * a turn and never listed, only offered once as a proposal, and it expires
 * after {@link PROPOSAL_EXPIRY_DAYS}.
 */
export const COACH_FACT_SOURCES = [
  "user",
  "coach",
  "extracted",
  "pattern",
  "proposed",
] as const;

export type CoachFactSource = (typeof COACH_FACT_SOURCES)[number];

/** The source of a fact that waits for the person's answer. */
export const PROPOSED_FACT_SOURCE = "proposed" satisfies CoachFactSource;

/** The categories that are proposed and never saved without a tap. */
export const HEALTH_MEMORY_CATEGORIES: ReadonlySet<CoachMemoryCategory> =
  new Set(["condition", "constraint", "medication"]);

/** A remembered fact, as `remember_fact` may write it. */
export const REMEMBER_FACT_MAX_CHARS = 160;

/** The memory block in a turn's context, never trimmed before the inventory. */
export const MEMORY_BLOCK_MAX_CHARS = 1_500;

/** A proposed plan's review window, in days. */
export const PLAN_REVIEW_DAYS = { min: 7, max: 56 } as const;

/** Open plan proposals one person may hold at a time. */
export const MAX_OPEN_PLAN_PROPOSALS = 3;

/** An unanswered plan or fact proposal lapses after this many days. */
export const PROPOSAL_EXPIRY_DAYS = 14;

// ── Message keys ────────────────────────────────────────────────────────────

/** The memory note under an answer, and its two replies. */
export const COACH_MEMORY_KEYS = {
  saved: "insights.coach.memory.saved",
  undo: "insights.coach.memory.undo",
  accept: "insights.coach.memory.accept",
  decline: "insights.coach.memory.decline",
  confirmed: "insights.coach.memory.confirmed",
  declined: "insights.coach.memory.declined",
} as const;

/** A plan proposal's two replies, and the line a decision turn answers with. */
export const COACH_PLAN_KEYS = {
  accept: "insights.coach.plan.accept",
  decline: "insights.coach.plan.decline",
  confirmed: "insights.coach.plan.confirmed",
  declined: "insights.coach.plan.declined",
} as const;

/** The memory list in settings, and the link to it from the Coach. */
export const COACH_MEMORY_LIST_KEYS = {
  link: "insights.coach.memoryLink",
  edit: "settings.coach.memory.edit",
  sourceUser: "settings.coach.memory.source.user",
  sourceCoach: "settings.coach.memory.source.coach",
  categoryMedication: "settings.ai.coachMemory.categoryMedication",
} as const;
