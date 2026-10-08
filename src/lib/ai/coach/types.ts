/**
 * Type contracts shared between the Coach API route, the persistence
 * helpers, and the (forthcoming) drawer UI.
 *
 * The wire format mirrors the chat-completion shape the OpenAI and
 * Anthropic SDKs expect — `role` plus `content` — so the provider chain
 * can pass messages through with minimal translation.
 */
import { z } from "zod/v4";

import type { AiUnavailableReason } from "@/lib/ai/capabilities/types";
import type { CoachSuggestedAction } from "./suggest-action";
import type { CoachToolName } from "./tools/definitions";

/**
 * Chat-message role. Stored as a free-form string column server-side
 * (`coach_messages.role`) but constrained at the application layer so a
 * malformed import cannot inject a `system` impersonation.
 */
export const coachMessageRoleSchema = z.enum(["user", "assistant"]);

export type CoachMessageRole = z.infer<typeof coachMessageRoleSchema>;

/**
 * Inbound POST /api/insights/chat body.
 *
 * - `conversationId` optional; when absent a new conversation is
 *   created with a title summarised from the user's first message.
 * - `message` is the user's turn. Hard-cap 4 000 chars to keep prompt
 *   budgets sane and to make the prompt-injection scanner cheap.
 * - `prefill` is an optional first-turn nudge from the suggested-prompt
 *   strip (B2b UI). Server treats it as informational only — the
 *   user's `message` is the source of truth.
 * - `locale` lets the route render the refusal copy in the user's
 *   language without having to re-resolve it from cookies.
 */
/**
 * v1.4.20.1 — optional scope picker shipped with the per-source toggles
 * + window selector on the Coach drawer's sources rail. The body lets
 * the user narrow which metrics the snapshot ships and which window the
 * timeline covers. Server defaults fill in any missing field so older
 * native clients keep working — the field is fully back-compat.
 */
export const coachScopeWindowSchema = z.enum([
  "last7days",
  "last30days",
  "last90days",
  // v1.4.27 B7 / BL-P6-4 — long-horizon window for the year-in-review
  // surfaces. Sits between `last90days` and `allTime` so the snapshot
  // builder can sample a denser timeline (one row per week) than the
  // unbounded fallback while still surfacing seasonal patterns.
  "lastYear",
  "allTime",
]);

export const coachScopeSourceSchema = z.enum([
  "bp",
  "weight",
  "pulse",
  "mood",
  "compliance",
  // ── v1.4.23 Apple Health additive ──
  // Optional scope toggles for the new HealthKit metrics. Web-only
  // accounts never carry data for these — `buildCoachSnapshot()` only
  // emits the matching block when Apple-Health rows exist.
  "hrv",
  "sleep",
  "resting_hr",
  "steps",
  "active_energy",
  "flights",
  "distance",
  "vo2_max",
  "body_temp",
  // ── v1.7.0 clustered sources ──
  // Cardiovascular composition / vascular metrics.
  "walking_hr",
  "respiratory_rate",
  "spo2",
  "pulse_wave_velocity",
  "vascular_age",
  // Body composition (mass + ratio metrics beyond plain weight).
  "body_fat",
  "fat_mass",
  "fat_free_mass",
  "muscle_mass",
  "lean_body_mass",
  "bone_mass",
  "total_body_water",
  "bmi",
  "visceral_fat",
  // Metabolic.
  "glucose",
  // Mobility & gait.
  "walking_steadiness",
  "walking_asymmetry",
  "walking_double_support",
  "walking_step_length",
  "walking_speed",
  // Environment / exposure.
  "audio_env",
  "audio_headphone",
  "audio_event",
  "daylight",
  "skin_temp",
  // Workout model (read from the `Workout` table, not `Measurement`).
  "workouts",
]);

export const coachScopeSchema = z.object({
  /**
   * Which sources the snapshot may include. Empty array → no metrics.
   *
   * v1.4.23 — cap raised from 5 to 14 to admit the Apple Health
   * additions. The default-source list (`buildCoachSnapshot.DEFAULT_SOURCES`)
   * still seeds 5 to keep the prompt budget tight for accounts without
   * Apple Health data; iOS clients pass the extended set when they
   * have HealthKit-derived rows.
   *
   * v1.7.0 — cap raised to 40 to admit the full clustered taxonomy
   * (10 clusters expand to ~38 sources). The snapshot's soft
   * char-cap + progressive degradation is the real prompt-budget
   * backstop now, not the source count.
   */
  sources: z.array(coachScopeSourceSchema).max(40).optional(),
  /** Window the day-level timeline covers. Defaults to last30days. */
  window: coachScopeWindowSchema.optional(),
});

