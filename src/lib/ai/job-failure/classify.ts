/**
 * #1404 — what a background AI failure was, in the closed codes of
 * `./types.ts`. Read from the thrown value's tags and from the failure kinds
 * the provider calls already classify (`failure-kind.ts`), never from a
 * message: nothing free-form can reach a stored code.
 *
 * Pure apart from `providerFailureKind`, which only inspects the value.
 */
import type { AiUnavailableReason } from "@/lib/ai/capabilities/types";
import {
  isTimeoutFailure,
  providerFailureKind,
  type ProviderFailureKind,
} from "@/lib/ai/failure-kind";

import type { AiJobFailureCode } from "./types";

const UNREACHABLE_KINDS: ReadonlySet<ProviderFailureKind> = new Set([
  "private_host",
  "dns",
  "refused",
  "unreachable",
  "reset",
  "socket",
  "tls",
  "network",
]);

/** One failed provider call, as the witness and a chain hop record it. */
export interface ProviderCallFailure {
  failure: ProviderFailureKind | undefined;
  httpStatus: number | null;
}

/** The code for one failed provider call; null for a cancelled one. */
export function codeForProviderCall(
  call: ProviderCallFailure,
): AiJobFailureCode | null {
  const { failure, httpStatus } = call;
  if (failure === "aborted") return null;
  if (httpStatus === 401 || httpStatus === 403) return "credential_expired";
  if (httpStatus === 429) return "rate_limited";
  if (failure === "empty_response") return "provider_empty";
  if (failure === "reasoning_only") return "provider_reasoning_only";
  if (failure === "paused") return "provider_paused";
  if (failure !== undefined && isTimeoutFailure(failure)) {
    return "provider_timeout";
  }
  if (failure !== undefined && UNREACHABLE_KINDS.has(failure)) {
    return "provider_unreachable";
  }
  return "provider_error";
}

/**
 * The code for a run of failed calls with no success after them: the one code
 * they share, `provider_unreachable` for a mix of timeouts and unreachable
 * hosts (a stopped local model times out on one hop and refuses on the next),
 * else `provider_error`. A rejected key on the first call names the key.
 */
export function codeForProviderCalls(
  calls: readonly ProviderCallFailure[],
): AiJobFailureCode | null {
  const codes = calls
    .map(codeForProviderCall)
    .filter((code): code is AiJobFailureCode => code !== null);
  if (codes.length === 0) return null;
  if (codes[0] === "credential_expired") return "credential_expired";
  if (codes.every((code) => code === codes[0])) return codes[0]!;
  if (
    codes.every(
      (code) => code === "provider_timeout" || code === "provider_unreachable",
    )
  ) {
    return "provider_unreachable";
  }
  return "provider_error";
}

/** The code for a capability refusal. */
export function codeForRefusal(reason: AiUnavailableReason): AiJobFailureCode {
  switch (reason) {
    case "no_provider":
      return "no_provider";
    case "consent_required":
      return "consent_required";
    case "not_permitted_for_record":
      return "not_permitted";
    default:
      return "check_failed";
  }
}

/**
 * Refusals that are somebody's decision, not a failure: the operator's
 * switches, a module or the AI analysis turned off, a usage level below the
 * work. Nothing is recorded for them; the surfaces that own those switches
 * already say they are off.
 */
export const DELIBERATE_REFUSALS: ReadonlySet<AiUnavailableReason> =
  new Set<AiUnavailableReason>([
    "operator_disabled",
    "module_disabled",
    "user_disabled",
    "usage_level",
  ]);

/** A capability refusal carried by a thrown value, or null. */
export function refusalOf(error: unknown): AiUnavailableReason | null {
  if (error === null || typeof error !== "object") return null;
  const e = error as { name?: unknown; reason?: unknown; errorCode?: unknown };
  if (e.name === "AiUnavailableError" && typeof e.reason === "string") {
    return e.reason as AiUnavailableReason;
  }
  if (e.errorCode === "consent.ai.required") return "consent_required";
  return null;
}

/**
 * The code for a thrown provider failure, or null when the value is not one
 * (a server defect stays a server defect, for the error tracker).
 *
 * An `AllProvidersFailedError` (duck-typed, so this file does not pull the
 * chain runner in) speaks through its hops; an empty hop list means no
 * provider was there to try. A single client error must carry the wire tag
 * (`upstream`) or a client failure kind to count.
 */
export function codeForProviderError(error: unknown): AiJobFailureCode | null {
  if (error === null || typeof error !== "object") return null;
  const e = error as {
    attempts?: unknown;
    primaryCredentialExpired?: unknown;
    upstream?: unknown;
    httpStatus?: unknown;
    kind?: unknown;
  };
  if (Array.isArray(e.attempts) && "primaryCredentialExpired" in e) {
    if (e.primaryCredentialExpired === true) return "credential_expired";
    const hops = e.attempts as Array<{
      failureKind?: ProviderFailureKind;
      httpStatus?: number | null;
    }>;
    if (hops.length === 0) return "no_provider";
    return codeForProviderCalls(
      hops.map((hop) => ({
        failure: hop.failureKind,
        httpStatus: typeof hop.httpStatus === "number" ? hop.httpStatus : null,
      })),
    );
  }
  const { failure } = providerFailureKind(error);
  const tagged =
    typeof e.upstream === "string" ||
    failure === "empty_response" ||
    failure === "reasoning_only";
  if (!tagged) return null;
  return codeForProviderCall({
    failure,
    httpStatus: typeof e.httpStatus === "number" ? e.httpStatus : null,
  });
}
