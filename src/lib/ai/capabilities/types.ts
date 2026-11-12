/**
 * AI capabilities: the vocabulary.
 *
 * HealthLog works without AI. Every measurement, device record, computed score,
 * statistic and template sentence is served and accepted whatever the
 * assistant switches, the provider, the consent receipts or the Coach
 * preference say. What those layers decide is narrower: whether a model may be
 * called, and whether text a model wrote may be shown. That decision is made
 * once, on the server, per request and record, and it is published as one
 * object per capability below. Clients render from it and never recompute it.
 *
 * This file holds only the vocabulary and the frozen capability table. It has
 * no I/O and imports nothing that does, so every other part of the system —
 * the resolver, the loader, the route and job gates, the account payload, the
 * contract, the structural guards — can depend on it without pulling a
 * database client along.
 */
import type { AiUsageLevel, AiUsageState } from "@/lib/ai/usage-level";
import type { ModuleKey } from "@/lib/modules/registry";

/** Every AI capability, in publication order. */
export const AI_CAPABILITY_KEYS = [
  "coach",
  "briefing",
  "periodNarrative",
  "statusText",
  "workoutInsights",
  "reactionLines",
  "aboutMeQuestions",
  "documentAi",
  "labsOcr",
  "medicationExtract",
  "supplementLabel",
] as const;

export type AiCapabilityKey = (typeof AI_CAPABILITY_KEYS)[number];

/**
 * Why a capability is unavailable, listed in precedence order: the first
 * reason that applies is the one reported, because it names the layer that
 * would have to change first. The order runs outside-in, like `moduleAccess`
 * (`unavailable > not_granted > disabled`).
 *
 *   - `check_failed`: an input could not be loaded. Fail closed; safe, because
 *     no data depends on a capability.
 *   - `operator_disabled`: the operator's master switch, the capability's own
 *     switch, or the operator's instance-wide availability of its module.
 *   - `not_permitted_for_record`: provider work is not admitted for this record
 *     (a delegate inside somebody else's record).
 *   - `module_disabled`: an owning module is off for this record, by the
 *     record's own switch or by the edge of the active grant.
 *   - `user_disabled`: the record's own AI opt-out: `disableCoach` for the
 *     Coach, the `insights` module ("AI analysis") for everything else.
 *   - `usage_level`: the record's AI usage level (v1.43, #1217) is below the
 *     level the capability needs (`minUsageLevel`). A choice, like the
 *     opt-out, so it ranks right after it and before the provider layers.
 *   - `no_provider`: no configured provider can serve this capability's input.
 *   - `consent_required`: the provider chain needs a consent receipt and none
 *     is active.
 */
export const AI_UNAVAILABLE_REASONS = [
  "check_failed",
  "operator_disabled",
  "not_permitted_for_record",
  "module_disabled",
  "user_disabled",
  "usage_level",
  "no_provider",
  "consent_required",
] as const;

export type AiUnavailableReason = (typeof AI_UNAVAILABLE_REASONS)[number];

/** One capability, resolved for one record. */
export interface AiCapabilityState {
  available: boolean;
  /** `null` exactly when `available` is true. */
  reason: AiUnavailableReason | null;
  /**
   * Whether an on-device model may do this work. The operator's and the
   * person's decisions hold on the device too; a missing server provider or a
   * missing consent receipt for server egress do not, because an on-device
   * model neither needs the one nor egresses. Resolved here so a native client
   * never has to know which reasons are which.
   */
  onDeviceAllowed: boolean;
}

/** The reasons an on-device model is still allowed through. */
export const ON_DEVICE_ALLOWED_REASONS: ReadonlySet<AiUnavailableReason> =
  new Set<AiUnavailableReason>(["no_provider", "consent_required"]);

/**
 * The reasons a route's own provider pick answers exactly: whether there is a
 * provider, and whether sending to it needs a receipt. The resolver answers
 * both from presence, which is right for the published payload; a route that
 * reads the chain in its own order asks again about the provider it picked.
 */
export const PICK_DECIDED_REASONS: ReadonlySet<AiUnavailableReason> =
  new Set<AiUnavailableReason>(["no_provider", "consent_required"]);

