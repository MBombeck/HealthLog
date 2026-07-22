/**
 * Type contracts shared between the Coach API route, the persistence
 * helpers, and the (forthcoming) drawer UI.
 *
 * The wire format mirrors the chat-completion shape the OpenAI and
 * Anthropic SDKs expect — `role` plus `content` — so the provider chain
 * can pass messages through with minimal translation.
 */
import { z } from "zod/v4";

import type { CoachSuggestedAction } from "./suggest-action";

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
    }
  | { type: "error"; code: string; message: string };

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
