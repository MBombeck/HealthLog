/**
 * Off-response classifier for WHOOP API replies.
 *
 * WHOOP signals failure through the HTTP status code itself (no `status` field
 * embedded in a 200 body), so the classification is status-driven. The shared
 * core lives in `src/lib/integrations/http-status-classifier.ts`; this module
 * re-exports it under the WHOOP-specific names callers already use.
 *
 *   - `success`         → HTTP 2xx
 *   - `transient`       → retryable: HTTP 429 (rate-limited — WHOOP caps at
 *                         100 req/min + 10 000 req/day per app), 5xx upstream
 *                         outages, 3xx CDN/network glitches, and an unknown
 *                         status where we never reached the envelope.
 *   - `reauth_required` → HTTP 401 / 403 — the access token is rejected or the
 *                         grant was revoked; the user must redo OAuth.
 *   - `persistent`      → any other 4xx (400, 404, 422, …) — a malformed
 *                         request or a contract mismatch that retrying without
 *                         operator intervention will not fix.
 */

import {
  classifyHttpStatus,
  classifyIntegrationError,
  IntegrationApiError,
  isOAuthInvalidGrant,
  type ClassifiedHttpResponse,
  type IntegrationClassification,
} from "@/lib/integrations/http-status-classifier";

/** Outcome buckets for a WHOOP response. */
export type WhoopClassification = IntegrationClassification;

export type ClassifiedWhoopResponse = ClassifiedHttpResponse;

/** Classify a single WHOOP API response by its HTTP status code. */
export function classifyWhoopResponse(
  httpStatus: number,
): ClassifiedWhoopResponse {
  return classifyHttpStatus(httpStatus);
}

/**
 * Typed error carrying the classification verdict so downstream `try/catch`
 * blocks can branch without re-parsing the message. Extends the shared base
 * (message shape `WHOOP <verb> error: <status>` is preserved).
 */
export class WhoopApiError extends IntegrationApiError {
  constructor(opts: {
    verb: string;
    classification: WhoopClassification;
    httpStatus: number | undefined;
    reason: string;
    upstreamError?: string;
    retryAfterMs?: number;
  }) {
    super({ vendor: "WHOOP", ...opts });
    this.name = "WhoopApiError";
  }
}

/**
 * True when a caught error is an OAuth `invalid_grant` on a 400 from the token
 * endpoint — the canonical signal that the stored refresh token was revoked
 * (the user disconnected the app, or WHOOP expired the grant). A plain
 * `classifyWhoopResponse(400)` buckets this as `persistent`, which never
 * prompts a reconnect; lifting it to `reauth_required` makes the connection
 * surface the reauth prompt. Scoped tightly to a 400 carrying `invalid_grant`
 * so other 400s (a malformed request, a bad client_secret → `invalid_client`)
 * stay persistent.
 */
export function isInvalidGrant(err: unknown): boolean {
  return isOAuthInvalidGrant(err, "WHOOP");
}

/**
 * Read the classification from any caught error. Returns `transient` for a
 * non-`WhoopApiError` input so a call site surfacing a plain `Error` retries
 * rather than permanently disabling the integration. Falls back to parsing the
 * HTTP status out of the legacy `"WHOOP <verb> error: <status>"` message shape
 * for callers that lose the original prototype across a pg-boss retry.
 *
 * A 400 `invalid_grant` from the token endpoint is the one 4xx that is NOT
 * persistent: the refresh token was revoked, so the verdict is
 * `reauth_required` and the user is prompted to reconnect.
 */
export function classifyWhoopError(err: unknown): WhoopClassification {
  if (isInvalidGrant(err)) return "reauth_required";
  return classifyIntegrationError(err, "WHOOP");
}