export type CoachScope = z.infer<typeof coachScopeSchema>;
export type CoachScopeSource = z.infer<typeof coachScopeSourceSchema>;
export type CoachScopeWindow = z.infer<typeof coachScopeWindowSchema>;

export const coachChatRequestSchema = z.object({
  conversationId: z.string().min(1).max(64).optional(),
  message: z.string().min(1).max(4000),
  prefill: z.string().max(2000).optional(),
  locale: z.enum(["en", "de"]).optional(),
  scope: coachScopeSchema.optional(),
  /**
   * v1.16.6 — guided clarifying-questions flow: the pending question
   * this message answers. The question bubble is client-side only
   * (never persisted), so without this context the model would see a
   * bare answer ("since 2019, with medication") and could not react
   * to it. Rides the prompt as delimited user-provided context; the
   * persisted user turn stays the answer alone.
   */
  guidedQuestion: z.string().min(1).max(500).optional(),
  /**
   * v1.31.0 — a conversation launched from one workout ("Ask why" on the
   * workout-detail page, or `/coach?workout=<id>`). On the FIRST turn the
   * route narrows by `{ id: workoutId, userId }` — the universal tenancy
   * narrow, so a foreign id simply finds nothing — and pins ONE bounded,
   * numbers-only evidence section onto the conversation's snapshot.
   *
   * Snapshot-once is untouched: the client sends this only while
   * `conversationId` is absent, and the route ignores it on every later
   * turn, so per-turn work does not grow with conversation length.
   */
  workoutId: z.string().max(64).optional(),
  /**
   * v1.39.4 — the person tapped a follow-up chip. `messageId` is the
   * assistant message that offered it and `id` the chip on that message
   * (`f1`..`f3`). The server resolves the chip from what it persisted on
   * the conversation's latest assistant message; the client never sends
   * what the chip asks for, only which chip it was. A chip that is no
   * longer current degrades to a plain message.
   */
  followUp: z
    .object({
      messageId: z.string().min(1).max(64),
      id: z.string().min(1).max(8),
    })
    .optional(),
  /**
   * v1.39.4 — the person answered a clarifying question. `messageId` is
   * the assistant message that asked it; `choiceId` the chip they tapped,
   * absent when they typed their own answer instead.
   */
  clarification: z
    .object({
      messageId: z.string().min(1).max(64),
      choiceId: z.string().min(1).max(8).optional(),
    })
    .optional(),
  /**
   * v1.41 — the person answered a fact proposal ("Yes, remember it" / "No").
   * `messageId` is the assistant message that offered it, `proposalId` the
   * proposal on that message. The client never sends the fact: the server
   * reads it from what it stored on that message, so a tap can only accept
   * what the Coach actually proposed.
   */
  memoryDecision: z
    .object({
      messageId: z.string().min(1).max(64),
      proposalId: z.string().min(1).max(64),
      accept: z.boolean(),
    })
    .optional(),
  /**
   * v1.41 — the person answered a plan proposal ("Take on this plan" /
   * "Not now"). `planId` is the proposed plan the assistant message carried;
   * the server holds it to that message and to the person's own plans.
   */
  planDecision: z
    .object({
      messageId: z.string().min(1).max(64),
      planId: z.string().min(1).max(64),
      accept: z.boolean(),
    })
    .optional(),
});

/**
 * v1.18.1 (Workstream C) — a Coach cadence suggestion surfaced as a
 * one-tap action card. The model proposes the cadence via a sentinel
 * block; the server resolves it against the closed cadence catalog and
 * gates it (module-toggle + opt-out + dismissal + cooldown + dedup). When
 * it surfaces, this DTO rides an additive `suggestion` SSE frame AND is
 * persisted onto the assistant message's provenance so the card survives a
 * conversation reload.
 *
 * `cadenceId` is the catalog token; `measurementType` the auto-resolve
 * target; `label` the localised card copy. Accepting the card POSTs to
 * `POST /api/measurement-reminders` with `origin: COACH` + the cadence's
 * server-resolved schedule — the client sends only `cadenceId`, the server
 * looks up the rest, so the client can never widen a cadence.
 */
export interface CoachSuggestion {
  cadenceId: string;
  measurementType: string;
  label: string;
}

/**
 * v1.18.9 — per-turn token-usage envelope carried on the `done` frame
 * (and persisted onto the assistant message). Server-authoritative: the
 * client renders these numbers, never recomputes them. `totalTokens` is
 * the headline count surfaced in the quiet per-message footer; the
 * prompt / completion split is optional (not every provider returns it)
 * and `model` names the provider model that produced the reply.
 */
export interface CoachUsage {
  totalTokens: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  model?: string | null;
}

