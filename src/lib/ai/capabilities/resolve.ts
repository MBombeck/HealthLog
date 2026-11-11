/**
 * The AI capability resolver: pure, total, no I/O.
 *
 * Every layer that can say no to AI work is an input here, and each can only
 * subtract. The answer per capability is one of `available` or the OUTERMOST
 * reason that applies (precedence in {@link AI_UNAVAILABLE_REASONS}), because
 * that is the layer the reader would have to change first. Nothing in this
 * file reads a database, a clock, a request or an environment variable; the
 * loader (`./load.ts`) gathers the inputs and this decides.
 *
 * Deliberately NOT an input: budgets and rate limits. They move minute to
 * minute, and a cached payload that published them would be wrong by the time
 * a client acted on it. They stay a per-call refusal with their own codes.
 */
import { documentProviderRank } from "@/lib/documents/provider-rank";
import {
  PROVIDER_DEFAULT_TIMEOUT_MS,
  resolveEffectiveTimeoutMs,
} from "@/lib/ai/effective-timeout";
import {
  isExternalProvider,
  isOperatorHeldProvider,
} from "@/lib/ai/provider-egress";
import { usageLevelAtLeast, type AiUsageLevel } from "@/lib/ai/usage-level";
import type { ModuleKey } from "@/lib/modules/registry";
import type { ModuleAccessState } from "@/lib/sharing/module-disclosure";

import {
  AI_CAPABILITIES,
  AI_CAPABILITY_KEYS,
  AI_OPT_OUT_MODULES,
  AI_UNAVAILABLE_REASONS,
  ON_DEVICE_ALLOWED_REASONS,
  type AiCapabilities,
  type AiCapabilityDefinition,
  type AiCapabilityKey,
  type AiCapabilityState,
  type AiConsentRecipient,
  type AiConsentState,
  type AiOperatorSwitchSet,
  type AiProviderManagedBy,
  type AiProviderState,
  type AiUnavailableReason,
} from "./types";

/** One configured provider in the chain, presence only. */
export interface ProviderEntryPresence {
  /** The chain tag: `openai`, `anthropic`, `local`, `admin-openai`, … */
  providerType: string;
  /** Whether the entry's model can read an image. */
  vision: boolean;
}

/**
 * What the provider chain for a record looks like, without building a client,
 * refreshing a token or touching the network. Already narrowed by the
 * provider-work authority: a delegate's chain is empty, a guardian's is the
 * operator's key alone.
 */
export interface ProviderPresence {
  /** Usable entries in chain order, the central Codex and the picked gateway included. */
  entries: readonly ProviderEntryPresence[];
  /** The person's in-browser OCR opt-in, which lets a text-only provider read a document. */
  localOcrEnabled: boolean;
  managedBy: AiProviderManagedBy | null;
  /**
   * Every chain tag whose credential is present, whether or not the person
   * enabled it in their chain: what a chain editor may offer as able to
   * answer. Absent reads as none, so a hand-built presence offers nothing.
   */
  availableTypes?: readonly string[];
  /**
   * The record's `aiResponseTimeoutSeconds`, read off the same row. Not a
   * presence fact, but the account payload publishes the effective timeout
   * beside the provider and this row is already in hand. Absent → unset.
   */
  responseTimeoutSeconds?: number | null;
  /**
   * The base URL behind the operator's key (`admin-openai`), which names the
   * service the consent card asks about. Absent reads as OpenAI's own
   * endpoint, the column's default.
   */
  operatorKeyBaseUrl?: string | null;
}

/** Whose record this is, as far as configuring a provider for it goes. */
export type AiRecordKind = "self" | "shared" | "managed";

export interface AiCapabilityInputs {
  /** Operator switches, master already applied. */
  switches: AiOperatorSwitchSet;
  /** Per-module access for the record, as `moduleAccess` publishes it. */
  moduleAccess: Readonly<Record<ModuleKey, ModuleAccessState>>;
  /** Whether provider work is admitted for this record at all. */
  providerWorkAdmitted: boolean;
  provider: ProviderPresence;
  /** Kinds of the record's active (non-revoked) consent receipts. */
  activeConsentKinds: ReadonlySet<string>;
  recordKind: AiRecordKind;
  /**
   * v1.43 (#1217) — the record's AI usage level in effect. The loader always
   * sets it; absent (a hand-built set of inputs) means no level restriction.
   */
  usageLevel?: AiUsageLevel;
  /**
   * When the record's active `ai_full` receipt was signed. Absent or `null`
   * with `ai_full` among the active kinds publishes the consent without a date.
   */
  fullConsentSince?: Date | null;
}

