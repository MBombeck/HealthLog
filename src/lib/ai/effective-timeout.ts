import type { AIProvider, CompletionParams } from "./types";

/**
 * The provider timeout a call gets when neither the surface nor the person set
 * one. Every client used to carry its own copy of this literal.
 */
export const PROVIDER_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The range `User.aiResponseTimeoutSeconds` accepts at write time (Settings →
 * AI). The ceiling is what every outer bound and job expiry around model work
 * sizes its worst case from: a person can make each call wait this long.
 */
export const AI_RESPONSE_TIMEOUT_MIN_SECONDS = 10;
export const AI_RESPONSE_TIMEOUT_MAX_SECONDS = 600;

/**
 * Resolve the upstream provider timeout (ms) for a non-chat generation surface.
 *
 * The per-user `User.aiResponseTimeoutSeconds` setting (Settings → AI) is the
 * operator's lever for slow self-hosted / local backends whose first request
 * loads the model. This helper is the one place that converts the stored
 * seconds into milliseconds, falling back to the surface's budget default when
 * the user has not set a value.
 *
 * Semantics: a positive stored value wins (seconds → ms), and any unset /
 * non-positive value yields the surface default. The setting is bounded to
 * 10–600 s at write-time, so no read-time clamp is needed here.
 */
export function resolveEffectiveTimeoutMs(
  aiResponseTimeoutSeconds: number | null | undefined,
  budgetDefaultMs: number,
): number {
  return aiResponseTimeoutSeconds != null && aiResponseTimeoutSeconds > 0
    ? aiResponseTimeoutSeconds * 1000
    : budgetDefaultMs;
}

/**
 * The timeout one provider call actually runs under. Every client reads its
 * `safeFetch` ceiling from here and nowhere else.
 *
 * The person's setting rides on the provider instance (`responseTimeoutSeconds`,
 * stamped by `bindResponseTimeout` when the provider is resolved for a record),
 * so a call site cannot forget it: whatever a surface passes as `timeoutMs` is
 * only the default the setting overrides. A surface that is deliberately
 * latency-bounded and has a deterministic fallback opts out with
 * `timeoutPolicy: "surface-ceiling"`, and the structural guard keeps that set
 * frozen.
 */
export function callTimeoutMs(
  params: Pick<CompletionParams, "timeoutMs" | "timeoutPolicy">,
  responseTimeoutSeconds: number | null | undefined,
): number {
  const surfaceMs = params.timeoutMs ?? PROVIDER_DEFAULT_TIMEOUT_MS;
  if (params.timeoutPolicy === "surface-ceiling") return surfaceMs;
  return resolveEffectiveTimeoutMs(responseTimeoutSeconds, surfaceMs);
}

/**
 * Stamp the record owner's response-timeout setting onto a resolved provider.
 * Called by every exported resolver in `provider.ts` on its way out, which is
 * the only way a provider reaches a call site.
 */
export function bindResponseTimeout<P extends AIProvider>(
  provider: P,
  aiResponseTimeoutSeconds: number | null | undefined,
): P {
  provider.responseTimeoutSeconds =
    aiResponseTimeoutSeconds != null && aiResponseTimeoutSeconds > 0
      ? aiResponseTimeoutSeconds
      : null;
  return provider;
}

/**
 * Room a browser leaves on top of the server's model-call budget for what
 * surrounds the calls: the upload, decrypting and rasterising the original,
 * writing the result, the response itself.
 */
export const CLIENT_ABORT_MARGIN_MS = 30_000;

/**
 * The request timeout a browser uses for a route that waits on `modelCalls`
 * sequential model calls, given the `ai.provider.responseTimeoutMs` the
 * account payload published. Never recomputes the setting: an absent or
 * malformed value (a payload from before the field existed) reads as the
 * server's own default.
 *
 * `surfaceDefaultMs` is the route's own per-call default when it is longer
 * than the provider default (the briefing's 180 s). The published value
 * cannot say whether the person set it or it is the 60 s default, so the
 * browser waits for the longer of the two: it may wait longer than the
 * server needs, never shorter (#1267).
 */
export function clientAbortMs(
  responseTimeoutMs: number | null | undefined,
  modelCalls: number,
  surfaceDefaultMs?: number,
): number {
  const published =
    typeof responseTimeoutMs === "number" && responseTimeoutMs > 0
      ? responseTimeoutMs
      : PROVIDER_DEFAULT_TIMEOUT_MS;
  const perCall = Math.max(published, surfaceDefaultMs ?? 0);
  return perCall * modelCalls + CLIENT_ABORT_MARGIN_MS;
}