/**
 * SSE event shapes emitted by the streaming endpoint.
 *
 * The route writes one `data: <json>\n\n` frame per event. Clients
 * dispatch on `type` and ignore unknown variants — additive evolution.
 * The `suggestion` frame (v1.18.1) is additive: older web + iOS clients
 * that don't know it drop it on the floor (the parser keeps only frames
 * whose `type` it handles), so the chat stays backwards-compatible.
 *
 * v1.18.9 — two additive shapes:
 *   - `done.usage` carries the per-turn `CoachUsage` (tokens + model) so
 *     the client can paint the quiet per-message footer the instant the
 *     stream closes; older clients ignore the extra key.
 *   - `reasoning` is an optional frame whose `text` the client renders
 *     inside the thinking disclosure when a reasoning-capable provider
 *     emits a cheap reasoning summary. Providers without reasoning emit
 *     none, and the disclosure falls back to its elapsed-time label.
 *
 * v1.39.4 — four additive frames: `step` (live progress while the Coach
 * reads the record), `result` (a table of the values it read, owner only),
 * `followUps` (chips under the latest reply) and `clarification` (a
 * question with choices). Frame order on a turn:
 *
 *   step* → token* → provenance → result* → suggestion? →
 *   suggestedAction? → clarification? → followUps? → done
 *
 * v1.41 — three more additive frames: `activity` (the live trail: one
 * entry per phase of the turn, upserted by id), `memoryNote` (a fact the
 * Coach saved or proposes to save) and `planProposal` (a plan it proposes).
 * `result` may carry `interim: true` while the turn still runs, and `done`
 * carries `stop` when the answer was forced and `withheldResults` when the
 * interim tables must be taken down again. The `reasoning` frame stays
 * accepted and is never sent. Frame order:
 *
 *   (activity | step)* → token* → provenance → result* → suggestion? →
 *   suggestedAction? → memoryNote? → planProposal? → clarification? →
 *   followUps? → done
 *
 * No new frame carries a top-level key the older native client decodes
 * (`token`, `conversationId`, `messageId`, `code`, `message`, `suggestion`,
 * `metricSource`, `usage`), so an older client drops them whole.
 * `src/__tests__/coach-stream-ios-compat.test.ts` holds that rule, and the
 * Zod mirror in `stream-events.ts` is held equal to this union by a type
 * test.
 */
export type CoachStreamEvent =
  | { type: "token"; token: string }
  | {
      type: "provenance";
      metricSource: CoachProvenance;
    }
  | { type: "suggestion"; suggestion: CoachSuggestion }
  | { type: "suggestedAction"; suggestedAction: CoachSuggestedAction }
  | { type: "reasoning"; text: string }
  | {
      type: "done";
      conversationId: string;
      messageId: string;
      usage?: CoachUsage;
      /** v1.41 — why the answer was forced, when it was. */
      stop?: CoachStop;
      /**
       * v1.41 — the turn was blocked after interim tables went out; the
       * client removes them.
       */
      withheldResults?: true;
    }
  | {
      type: "error";
      code: string;
      message: string;
      /**
       * The AI capability reason, when the refusal came from one (today only
       * `no_provider` on `coach.provider.none`). Additive: older clients
       * ignore it.
       */
      reason?: AiUnavailableReason;
    }
  | { type: "step"; step: CoachStep }
  | {
      type: "result";
      result: CoachResultTable;
      /**
       * v1.41 — sent while the turn still runs, right after the call that
       * read it. The answer decides later whether it is shown or sits under
       * "Data used".
       */
      interim?: true;
    }
  | { type: "followUps"; followUps: CoachFollowUp[] }
  | { type: "clarification"; clarification: CoachClarification }
  | { type: "activity"; activity: CoachActivity }
  | { type: "memoryNote"; note: CoachMemoryNote }
  | { type: "planProposal"; proposal: CoachPlanProposal };

// ── Activity (v1.41) ────────────────────────────────────────────────────
// The live trail of a turn: what the Coach is doing right now, one entry per
// phase. The metadata is plaintext and persisted on `metricSource.activity`;
// the model-written `title` and `text` reach only the owner and are stored
// encrypted in `coach_messages.trail_encrypted`.

export type CoachActivityPhase =
  | "thinking"
  | "memory"
  | "fetch"
  | "digest"
  | "checkpoint"
  | "remember"
  | "plan"
  | "asking"
  | "stop"
  | "answer";

/** Why the loop forced its final answer. */
export type CoachStopReason = "budget" | "time" | "cap" | "no_progress";

export interface CoachStop {
  reason: CoachStopReason;
  /** The rounds the turn ran, the final one included. */
  rounds: number;
}

