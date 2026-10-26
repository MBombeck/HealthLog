/**
 * The AI capability gates: how a route or a job asks whether it may call a
 * model, or serve text a model wrote.
 *
 *   - `requireAiCapability(key)`: AI action routes (they call a model or
 *     enqueue a job that will). Call it right after auth, before rate limits
 *     and body parsing; it throws `AiUnavailableError`, which `apiHandler`
 *     turns into the refusal envelope.
 *   - `getAiCapability(key)`: mixed reads that serve data plus optional model
 *     text. Never throws; returns the state so the route can null the model
 *     field and say why.
 *   - `aiCapabilityForJob(userId, key)`: workers, before they build a
 *     snapshot. No request context, so the record comes in as an argument and
 *     the authority is the worker's own.
 *
 * Data routes never import this file. A measurement, a score, a statistic or
 * a device record does not depend on AI.
 *
 * The refusal envelope keeps every code a shipped client branches on:
 *
 *   403 { data: null, error, meta: { errorCode, capability, reason, module? } }
 *
 *   operator_disabled         → `assistant.disabled.<switch>`, or
 *                               `module.disabled` + `meta.module` when the
 *                               operator's module availability closed it
 *   not_permitted_for_record  → `ai.record.notPermitted`
 *   module_disabled           → `module.disabled` + `meta.module`
 *   user_disabled             → `module.disabled` + `meta.module`
 *   no_provider               → the route's own typed code where a client
 *                               already reads one, otherwise
 *                               `ai.provider.none`; 422
 *   consent_required          → `consent.ai.required`
 *   check_failed              → `ai.unavailable`; 503
 */
import { findActiveGrant } from "@/lib/sharing/grant-access";
import { resolveGrantSections } from "@/lib/sharing/grant-view";
import { getEvent } from "@/lib/logging/context";
import { providerWorkAuthorityForRecord } from "@/lib/sharing/provider-work-authority";

import { loadAiCapabilityInputs, type AiCapabilityScope } from "./load";
import { explainAiCapability, resolveAiCapability } from "./resolve";
import { AiUnavailableError, type NoProviderRefusal } from "./refusal";
import {
  PICK_DECIDED_REASONS,
  type AiCapabilityKey,
  type AiCapabilityState,
} from "./types";

export interface AiGateOptions {
  /**
   * The record to resolve for. Defaults to the record this request resolved
   * (`acting_as`, else the caller).
   */
  recordId?: string;
  /** The route's own `no_provider` refusal, where a client already reads it. */
  noProvider?: NoProviderRefusal;
  /**
   * Leave `no_provider` and `consent_required` to the provider the route
   * actually picks. The resolver answers both from presence, which is right
   * for the published payload but can differ from a route that reads the
   * chain in its own order (a text-mode document read takes the chain head,
   * not the first vision entry). A route that sets this must run the pick
   * through `assertAiEgress` / `aiEgressRefusal`, which answers both exactly.
   */
  pickDecides?: boolean;
}

/**
 * The scope of the current request: the record it resolved, the authority
 * stamped for it, and the sections the grant opens. `null` outside a request
 * that authenticated anybody.
 */
async function requestScope(
  recordOverride?: string,
): Promise<AiCapabilityScope | null> {
  const auth = getEvent()?.getAuth();
  const actorId = auth?.user_id;
  if (!actorId) return null;
  const recordId = recordOverride ?? auth.acting_as ?? actorId;
  const authority = providerWorkAuthorityForRecord(recordId);
  if (recordId === actorId) {
    return { recordId, authority, sections: null, recordKind: "self" };
  }
  // Inside somebody else's record: mask modules to what the grant opens, as
  // the account payload does. `null` sections are an unscoped grant; a grant
  // that cannot be found opens nothing.
  const grant = await findActiveGrant({
    grantorId: recordId,
    granteeId: actorId,
  });
  return {
    recordId,
    authority,
    sections: grant ? resolveGrantSections(grant.scopeJson) : [],
    recordKind: authority?.origin === "guardian" ? "managed" : "shared",
  };
}

