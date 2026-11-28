/**
 * v1.28.x — off-response classifier for Strava API v3 replies.
 * HTTP-status-driven; the shared core lives in
 * `src/lib/integrations/http-status-classifier.ts` and is re-exported here
 * under the Strava-specific names callers already use.
 *
 *   - `success`         → HTTP 2xx
 *   - `transient`       → 429 (rate-limited — respect X-RateLimit headers),
 *                         5xx, 3xx, unknown.
 *   - `reauth_required` → 401 / 403 — token rejected / grant revoked, plus a
 *                         dead refresh token on the token endpoint (see
 *                         `isStravaDeadRefreshToken`).
 *   - `persistent`      → any other 4xx — malformed request / contract drift.
 */

import {
  classifyHttpStatus,
  classifyIntegrationError,
  IntegrationApiError,
  isOAuthInvalidGrant,
  type ClassifiedHttpResponse,
  type IntegrationClassification,
} from "@/lib/integrations/http-status-classifier";

export function classifyStravaResponse(
  httpStatus: number,
): ClassifiedHttpResponse {
  return classifyHttpStatus(httpStatus);
}

export class StravaApiError extends IntegrationApiError {
  /**
   * On a 429: how long Strava's own headers say to wait before asking again
   * (`stravaRateLimitRetryAfterSeconds`). Undefined on every other failure.
   */
  readonly retryAfterSeconds: number | undefined;

  constructor(opts: {
    verb: string;
    classification: IntegrationClassification;
    httpStatus: number | undefined;
    reason: string;
    upstreamError?: string;
    retryAfterSeconds?: number;
  }) {
    const { retryAfterSeconds, ...rest } = opts;
    super({
      vendor: "Strava",
      ...rest,
      ...(retryAfterSeconds !== undefined
        ? { retryAfterMs: retryAfterSeconds * 1000 }
        : {}),
    });
    this.name = "StravaApiError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** True for Strava's rate-limit refusal. */
export function isStravaRateLimited(err: unknown): err is StravaApiError {
  return err instanceof StravaApiError && err.httpStatus === 429;
}

/**
 * Strava's token endpoint does not answer in RFC 6749 form. A refusal is the
 * API's generic `Fault` (developers.strava.com/docs/reference, "Fault" and
 * "Error"): `{"message":"Bad Request","errors":[{"resource":"RefreshToken",
 * "field":"refresh_token","code":"invalid"}]}`, with no `error` member at all,
 * so an `invalid_grant` check never matches it. This reduces the fault to one
 * stable token for the error message — `<resource>.<field>:<code>` of the first
 * entry, e.g. `RefreshToken.refresh_token:invalid` or `Application:invalid` —
 * and falls back to an RFC 6749 `error` code, then to `message`. Nothing of
 * the body beyond those names reaches the message.
 */
export function stravaFaultSummary(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const fault = body as {
    message?: unknown;
    errors?: unknown;
    error?: unknown;
  };
  // A standards-shaped body (`{"error":"invalid_grant"}`) keeps its code.
  if (typeof fault.error === "string" && /^[a-z_]{1,40}$/.test(fault.error)) {
    return fault.error;
  }
  const first = Array.isArray(fault.errors) ? fault.errors[0] : undefined;
  if (typeof first === "object" && first !== null) {
    const { resource, field, code } = first as Record<string, unknown>;
    if (typeof resource === "string" && /^[A-Za-z]{1,40}$/.test(resource)) {
      const at =
        typeof field === "string" && /^[A-Za-z_]{1,40}$/.test(field)
          ? `.${field}`
          : "";
      const why =
        typeof code === "string" && /^[A-Za-z_]{1,40}$/.test(code)
          ? `:${code}`
          : "";
      return `${resource}${at}${why}`;
    }
  }
  return typeof fault.message === "string"
    ? fault.message.slice(0, 120)
    : undefined;
}

/**
 * True for a refresh token Strava no longer honours: a 400 whose fault names
 * the `RefreshToken` resource. That is what the token endpoint answers once the
 * athlete revoked the app or the token was rotated away, and the only way back
 * is a new authorisation, so it lifts the verdict to `reauth_required`. A
 * standards-shaped `invalid_grant` is accepted too, in case Strava ever sends
 * one.
 *
 * Robust to a lost prototype across a pg-boss retry, like
 * `isOAuthInvalidGrant`: it falls back to the
 * `"Strava <verb> error: 400 - RefreshToken…"` message shape.
 */
export function isStravaDeadRefreshToken(err: unknown): boolean {
  if (isOAuthInvalidGrant(err, "Strava")) return true;
  if (err instanceof IntegrationApiError) {
    return (
      err.httpStatus === 400 &&
      (err.upstreamError?.startsWith("RefreshToken") ?? false)
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /Strava\s+\w+\s+error:\s*400\s+-\s+RefreshToken\b/.test(msg);
}

export function classifyStravaError(err: unknown): IntegrationClassification {
  if (isStravaDeadRefreshToken(err)) return "reauth_required";
  return classifyIntegrationError(err, "Strava");
}