/** Plaintext; rides `metricSource.activity`. */
export interface CoachActivityMeta {
  /** `a1`..`a99`, unique within a turn; frames upsert by id. */
  id: string;
  phase: CoachActivityPhase;
  status: CoachStepStatus;
  /** The tool round the entry belongs to, from 1. */
  round: number;
  /** Closed catalog key (`insights.coach.activity.*`). */
  labelKey: string;
  /**
   * The label rendered on the server in the request locale. Always catalog
   * text with server-chosen values, never model text.
   */
  label: string;
  /** The `step` a `fetch` entry stands for (`s1`..). */
  stepRef?: string;
  /** Readings, lookups or remembered entries the server counted. */
  count?: number;
  durationMs?: number;
  /** Set on the `stop` entry. */
  stop?: CoachStopReason;
}

/** One trail entry on the wire: the metadata plus the owner-only model text. */
export interface CoachActivity extends CoachActivityMeta {
  /** A screened reasoning title or checkpoint sentence, at most 80 chars. */
  title?: string;
  /** A screened reasoning summary for the round, at most 400 chars. */
  text?: string;
}

// ── Memory and plans (v1.41) ────────────────────────────────────────────

/**
 * The categories a Coach fact is filed under. The extraction's list in
 * `facts.ts` plus `medication`, which only the in-turn `remember_fact` tool
 * and the remember button write. `condition`, `constraint` and `medication`
 * are health facts: never saved without the person's tap.
 */
export const COACH_MEMORY_CATEGORIES = [
  "preference",
  "goal",
  "context",
  "condition",
  "constraint",
  "medication",
] as const;

export type CoachMemoryCategory = (typeof COACH_MEMORY_CATEGORIES)[number];

/** Plaintext; rides `metricSource.memoryNote`. No fact text. */
export interface CoachMemoryNoteMeta {
  /**
   * `true`: a proposal waiting for the person ("Yes, remember it" / "No"),
   * answered with `memoryDecision`. `false`: already saved, undone by
   * deleting `factId`.
   */
  proposal: boolean;
  /** The proposal on this message (`proposal: true`). */
  proposalId?: string;
  /** The saved fact (`proposal: false`). */
  factId?: string;
  category: CoachMemoryCategory;
}

/** On the wire, owner only: the metadata plus the fact itself. */
export interface CoachMemoryNote extends CoachMemoryNoteMeta {
  /** The fact as it will be stored, at most 160 chars. */
  fact: string;
}

/** Plaintext; rides `metricSource.planProposal`. No plan text. */
export interface CoachPlanProposalMeta {
  /** The `CoachPlan` row, written as `proposed`. */
  planId: string;
  /** The metric the plan moves, e.g. `WEIGHT`. */
  metric: string;
  /** 7..56. */
  reviewInDays: number;
}

/** On the wire, owner only: the metadata plus the plan's own words. */
export interface CoachPlanProposal extends CoachPlanProposalMeta {
  ifCue: string;
  thenAction: string;
  target?: string;
}

/**
 * v1.41 — the decrypted `coach_messages.trail_encrypted` of one message, as
 * `GET …/messages/{messageId}/trail` serves it to the owner. Model text and
 * fact text only; the structure lives in `metricSource`.
 */
export interface CoachTrail {
  /** Title and text per activity entry, by `CoachActivityMeta.id`. */
  entries: Array<{ id: string; title?: string; text?: string }>;
  /** The facts recalled into the turn (the `memory` entry). */
  recalled?: string[];
  /** The fact proposal's text, which a `memoryDecision` reads back. */
  proposal?: {
    proposalId: string;
    category: CoachMemoryCategory;
    fact: string;
  };
}

// ── Steps (v1.39.4) ─────────────────────────────────────────────────────
// What the Coach is reading while a turn runs. Labels come from a closed
// catalog; a step never carries free text, an analyte name, or a value.

export type CoachStepStatus = "running" | "done" | "empty" | "failed";

/**
 * The data domain a step, result or chip is about. The measurement-backed
 * scope sources plus the domains that are read as a whole.
 */
export type CoachStepDomain =
  | CoachScopeSource
  | "labs"
  | "illness"
  | "cycle"
  | "correlations"
  | "environment"
  | "snapshot";

/** Why a step or a method entry found nothing. */
export type CoachStepReason =
  | "no_data"
  | "outside_window"
  | "module_disabled"
  | "retrieval_failed"
  | "invalid_arguments";

export interface CoachStep {
  /** `s1`..`s64`, unique within a turn; frames upsert by id. */
  id: string;
  tool: CoachToolName | "show_result" | "snapshot";
  /** Closed catalog key, e.g. `coach.step.read`. */
  labelKey: string;
  /** The label rendered on the server in the request locale; the fallback. */
  label: string;
  domain?: CoachStepDomain;
  window?: CoachScopeWindow;
  period?: CoachResultPeriod;
  granularity?: CoachResultGranularity;
  status: CoachStepStatus;
  /** Readings or rows the server counted. Never a health value. */
  count?: number;
  reason?: CoachStepReason;
  /** `r1` when the step produced a table. */
  resultRef?: string;
}

