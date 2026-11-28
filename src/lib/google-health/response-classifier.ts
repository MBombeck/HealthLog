/**
 * Off-response classifier for Google Health API replies (v1.27.0).
 *
 * Like WHOOP / Fitbit, Google signals failure through the HTTP status code
 * itself (no `status` field embedded in a 200 body), so the classification is
 * status-driven. The shared core lives in
 * `src/lib/integrations/http-status-classifier.ts`; this module re-exports it
 * under the Google-Health-specific names callers already use.
 *
 *   - `success`         → HTTP 2xx
 *   - `transient`       → retryable: HTTP 429 (rate-limited — honour Google's
 *                         truncated exponential backoff at the call site), 5xx
 *                         upstream outages, 3xx CDN/network glitches, and an
 *                         unknown status where we never reached the envelope.
 *   - `reauth_required` → HTTP 401 / 403 — the access token is rejected or the
 *                         grant was revoked; the user must redo OAuth. (The
 *                         per-data-class 403 soft-skip lives in `sync.ts`'s
 *                         `isCollectionForbidden`, not here, so a Restricted
 *                         scope granted independently doesn't park the whole
 *                         connection.)
 *   - `persistent`      → any other 4xx (400, 404, 422, …) — a malformed
 *                         request or a contract mismatch retrying won't fix.
 *
 * NEEDS-REAUTH SIGNAL. Google surfaces a revoked / expired refresh token — a
 * user-revoked grant OR the 7-day "Testing"-mode refresh-token expiry — via
 * `invalid_grant` on the token endpoint (sometimes a 400, sometimes a 401). A
 * plain status classification would bucket that 400 as `persistent` and never
 * prompt a reconnect; the `client.ts` token path lifts an `invalid_grant` onto
 * `reauth_required` before constructing the error, and a 401 already classifies
 * that way. Downstream, `reauth_required` maps through
 * `classificationToFailureKind` → `FailureKind "reauth_required"` →
 * `IntegrationState "error_reauth"`, which the status card renders as a
 * "reconnect" CTA. Use `isGoogleHealthReauthRequired()` to read that signal off
 * any caught error.
 */

import {
  classifyHttpStatus,
  classifyIntegrationError,
  isOAuthInvalidGrant,
  IntegrationApiError,
  type ClassifiedHttpResponse,
  type IntegrationClassification,
} from "@/lib/integrations/http-status-classifier";

/** Wire label used in the error-message prefix + the message-shape fallbacks. */
export const GOOGLE_HEALTH_VENDOR = "GoogleHealth";

/** Outcome buckets for a Google Health response. */
export type GoogleHealthClassification = IntegrationClassification;

export type ClassifiedGoogleHealthResponse = ClassifiedHttpResponse;

/** Classify a single Google Health API response by its HTTP status. */
export function classifyGoogleHealthResponse(
  httpStatus: number,
): ClassifiedGoogleHealthResponse {
  return classifyHttpStatus(httpStatus);
}

/**
 * Typed error carrying the classification verdict so downstream `try/catch`
 * blocks can branch without re-parsing the message. Extends the shared base
 * (message shape `GoogleHealth <verb> error: <status>` is preserved).
 */
export class GoogleHealthApiError extends IntegrationApiError {
  constructor(opts: {
    verb: string;
    classification: GoogleHealthClassification;
    httpStatus: number | undefined;
    reason: string;
    upstreamError?: string;
    retryAfterMs?: number;
  }) {
    super({ vendor: GOOGLE_HEALTH_VENDOR, ...opts });
    this.name = "GoogleHealthApiError";
  }
}

/**
 * Read the classification from any caught error. Returns `transient` for a
 * non-`GoogleHealthApiError` input so a call site surfacing a plain `Error`
 * retries rather than permanently disabling the integration. Falls back to
 * parsing the HTTP status out of the legacy `"GoogleHealth <verb> error:
 * <status>"` message shape for callers that lose the original prototype across a
 * pg-boss retry.
 */
export function classifyGoogleHealthError(
  err: unknown,
): GoogleHealthClassification {
  return classifyIntegrationError(err, GOOGLE_HEALTH_VENDOR);
}

/**
 * True when a caught error carries an OAuth `invalid_grant` on a 400 from the
 * token endpoint — the canonical signal that the stored refresh token was
 * revoked or expired (a user-revoked grant, or the 7-day "Testing"-mode
 * expiry). Robust to a lost prototype across a pg-boss retry.
 */
export function isGoogleHealthInvalidGrant(err: unknown): boolean {
  return isOAuthInvalidGrant(err, GOOGLE_HEALTH_VENDOR);
}

/**
 * True when a caught error means the user must reconnect — either a rejected
 * token / revoked grant (401/403 → `reauth_required`) or a token-endpoint
 * `invalid_grant`. This is the single predicate downstream routes / UI consume
 * to decide whether to show the "reconnect" CTA.
 */
export function isGoogleHealthReauthRequired(err: unknown): boolean {
  return (
    classifyGoogleHealthError(err) === "reauth_required" ||
    isGoogleHealthInvalidGrant(err)
  );
}