// Which tags are operator-held and which stays local: `@/lib/ai/provider-egress`,
// the list the consent gate reads too.

const REASON_RANK: ReadonlyMap<AiUnavailableReason, number> = new Map(
  AI_UNAVAILABLE_REASONS.map((reason, index) => [reason, index]),
);

function outermost(
  reasons: readonly (AiUnavailableReason | null)[],
): AiUnavailableReason | null {
  let best: AiUnavailableReason | null = null;
  for (const reason of reasons) {
    if (reason === null) continue;
    if (best === null || REASON_RANK.get(reason)! < REASON_RANK.get(best)!) {
      best = reason;
    }
  }
  return best;
}

function innermost(
  reasons: readonly (AiUnavailableReason | null)[],
): AiUnavailableReason | null {
  let best: AiUnavailableReason | null = null;
  for (const reason of reasons) {
    if (reason === null) continue;
    if (best === null || REASON_RANK.get(reason)! > REASON_RANK.get(best)!) {
      best = reason;
    }
  }
  return best;
}

function moduleReason(
  key: ModuleKey,
  access: ModuleAccessState,
): AiUnavailableReason | null {
  switch (access) {
    case "enabled":
      return null;
    // The operator's instance-wide availability is an operator decision.
    case "unavailable":
      return "operator_disabled";
    // The edge of the active grant: the record's configuration, as far as
    // this session may see it.
    case "not_granted":
      return "module_disabled";
    case "disabled":
      return AI_OPT_OUT_MODULES.has(key) ? "user_disabled" : "module_disabled";
  }
}

interface ModuleFinding {
  reason: AiUnavailableReason | null;
  /** The owning module the reason is about, when it is about one. */
  module: ModuleKey | null;
}

/**
 * The module layer for one capability. `all` needs every owning module and
 * reports the outermost reason among those that are off. `any` needs one: it
 * is available as soon as one path is, and otherwise reports the INNERMOST
 * reason, because moving that one layer is enough to open the capability.
 */
function modulesFinding(
  def: AiCapabilityDefinition,
  moduleAccess: Readonly<Record<ModuleKey, ModuleAccessState>>,
): ModuleFinding {
  const { mode, keys } = def.modules;
  const findings: ModuleFinding[] = keys.map((key) => ({
    reason: moduleReason(key, moduleAccess[key] ?? "unavailable"),
    module: key,
  }));
  const closed = findings.filter((finding) => finding.reason !== null);
  if (closed.length === 0) return { reason: null, module: null };
  if (mode === "any" && closed.length < findings.length) {
    return { reason: null, module: null };
  }
  const pick = mode === "all" ? outermost : innermost;
  const reason = pick(closed.map((finding) => finding.reason!));
  return closed.find((finding) => finding.reason === reason)!;
}

/** The entries in the order this capability would pick from. */
function orderedEntries(
  def: AiCapabilityDefinition,
  entries: readonly ProviderEntryPresence[],
): readonly ProviderEntryPresence[] {
  if (def.providerOrder === "chain") return entries;
  // A stable sort keeps the person's own order within a rank.
  return [...entries].sort(
    (a, b) =>
      documentProviderRank(a.providerType) -
      documentProviderRank(b.providerType),
  );
}

/**
 * The single provider a document read would use, or null when none can. The
 * first vision-capable entry wins; failing that, a text-only provider reads the
 * text the person's in-browser OCR produced, if they turned that on.
 */
function documentPick(
  def: AiCapabilityDefinition,
  provider: ProviderPresence,
): ProviderEntryPresence | null {
  const ordered = orderedEntries(def, provider.entries);
  const vision = ordered.find((entry) => entry.vision);
  if (vision) return vision;
  if (provider.localOcrEnabled && ordered.length > 0) return ordered[0]!;
  return null;
}

function providerReason(
  def: AiCapabilityDefinition,
  provider: ProviderPresence,
): AiUnavailableReason | null {
  if (def.modality === "document") {
    return documentPick(def, provider) === null ? "no_provider" : null;
  }
  return provider.entries.length === 0 ? "no_provider" : null;
}