// ── Results (v1.39.4) ───────────────────────────────────────────────────
// A table of the values a turn read. The values are health data: encrypted
// at rest (`coach_messages.results_encrypted`) and sent only to the owner.
// The metadata alone rides the plaintext provenance.

export type CoachResultGranularity = "day" | "week" | "month";
export type CoachResultPeriod = "current" | "previous" | "yearAgo";
export type CoachResultShape =
  "timeSeries" | "categoryCounts" | "distribution" | "single";

export interface CoachResultColumn {
  key: string;
  kind: "period" | "category" | "number" | "count";
  labelKey: string;
  label: string;
  /** Display unit token (e.g. `mmHg`), never free text. */
  unit?: string;
  decimals?: number;
}

/** `null` is a period with no reading: absence stays explicit. */
export type CoachResultCell = string | number | null;

export type CoachChartSpec =
  | { kind: "line"; x: string; series: string[] }
  | {
      /**
       * v1.41 — two series on one chart: two periods overlaid (`periods`,
       * one axis) or two metrics side by side (`metrics`, one or two axes).
       * `a` and `b` name the value columns, `x` the shared column.
       */
      kind: "compare";
      mode: "periods" | "metrics";
      x: string;
      a: string;
      b: string;
      axes: 1 | 2;
    }
  | {
      kind: "bar";
      x: string;
      series: string[];
      orientation: "vertical" | "horizontal";
    }
  | {
      kind: "histogram";
      column: string;
      unit?: string;
      bins: Array<{ from: number; to: number; count: number }>;
    };

export interface CoachResultSource {
  tool: CoachToolName;
  domain: CoachStepDomain;
  window: CoachScopeWindow;
  period: CoachResultPeriod;
  granularity?: CoachResultGranularity;
}

/** Plaintext; rides `metricSource.results`. */
export interface CoachResultMeta {
  /** `r1`..`r8`, per message. */
  ref: string;
  source: CoachResultSource;
  shape: CoachResultShape;
  titleKey: string;
  title: string;
  /** The full row count, before any trim. */
  rowCount: number;
  chartKind: CoachChartSpec["kind"] | null;
  /** The answer referenced it (shown expanded) or it sits under "Data used". */
  displayed: boolean;
  /** Set when the table was copied from an earlier message of the thread. */
  reusedFrom?: { messageId: string; ref: string };
  /**
   * v1.39.4 — `table` when the answer asked for the table view of a table
   * that has a chart ("as a table"). The chart stays, so the other view is
   * one tap away. Absent: the chart shows first when there is one.
   */
  view?: "table";
}

/** Encrypted at rest; on the wire only to the owner. */
export interface CoachResultTable extends CoachResultMeta {
  columns: CoachResultColumn[];
  /** Row-major, at most 400 rows. */
  rows: CoachResultCell[][];
  /** True when `rowCount` exceeds `rows.length`. */
  truncated: boolean;
  chart: CoachChartSpec | null;
}

/**
 * One entry of `GET …/messages/{messageId}/results`: the table, or the
 * reason it is not served. `module_disabled` — the domain's module is now
 * off for the record; `unavailable` — the stored tables could not be read.
 */
export type CoachResultEntry =
  | CoachResultTable
  | { ref: string; withheld: "module_disabled" | "unavailable" };

// ── Method (v1.39.4) ────────────────────────────────────────────────────
// How the answer was reached: sources, windows, counts, aggregation. Never
// a health value.

export interface CoachMethodEntry {
  domain: CoachStepDomain;
  window?: CoachScopeWindow;
  period?: CoachResultPeriod;
  granularity?: CoachResultGranularity;
  count?: number;
  aggregation?: "mean" | "median" | "latest" | "sum" | "count" | "rate";
  absent?: "no_data" | "outside_window" | "module_disabled";
}

export interface CoachMethod {
  entries: CoachMethodEntry[];
  /** Rendered on the server in the request locale. */
  text: string;
}

// ── Follow-ups (v1.39.4) ────────────────────────────────────────────────
// Chips under the latest assistant reply. The label is always rendered by
// the server from a catalog; the model may at most pick a kind and domain.

export type CoachFollowUpKind =
  | "widen_window"
  | "previous_period"
  | "year_ago"
  | "as_chart"
  | "as_table"
  | "related_metric"
  | "continue"
  | "change_assumption";

export interface CoachFollowUp {
  /** `f1`..`f3`. */
  id: string;
  kind: CoachFollowUpKind;
  labelKey: string;
  label: string;
  anchor?: {
    ref: string;
    domain: CoachStepDomain;
    window?: CoachScopeWindow;
    granularity?: CoachResultGranularity;
    period?: CoachResultPeriod;
  };
  /** True when the chip is answered from a stored table, without a model. */
  reuse: boolean;
  origin: "server" | "model";
  /**
   * v1.41 — on a `change_assumption` chip: the assumption it replaces and
   * the alternative it picks.
   */
  assumption?: { kind: CoachAssumptionKind; value: CoachChoiceValue };
}

