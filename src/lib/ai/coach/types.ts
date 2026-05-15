/**
 * Type contracts shared between the Coach API route, the persistence
 * helpers, and the (forthcoming) drawer UI.
 *
 * The wire format mirrors the chat-completion shape the OpenAI and
 * Anthropic SDKs expect — `role` plus `content` — so the provider chain
 * can pass messages through with minimal translation.
 */
import { z } from "zod/v4";

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
   */
  sources: z.array(coachScopeSourceSchema).max(14).optional(),
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
});

export type CoachChatRequest = z.infer<typeof coachChatRequestSchema>;

/**
 * SSE event shapes emitted by the streaming endpoint.
 *
 * The route writes one `data: <json>\n\n` frame per event. Clients
 * dispatch on `type` and ignore unknown variants — additive evolution.
 */
export type CoachStreamEvent =
  | { type: "token"; token: string }
  | {
      type: "provenance";
      metricSource: CoachProvenance;
    }
  | { type: "done"; conversationId: string; messageId: string }
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
  metrics: ReadonlyArray<
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
  >;
  /**
   * Sample-count summary per metric — opaque labels, no raw timestamps
   * or values. Optional; absent when the snapshot was empty.
   */
  counts?: Partial<
    Record<
      | "bp"
      | "weight"
      | "pulse"
      | "mood"
      | "compliance"
      // ── v1.4.23 Apple Health additive ──
      | "hrv"
      | "sleep"
      | "resting_hr"
      | "steps"
      | "active_energy"
      | "flights"
      | "distance"
      | "vo2_max"
      | "body_temp",
      number
    >
  >;
  /**
   * v1.4.22 — load-bearing numbers the Coach drew on for this turn,
   * surfaced in the collapsible evidence block under the assistant
   * bubble. Optional; omit when the turn was qualitative or when the
   * snapshot was empty. Hard cap 8 entries to keep the block scannable.
   */
  keyValues?: ReadonlyArray<CoachKeyValue>;
}

/**
 * Lightweight DTO the conversation list endpoint returns.
 * Decryption deliberately deferred — the rail only needs metadata.
 */
export interface CoachConversationDTO {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
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
}

export interface CoachConversationDetailDTO extends CoachConversationDTO {
  messages: CoachMessageDTO[];
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