/**
 * The operator's assistant switches below the master. Each maps to a cost or
 * egress profile an operator can reason about: the Coach, the daily briefing
 * and period narratives, per-reading status notes (the dominant token spend),
 * and reading documents (the largest egress).
 */
export const AI_OPERATOR_SWITCHES = [
  "coach",
  "briefing",
  "insightStatus",
  "documentAi",
] as const;

export type AiOperatorSwitch = (typeof AI_OPERATOR_SWITCHES)[number];

/**
 * The operator switch set, master applied: when `enabled` is false every
 * sub-switch reads false, so a reader never composes the two.
 */
export type AiOperatorSwitchSet = { enabled: boolean } & Record<
  AiOperatorSwitch,
  boolean
>;

/**
 * Consent receipt kinds the resolver reads. `ai_extraction` is the narrower
 * grant the document auto-read toggle mints; `ai_full` satisfies every group.
 */
export type AiConsentKind =
  "ai_coach" | "ai_insights_only" | "ai_full" | "ai_extraction";

/**
 * When a consent receipt is needed at all.
 *
 *   - `self-snapshot`: only when the chain can egress through a credential the
 *     operator holds (the operator's key or the shared central Codex). A
 *     person's own key, their own ChatGPT account and a local model are their
 *     own egress, and configuring them was the consent act.
 *   - `document`: whenever the input leaves the machine at all. A scanned
 *     letter or a lab report is a document, and sending one to any third-party
 *     service needs an explicit receipt; only a local model stays exempt.
 */
export type AiConsentRule = "self-snapshot" | "document";

/**
 * What a capability hands the model, which decides which providers can serve
 * it. `text` needs any provider; `document` needs one that can read an image,
 * or a text provider paired with the person's in-browser OCR.
 */
export type AiModality = "text" | "document";

/**
 * Which order the provider chain is read in when the capability picks a single
 * provider rather than cascading. The document class prefers local, then the
 * person's own keys, then the operator's key, with the ChatGPT-subscription
 * paths last; the labs scan keeps the chain's own order.
 */
export type AiProviderOrder = "chain" | "document";

export interface AiCapabilityDefinition {
  key: AiCapabilityKey;
  /** The operator sub-switch that covers it; the master covers everything. */
  operatorSwitch: AiOperatorSwitch;
  /**
   * The modules that must be on for this record. `all` needs every one; `any`
   * needs at least one (the about-me questions serve both the Coach and the
   * AI analysis, and either consumer is enough).
   */
  modules: { mode: "all" | "any"; keys: readonly ModuleKey[] };
  /** Consent: when a receipt is needed, and which kinds satisfy it. */
  consent: { rule: AiConsentRule; kinds: readonly AiConsentKind[] };
  modality: AiModality;
  providerOrder: AiProviderOrder;
  /**
   * v1.43 (#1217) — the lowest AI usage level at which the capability is
   * offered. Absent: every level.
   */
  minUsageLevel?: AiUsageLevel;
}

/**
 * The modules whose own switch IS the person's AI opt-out. Turned off by the
 * record, they report `user_disabled`; every other owning module turned off by
 * the record reports `module_disabled`.
 */
export const AI_OPT_OUT_MODULES: ReadonlySet<ModuleKey> = new Set<ModuleKey>([
  "coach",
  "insights",
]);

/**
 * Whether the record has every opt-out module switched off, read from the
 * module map on `/api/auth/me` (a key the map does not carry counts as on).
 * An invitation to set AI up has nothing left to offer then. It does not gate
 * the AI settings themselves: document reading, lab photos and medication
 * extraction belong to other modules and still need a provider and consent.
 */
export function hasOptedOutOfAi(
  modules: Partial<Record<ModuleKey, boolean>> | null | undefined,
): boolean {
  for (const key of AI_OPT_OUT_MODULES) {
    if (modules?.[key] !== false) return false;
  }
  return true;
}

const COACH_KINDS: readonly AiConsentKind[] = ["ai_coach", "ai_full"];
const INSIGHTS_KINDS: readonly AiConsentKind[] = [
  "ai_insights_only",
  "ai_full",
];
const EXTRACTION_KINDS: readonly AiConsentKind[] = ["ai_extraction", "ai_full"];