/** Does serving this capability need a consent receipt? */
function consentNeeded(
  def: AiCapabilityDefinition,
  provider: ProviderPresence,
): boolean {
  if (def.consent.rule === "self-snapshot") {
    // A cascade may fall through to any entry, so one operator-held entry
    // anywhere in the chain is enough to need the receipt.
    return provider.entries.some((entry) =>
      isOperatorHeldProvider(entry.providerType),
    );
  }
  if (def.modality === "document") {
    // Document reads call the one picked provider, no cascade.
    const pick = documentPick(def, provider);
    return pick !== null && isExternalProvider(pick.providerType);
  }
  // Text under the document rule cascades like a snapshot does, so any entry
  // that leaves the machine needs the receipt.
  return provider.entries.some((entry) =>
    isExternalProvider(entry.providerType),
  );
}

/**
 * Whether sending to exactly these providers needs a receipt under the
 * capability's consent rule. The egress re-check asks it about the providers a
 * route actually picked, so the answer at the wire comes from the same rule the
 * published capability does. Pass the one picked provider for a single-pick
 * read, or the whole chain for a cascade.
 */
export function consentNeededForProviders(
  key: AiCapabilityKey,
  providerTypes: readonly string[],
): boolean {
  return consentNeeded(AI_CAPABILITIES[key], {
    // Every entry named here is one the route will send to, so each counts as
    // able to read the input.
    entries: providerTypes.map((providerType) => ({
      providerType,
      vision: true,
    })),
    localOcrEnabled: false,
    managedBy: null,
  });
}

function consentReason(
  def: AiCapabilityDefinition,
  provider: ProviderPresence,
  activeKinds: ReadonlySet<string>,
): AiUnavailableReason | null {
  if (!consentNeeded(def, provider)) return null;
  return def.consent.kinds.some((kind) => activeKinds.has(kind))
    ? null
    : "consent_required";
}

/** Whether the record's usage level is below what the capability needs. */
function usageReason(
  def: AiCapabilityDefinition,
  level: AiUsageLevel | undefined,
): AiUnavailableReason | null {
  if (def.minUsageLevel === undefined || level === undefined) return null;
  return usageLevelAtLeast(level, def.minUsageLevel) ? null : "usage_level";
}

function stateFor(reason: AiUnavailableReason | null): AiCapabilityState {
  if (reason === null) {
    return { available: true, reason: null, onDeviceAllowed: true };
  }
  return {
    available: false,
    reason,
    onDeviceAllowed: ON_DEVICE_ALLOWED_REASONS.has(reason),
  };
}

/** Why one capability is unavailable, with the module it is about. */
export interface AiCapabilityFinding {
  reason: AiUnavailableReason | null;
  /**
   * The owning module behind a module-layer reason (`module_disabled`,
   * `user_disabled`, or an `operator_disabled` that came from the operator's
   * module availability rather than a switch). `null` otherwise.
   */
  module: ModuleKey | null;
}

/**
 * The full finding for one capability. `null` inputs mean the loader failed.
 * The refusal envelope reads the module to name `module.disabled` correctly;
 * everything else only needs the state.
 */
export function explainAiCapability(
  key: AiCapabilityKey,
  inputs: AiCapabilityInputs | null,
): AiCapabilityFinding {
  if (inputs === null) return { reason: "check_failed", module: null };
  const def = AI_CAPABILITIES[key];
  const { switches } = inputs;
  const switchReason: AiUnavailableReason | null =
    !switches.enabled || !switches[def.operatorSwitch]
      ? "operator_disabled"
      : null;
  const modules = modulesFinding(def, inputs.moduleAccess);
  const reason = outermost([
    switchReason,
    inputs.providerWorkAdmitted ? null : "not_permitted_for_record",
    modules.reason,
    usageReason(def, inputs.usageLevel),
    providerReason(def, inputs.provider),
    consentReason(def, inputs.provider, inputs.activeConsentKinds),
  ]);
  // The switch outranks a module the operator also turned off: name the
  // module only when the switch is not what closed it.
  const aboutModule =
    reason !== null && reason === modules.reason && switchReason === null;
  return { reason, module: aboutModule ? modules.module : null };
}