// ── Clarification (v1.39.4) ─────────────────────────────────────────────
// A question with choices. The question text is the assistant message
// itself, encrypted like any reply; only the choices ride here.

/** v1.41 — what a comparison is drawn against. */
export type CoachComparisonBasis =
  "previous_period" | "year_ago" | "baseline_90d";

/**
 * What a choice stands for. One field per kind; `goal` and `anchor` are ids
 * of the person's own plans, facts or record events, never text.
 */
export interface CoachChoiceValue {
  metric?: CoachScopeSource;
  window?: CoachScopeWindow;
  /** v1.41 */
  comparison?: CoachComparisonBasis;
  /** v1.41 — an active plan or a goal fact. */
  goal?: string;
  /** v1.41 — a medication start, an illness episode, a cycle phase. */
  anchor?: string;
}

export interface CoachClarificationChoice {
  id: string;
  labelKey: string;
  label: string;
  value: CoachChoiceValue;
}

export type CoachClarificationKind =
  "metric" | "window" | "comparison" | "goal" | "anchor" | "context";

export interface CoachClarification {
  /** `comparison`, `goal` and `anchor` since v1.41. */
  kind: CoachClarificationKind;
  /** At most 4; metric choices are always ones the record holds. */
  choices: CoachClarificationChoice[];
  /** Whether a typed answer is welcome beside the choices. */
  freeText: boolean;
  /**
   * v1.41 — the choice that applies when the person does not answer (`c1`..);
   * the question names it, and it is the first choice.
   */
  assumption?: string;
}

// ── Assumptions (v1.41) ─────────────────────────────────────────────────
// What an answer assumed instead of asking. Catalog values only, at most two
// per answer; each offers its alternatives as `change_assumption` chips.

export type CoachAssumptionKind = "metric" | "window" | "comparison";

export interface CoachAssumptionOption {
  labelKey: string;
  label: string;
  value: CoachChoiceValue;
}

export interface CoachAssumption {
  kind: CoachAssumptionKind;
  value: CoachAssumptionOption;
  /** At most 3. */
  alternatives: CoachAssumptionOption[];
}

/**
 * v1.4.22 — Zod schema for one entry inside the Coach's evidence
 * block. The model emits these as lines between the
 * `---KEYVALUES---` / `---END---` sentinels at the end of the reply;
 * the route parses them out of the prose, attaches them to the
 * provenance envelope, and the UI renders them inside the collapsible
 * "Worauf bezieht sich das?" disclosure.
 *
 * Every field is length-capped so a malformed or adversarial sentinel
 * cannot blow up the persisted payload. The whole block is also
 * hard-capped to 8 entries / 1 KB by the parser.
 */
export const coachKeyValueSchema = z.object({
  label: z.string().min(1).max(80),
  value: z.string().min(1).max(40),
  unit: z.string().max(16).optional(),
  window: z.string().max(40).optional(),
});

export type CoachKeyValue = z.infer<typeof coachKeyValueSchema>;

/**
 * Stable provenance metric keys — the source-chip + evidence row read
 * these and translate them client-side. `general` is the empty-snapshot
 * sentinel; everything else is a real metric topic.
 *
 * v1.7.0 — extended to mirror the clustered source taxonomy so the
 * chips + counts reflect every block the snapshot can now emit. Each
 * `CoachScopeSource` that produces a snapshot block has a matching key
 * here; `workouts` doubles as both a scope source and a provenance
 * metric (it reads the `Workout` model rather than `Measurement`).
 */
export type CoachProvenanceMetric =
  | "bp"
  | "weight"
  | "pulse"
  | "mood"
  | "compliance"
  | "general"
  // ── v1.4.23 Apple Health additive ──
  | "hrv"
  | "sleep"
  | "resting_hr"
  | "steps"
  | "active_energy"
  | "flights"
  | "distance"
  | "vo2_max"
  | "body_temp"
  // ── v1.7.0 clustered additions ──
  | "walking_hr"
  | "respiratory_rate"
  | "spo2"
  | "pulse_wave_velocity"
  | "vascular_age"
  | "body_fat"
  | "fat_mass"
  | "fat_free_mass"
  | "muscle_mass"
  | "lean_body_mass"
  | "bone_mass"
  | "total_body_water"
  | "bmi"
  | "visceral_fat"
  | "glucose"
  | "walking_steadiness"
  | "walking_asymmetry"
  | "walking_double_support"
  | "walking_step_length"
  | "walking_speed"
  | "audio_env"
  | "audio_headphone"
  | "audio_event"
  | "daylight"
  | "skin_temp"
  | "workouts";