/**
 * A mixed read's question: may this request serve this capability? Never
 * throws; a request with no authenticated caller reads `check_failed`.
 */
export async function getAiCapability(
  key: AiCapabilityKey,
  options: Pick<AiGateOptions, "recordId"> = {},
): Promise<AiCapabilityState> {
  try {
    const scope = await requestScope(options.recordId);
    if (scope === null) return resolveAiCapability(key, null);
    return resolveAiCapability(key, await loadAiCapabilityInputs(scope));
  } catch {
    return resolveAiCapability(key, null);
  }
}

/**
 * An AI action's gate. Returns the (available) state, or throws
 * `AiUnavailableError` with the outermost reason.
 */
export async function requireAiCapability(
  key: AiCapabilityKey,
  options: AiGateOptions = {},
): Promise<AiCapabilityState> {
  let finding: ReturnType<typeof explainAiCapability>;
  try {
    const scope = await requestScope(options.recordId);
    finding = explainAiCapability(
      key,
      scope === null ? null : await loadAiCapabilityInputs(scope),
    );
  } catch {
    finding = { reason: "check_failed", module: null };
  }
  if (
    finding.reason !== null &&
    !(options.pickDecides && PICK_DECIDED_REASONS.has(finding.reason))
  ) {
    throw new AiUnavailableError(
      key,
      finding.reason,
      finding.module,
      options.noProvider,
    );
  }
  return { available: true, reason: null, onDeviceAllowed: true };
}

/**
 * A worker's gate. Resolves for `userId` under the worker's own authority
 * (the authority the job was enqueued with, or `system`), with the whole
 * record in view. Never throws.
 */
export async function aiCapabilityForJob(
  userId: string,
  key: AiCapabilityKey,
): Promise<AiCapabilityState> {
  try {
    const inputs = await loadAiCapabilityInputs({
      recordId: userId,
      authority: providerWorkAuthorityForRecord(userId),
      sections: null,
      recordKind: "self",
    });
    return resolveAiCapability(key, inputs);
  } catch {
    return resolveAiCapability(key, null);
  }
}

/**
 * One capability for one record, from wherever the caller runs. Inside an
 * authenticated request it is the request's view (masked to the active grant,
 * memoised with every other capability read of the request); outside one it
 * is the worker's view under the worker's own authority.
 *
 * For code that serves stored model text on both paths: a status note read on
 * a page visit and the same read inside the nightly batch must answer the same
 * question without the caller knowing which path it is on.
 */
export async function aiCapabilityForRecord(
  recordId: string,
  key: AiCapabilityKey,
): Promise<AiCapabilityState> {
  return getEvent()?.getAuth()?.user_id
    ? getAiCapability(key, { recordId })
    : aiCapabilityForJob(recordId, key);
}

/**
 * Whether text a model already wrote for a record may be SHOWN, answered from
 * the record's own state, whoever is reading.
 *
 * Serving stored text and starting model work are different questions. A
 * delegate inside somebody else's record may not start model work there
 * (`not_permitted_for_record`: no generation, no warm, no chat on the owner's
 * key), but reads the owner's stored briefing, narrative, status notes and
 * workout notes exactly when the owner would. So this resolves the record's
 * operator switches, its modules and AI opt-outs, its provider and its
 * consent, under the record's own authority (`system`, as a job would, which
 * also answers a managed profile correctly), unmasked by the viewer's grant.
 *
 * Use it only to decide whether stored model text is served. Anything that
 * generates, warms or enqueues asks `getAiCapability` / `requireAiCapability`
 * (the viewer's view) instead. Never throws.
 */
export async function aiCapabilityToServe(
  recordId: string,
  key: AiCapabilityKey,
): Promise<AiCapabilityState> {
  try {
    const inputs = await loadAiCapabilityInputs({
      recordId,
      authority: {
        origin: "system",
        recordUserId: recordId,
        actorUserId: null,
        grantId: null,
      },
      sections: null,
      recordKind: "self",
    });
    return resolveAiCapability(key, inputs);
  } catch {
    return resolveAiCapability(key, null);
  }
}