/** Resolve one capability. `null` inputs mean the loader failed. */
export function resolveAiCapability(
  key: AiCapabilityKey,
  inputs: AiCapabilityInputs | null,
): AiCapabilityState {
  return stateFor(explainAiCapability(key, inputs).reason);
}

/** Resolve every capability. `null` inputs resolve all to `check_failed`. */
export function resolveAiCapabilities(
  inputs: AiCapabilityInputs | null,
): Record<AiCapabilityKey, AiCapabilityState> {
  const out = {} as Record<AiCapabilityKey, AiCapabilityState>;
  for (const key of AI_CAPABILITY_KEYS) {
    out[key] = resolveAiCapability(key, inputs);
  }
  return out;
}

/** The account-level provider block. */
export function resolveAiProviderState(
  inputs: AiCapabilityInputs | null,
): AiProviderState {
  if (inputs === null) {
    return {
      configured: false,
      managedBy: null,
      canConfigure: false,
      responseTimeoutMs: PROVIDER_DEFAULT_TIMEOUT_MS,
    };
  }
  return {
    configured: inputs.provider.entries.length > 0,
    managedBy: inputs.provider.managedBy,
    canConfigure: inputs.recordKind === "self" && inputs.switches.enabled,
    responseTimeoutMs: resolveEffectiveTimeoutMs(
      inputs.provider.responseTimeoutSeconds,
      PROVIDER_DEFAULT_TIMEOUT_MS,
    ),
  };
}

const OPERATOR_KEY_DEFAULT_HOST = "api.openai.com";

/** The service behind the operator's key, named for a person. */
function operatorKeyServiceName(baseUrl: string | null | undefined): string {
  let host = OPERATOR_KEY_DEFAULT_HOST;
  if (baseUrl) {
    try {
      host = new URL(baseUrl).hostname.toLowerCase();
    } catch {
      host = baseUrl;
    }
  }
  if (host === "openai.com" || host.endsWith(".openai.com")) return "OpenAI";
  if (host === "anthropic.com" || host.endsWith(".anthropic.com")) {
    return "Anthropic";
  }
  return host;
}

function consentRecipients(provider: ProviderPresence): AiConsentRecipient[] {
  const out: AiConsentRecipient[] = [];
  for (const entry of provider.entries) {
    if (!isOperatorHeldProvider(entry.providerType)) continue;
    const recipient: AiConsentRecipient =
      entry.providerType === "admin-codex"
        ? { via: "operator_chatgpt", name: "ChatGPT (OpenAI)" }
        : {
            via: "operator_key",
            name: operatorKeyServiceName(provider.operatorKeyBaseUrl),
          };
    if (!out.some((seen) => seen.via === recipient.via)) out.push(recipient);
  }
  return out;
}

/**
 * The standing consent. `needed` only where asking would open something: the
 * chain runs through an operator-held credential and a capability under that
 * rule is closed by the missing receipt alone (its outermost reason is
 * `consent_required`). A capability the operator or the person switched off
 * reports that layer instead, so a record with nothing to open is not asked.
 */
function resolveAiConsentState(
  inputs: AiCapabilityInputs | null,
  capabilities: Readonly<Record<AiCapabilityKey, AiCapabilityState>>,
): AiConsentState {
  if (inputs === null) {
    return { status: "not_needed", since: null, recipients: [] };
  }
  const recipients = consentRecipients(inputs.provider);
  if (inputs.activeConsentKinds.has("ai_full")) {
    return {
      status: "given",
      since: inputs.fullConsentSince?.toISOString() ?? null,
      recipients,
    };
  }
  const blockedByConsentAlone = AI_CAPABILITY_KEYS.some(
    (key) =>
      AI_CAPABILITIES[key].consent.rule === "self-snapshot" &&
      capabilities[key].reason === "consent_required",
  );
  return {
    status:
      recipients.length > 0 && blockedByConsentAlone ? "needed" : "not_needed",
    since: null,
    recipients,
  };
}

/** The whole `ai` block. */
export function resolveAiBlock(
  inputs: AiCapabilityInputs | null,
): AiCapabilities {
  const capabilities = resolveAiCapabilities(inputs);
  return {
    capabilities,
    provider: resolveAiProviderState(inputs),
    consent: resolveAiConsentState(inputs, capabilities),
  };
}