/**
 * Provenance envelope attached to assistant messages.
 *
 * NOTE: labels only — never raw values from the snapshot itself. The
 * `keyValues` field added in v1.4.22 carries the load-bearing numbers
 * the model chose to surface; those values come from the model's reply
 * (which is itself grounded in the SNAPSHOT) and stay in the
 * persisted `metricSourceJson` alongside the windows + metrics +
 * counts so the disclosure can re-render on conversation reload.
 */
export interface CoachProvenance {
  /**
   * Time windows the assistant drew on. Same enum the strict insight
   * schema uses elsewhere so the UI can pin a mini-chart to the chip.
   */
  windows: ReadonlyArray<
    "last7days" | "last30days" | "last90days" | "lastYear" | "allTime"
  >;
  /**
   * Metric topics referenced. Stable contract keys — translated by the
   * UI, never by the server.
   *
   * v1.4.23 — extended with the seven Apple Health categories landed in
   * Wave 2 (HRV, sleep, resting HR, steps, active energy, flights,
   * distance, VO2 max, body temp). Web-only accounts never see those
   * values; the prompt's GROUND RULE 12 tells the model to treat the
   * tokens as additive rather than required.
   */
  metrics: ReadonlyArray<CoachProvenanceMetric>;
  /**
   * Sample-count summary per metric — opaque labels, no raw timestamps
   * or values. Optional; absent when the snapshot was empty.
   */
  counts?: Partial<Record<CoachProvenanceMetric, number>>;
  /**
   * v1.4.22 — load-bearing numbers the Coach drew on for this turn,
   * surfaced in the collapsible evidence block under the assistant
   * bubble. Optional; omit when the turn was qualitative or when the
   * snapshot was empty. Hard cap 8 entries to keep the block scannable.
   */
  keyValues?: ReadonlyArray<CoachKeyValue>;
  /**
   * v1.18.1 (Workstream C) — a cadence suggestion attached to this turn.
   * Persisted alongside the message so the one-tap action card re-renders
   * on a conversation reload. Absent on turns that carry no suggestion.
   */
  suggestion?: CoachSuggestion;
  /**
   * v1.22 (F6) — a generalised confirm→apply action card attached to this turn
   * (`checkup.create` / `reminder.note`, closed allowlist). Persisted alongside
   * the message so the card re-renders on a conversation reload. Absent on turns
   * that carry no action.
   */
  suggestedAction?: CoachSuggestedAction;
  /**
   * v1.20.0 (F1) — the retrieval-tool trace for this turn: which tools the
   * Coach called and whether each found data (`present`). Metadata only — no
   * raw values beyond what `keyValues` already persists. Lets a conversation
   * reload show "what I looked at" and lets the hallucination audit replay
   * grounding. Absent on the legacy snapshot path + on turns that called no
   * tools.
   */
  toolCalls?: ReadonlyArray<{ name: string; present: boolean }>;
  /**
   * v1.32.9 (Coach Guard II / G2) — the bare numeric magnitudes THIS turn's
   * tool trace produced (server-computed figures the model was shown, never the
   * model's own prose). A later turn re-registers them into the Grounding
   * Ledger as `transcript:tool-trace`, so a figure the model fetched earlier
   * reconciles when it is recalled — without the ledger ever reading assistant
   * prose (D3). Label-less: strictly less identifying than `keyValues`, which
   * already persists cited values. Absent when the turn fetched no figures.
   */
  groundedFigures?: ReadonlyArray<number>;
  /**
   * v1.32.14 — the count of numeric tokens the post-hoc grounding guard withheld
   * from this reply (each rewritten to the editorial elision mark `[…]`). Drives
   * the quiet per-message "some figures couldn't be checked" notice under the
   * bubble. COUNT ONLY, never the withheld values — same privacy posture as the
   * rest of the plaintext `metricSourceJson` envelope. Absent (omitted) when the
   * turn withheld nothing.
   */
  unverifiedFigures?: number;
  /**
   * v1.39.4 — what the Coach read on this turn, one entry per tool call (or
   * one `snapshot` step on the no-tools path). Catalog labels, domains,
   * windows and counts only.
   */
  steps?: CoachStep[];
  /** v1.39.4 — how the answer was reached, as a server-rendered line. */
  method?: CoachMethod;
  /**
   * v1.39.4 — the tables this turn produced, metadata only. The values are
   * in `results_encrypted` and served by
   * `GET /api/insights/chat/{id}/messages/{messageId}/results`.
   */
  results?: CoachResultMeta[];
  /** v1.39.4 — the chips offered under this reply. */
  followUps?: CoachFollowUp[];
  /** v1.39.4 — the choices, when this reply is a clarifying question. */
  clarification?: CoachClarification;
  /**
   * v1.39.4 — the tool loop hit its round cap while the model still wanted
   * to read, so the answer was forced. Absent otherwise.
   */
  forcedFinal?: true;
  /**
   * v1.39.4 — this reply continues an answer that was forced at the round
   * cap: the id of that earlier assistant message. A continuation offers no
   * further "keep looking" chip, so an answer is continued at most once.
   */
  continuationOf?: string;
  /** v1.41 — the turn's trail, metadata only; the text is behind `…/trail`. */
  activity?: CoachActivityMeta[];
  /** v1.41 — why the answer was forced, when it was. */
  stop?: CoachStop;
  /** v1.41 — what the answer assumed instead of asking, at most two. */
  assumptions?: CoachAssumption[];
  /** v1.41 — the fact this reply saved or proposes, without its text. */
  memoryNote?: CoachMemoryNoteMeta;
  /** v1.41 — the plan this reply proposes, without its text. */
  planProposal?: CoachPlanProposalMeta;
}