/**
 * The capability table. Frozen, total over {@link AI_CAPABILITY_KEYS}, and the
 * one place a capability's layers are declared: the resolver, the guards and
 * the contract all read it.
 */
export const AI_CAPABILITIES: Readonly<
  Record<AiCapabilityKey, Readonly<AiCapabilityDefinition>>
> = Object.freeze({
  // Chat, fenced document chat inside a conversation, attachments, memory
  // refresh, AI nudges, and every Coach launcher.
  coach: {
    key: "coach",
    operatorSwitch: "coach",
    modules: { mode: "all", keys: ["coach"] },
    consent: { rule: "self-snapshot", kinds: COACH_KINDS },
    modality: "text",
    providerOrder: "chain",
  },
  // The daily briefing and every place its text is lifted into.
  briefing: {
    key: "briefing",
    operatorSwitch: "briefing",
    modules: { mode: "all", keys: ["insights"] },
    consent: { rule: "self-snapshot", kinds: INSIGHTS_KINDS },
    modality: "text",
    providerOrder: "chain",
  },
  // The model-written half of a period narrative. The deterministic narrative
  // is data and is always produced.
  periodNarrative: {
    key: "periodNarrative",
    operatorSwitch: "briefing",
    modules: { mode: "all", keys: ["insights"] },
    consent: { rule: "self-snapshot", kinds: INSIGHTS_KINDS },
    modality: "text",
    providerOrder: "chain",
  },
  // Per-metric status notes and the AI override of a derived assessment.
  statusText: {
    key: "statusText",
    operatorSwitch: "insightStatus",
    modules: { mode: "all", keys: ["insights"] },
    consent: { rule: "self-snapshot", kinds: INSIGHTS_KINDS },
    modality: "text",
    providerOrder: "chain",
  },
  workoutInsights: {
    key: "workoutInsights",
    operatorSwitch: "insightStatus",
    modules: { mode: "all", keys: ["insights", "workouts"] },
    consent: { rule: "self-snapshot", kinds: INSIGHTS_KINDS },
    modality: "text",
    providerOrder: "chain",
  },
  // The one-line reaction written after a new reading arrives.
  reactionLines: {
    key: "reactionLines",
    operatorSwitch: "insightStatus",
    modules: { mode: "all", keys: ["insights"] },
    consent: { rule: "self-snapshot", kinds: INSIGHTS_KINDS },
    modality: "text",
    providerOrder: "chain",
  },
  // Model-written follow-up questions on the about-me profile. A deterministic
  // fallback set is data and stays.
  aboutMeQuestions: {
    key: "aboutMeQuestions",
    operatorSwitch: "coach",
    modules: { mode: "any", keys: ["coach", "insights"] },
    consent: {
      rule: "self-snapshot",
      kinds: ["ai_coach", "ai_insights_only", "ai_full"],
    },
    modality: "text",
    providerOrder: "chain",
  },
  // Suggest, summary, extract, index and chat over a stored document.
  documentAi: {
    key: "documentAi",
    operatorSwitch: "documentAi",
    modules: { mode: "all", keys: ["inboundDocuments"] },
    consent: { rule: "document", kinds: EXTRACTION_KINDS },
    modality: "document",
    providerOrder: "document",
  },
  // Reading a lab report image into structured results.
  labsOcr: {
    key: "labsOcr",
    operatorSwitch: "documentAi",
    modules: { mode: "all", keys: ["labs"] },
    consent: { rule: "document", kinds: EXTRACTION_KINDS },
    modality: "document",
    providerOrder: "chain",
  },
  // Turning a typed medication description into a structured schedule.
  // Medications is a core domain for this purpose, so no module owns it.
  medicationExtract: {
    key: "medicationExtract",
    operatorSwitch: "documentAi",
    modules: { mode: "all", keys: [] },
    consent: { rule: "document", kinds: EXTRACTION_KINDS },
    modality: "text",
    providerOrder: "chain",
  },
  // v1.43 — reading a supplement's label photo into its ingredients. A photo
  // is a document, and an extra model run per label, so it is not offered on
  // the `frugal` usage level.
  supplementLabel: {
    key: "supplementLabel",
    operatorSwitch: "documentAi",
    modules: { mode: "all", keys: ["medications", "nutrients"] },
    consent: { rule: "document", kinds: EXTRACTION_KINDS },
    modality: "document",
    providerOrder: "document",
    minUsageLevel: "standard",
  },
});