/**
 * Lightweight DTO the conversation list endpoint returns.
 * Decryption deliberately deferred — the rail only needs metadata.
 */
/**
 * v1.29.x (S7) — one document attached to a coach conversation. `documentId` is
 * the join row's document; `title` is its resolved label (its `title`, falling
 * back to `filename`), plaintext (same posture as the document title column), no
 * health values. The client renders one pill per attachment.
 */
export interface CoachConversationAttachmentDTO {
  documentId: string;
  title: string | null;
}

/** Maximum user-visible length for generated and explicitly renamed titles. */
export const COACH_CONVERSATION_TITLE_MAX = 80;

export interface CoachConversationDTO {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /**
   * v1.29.x (S7) — the sticky fence flag (`coach_conversations.document_scoped`).
   * true = a FENCED thread: its turns route through the hardened fenced endpoint
   * (no tools, no health snapshot), never the tool route. false = a normal Coach
   * thread (health-record surface). Server-derived from the row; never a client
   * input. This flag is PERMANENT — once true it is never cleared, even after
   * every attachment is detached or deleted.
   */
  fenced: boolean;
  /**
   * v1.29.x (S7) — the LIVE set of documents attached to this thread (join rows).
   * Empty on a health thread, and possibly empty on a fenced thread whose
   * attachments were all detached/deleted (the flag stays true). Absent on the
   * lightweight create DTO (the reads resolve the labels).
   */
  attachments?: CoachConversationAttachmentDTO[];
  /**
   * v1.29.x (S7) — the FIRST attachment's resolved title, kept for the rail's
   * single-line badge (paperclip + title). Null on a health thread or a fenced
   * thread with no live attachment.
   */
  documentTitle?: string | null;
}

/**
 * Full conversation DTO — every message decrypted in memory before
 * the route serialises the response. Provenance is plain text on disk
 * so it round-trips without a key.
 */
export interface CoachMessageDTO {
  id: string;
  role: CoachMessageRole;
  content: string;
  createdAt: string;
  metricSource: CoachProvenance | null;
  providerType: string | null;
  promptVersion: string | null;
  /**
   * v1.18.9 — total tokens the assistant turn cost, persisted so the
   * quiet per-message footer survives a conversation reload. Null on
   * older messages (pre-feature) and on user turns / refusals where no
   * token count was recorded.
   */
  tokensUsed: number | null;
  /**
   * v1.18.9 — the provider model that produced the reply (e.g.
   * `gpt-4o`), persisted alongside `tokensUsed` for the footer. Null
   * when unknown (user turns, refusals, older rows).
   */
  model: string | null;
}

export interface CoachConversationDetailDTO extends CoachConversationDTO {
  messages: CoachMessageDTO[];
  /**
   * v1.11.1 — decrypted rolling summary of the turns elided past the history
   * window, or null when none is on file / it could not be decrypted.
   */
  summary?: string | null;
  /**
   * v1.29.x (S7) — the count of LIVE attachment rows. The tool route's
   * defense-in-depth guard reads this: a `documentScoped: false` fetch that
   * nonetheless carries an attachment is flag/join drift → fail closed (404 +
   * `insights.coach.fence_drift` audit). Equal to `attachments.length`.
   */
  attachmentCount: number;
  /**
   * v1.39.4 — server-internal: the assistant messages older than the loaded
   * window, when the turn asked for the count. Never sent to a client.
   */
  earlierAssistantMessages?: number;
}

/**
 * Pagination cursor for the list endpoint. `nextCursor` is the id of
 * the last conversation in the current page, or `null` when the caller
 * has reached the end.
 */
export interface CoachConversationsPage {
  conversations: CoachConversationDTO[];
  nextCursor: string | null;
}