/**
 * Where the provider that would serve a record comes from, presence only.
 *
 *   - `user`: the person's own credential (their key, their ChatGPT account,
 *     their own OpenAI-compatible gateway).
 *   - `local`: a self-hosted model the person pointed at.
 *   - `server`: a credential the operator holds (the operator's key, or the
 *     shared central Codex the person opted into).
 */
export type AiProviderManagedBy = "user" | "local" | "server";

/** Account-level companion to the capability map. */
export interface AiProviderState {
  /** At least one configured provider can serve text for this record. */
  configured: boolean;
  managedBy: AiProviderManagedBy | null;
  /**
   * Whether the person in front of the screen may set up a provider for this
   * record: false inside somebody else's record (delegate or managed profile)
   * and when the operator's master switch is off.
   */
  canConfigure: boolean;
  /**
   * How long one model call on this record may take before the server gives
   * up, in milliseconds: the record's response-timeout setting, else the 60 s
   * default. A surface that waits on a model call (document reads, lab OCR)
   * sizes its own request abort from this plus a margin, so the browser never
   * gives up before the server does. Surfaces with a larger budget of their
   * own (the briefing) may run longer when the setting is unset.
   */
  responseTimeoutMs: number;
}

/**
 * Whose credential an operator-held provider sends through: the operator's
 * API key (`admin-openai`) or the operator's shared ChatGPT account
 * (`admin-codex`).
 */
export type AiConsentRecipientVia = "operator_key" | "operator_chatgpt";

/** One service a record's data would go to on the operator's credential. */
export interface AiConsentRecipient {
  via: AiConsentRecipientVia;
  /**
   * The service, named for a person: "OpenAI" or "Anthropic" for their own
   * endpoints, otherwise the host name of the endpoint the operator set.
   */
  name: string;
}

/**
 * The standing AI consent for the record, as a client renders it.
 *
 *   - `given`: an `ai_full` receipt is active (`since` says when).
 *   - `needed`: the provider chain runs through a credential the operator
 *     holds, and at least one capability is closed by nothing but the missing
 *     receipt. Ask, naming `recipients`.
 *   - `not_needed`: neither. Nothing to ask and nothing to withdraw.
 */
export type AiConsentStatus = "given" | "needed" | "not_needed";

export interface AiConsentState {
  status: AiConsentStatus;
  /** When the active `ai_full` consent was given, ISO-8601; `null` otherwise. */
  since: string | null;
  /** The operator-held services in the chain, in chain order. */
  recipients: AiConsentRecipient[];
}

/** The `ai` block the account payload publishes. */
export interface AiCapabilities {
  capabilities: Record<AiCapabilityKey, AiCapabilityState>;
  provider: AiProviderState;
  /** v1.43.2 — the standing AI consent and who it would cover. */
  consent: AiConsentState;
  /**
   * v1.43 (#1217) — the record's AI usage level, its bounds and the estimate.
   * Absent on servers before v1.43 and on blocks resolved without it.
   */
  usage?: AiUsageState;
}

// ── Refusal codes ──────────────────────────────────────────────────────────
//
// An AI action refused because a capability is unavailable answers with one
// envelope: `{ data: null, error, meta: { errorCode, capability, reason } }`.
// Every published code is kept; the three below are the new ones. The operator
// family stays the `assistant.disabled.<switch>` template, the module family
// stays `module.disabled` (with `meta.module`), and consent stays
// `consent.ai.required`.

/** Provider work is not admitted for this record. */
export const AI_RECORD_NOT_PERMITTED_ERROR_CODE = "ai.record.notPermitted";
/** No configured provider can serve the capability. */
export const AI_PROVIDER_NONE_ERROR_CODE = "ai.provider.none";
/** The capability's inputs could not be loaded; the answer failed closed. */
export const AI_UNAVAILABLE_ERROR_CODE = "ai.unavailable";
/** v1.43 — the record's AI usage level is below what the capability needs. */
export const AI_USAGE_LEVEL_TOO_LOW_ERROR_CODE = "ai.usage.levelTooLow";
