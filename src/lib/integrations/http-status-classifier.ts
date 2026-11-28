/**
 * v1.17.0 — shared HTTP-status response classifier for OAuth integrations.
 *
 * Polar, Oura and WHOOP all signal failure through the HTTP status
 * code itself (no `status` field embedded in a 200 body), so their off-response
 * classifiers were byte-identical copies of one another. This module lifts the
 * shared core; each vendor module re-exports it under its existing names so
 * call sites keep their current types.
 *
 * Classification buckets:
 *
 *   - `success`         → HTTP 2xx (incl. 204 No Content).
 *   - `transient`       → retryable: 429 (rate-limited), 5xx upstream outages,
 *                         3xx CDN/redirect glitches, and an unknown status.
 *   - `reauth_required` → 401 / 403 — the access token is rejected or the grant
 *                         was revoked; the user must reconnect.
 *   - `persistent`      → any other 4xx — a malformed request / contract
 *                         mismatch that a retry won't fix.
 *
 * The classifier is conservative: anything it doesn't recognise defaults to
 * `transient` so a single unknown response doesn't hard-disable the
 * integration. The 3-strike admin-alert ladder in `recordSyncFailure` already
 * catches the "keeps happening" case for recurring transients.
 */

/** Outcome buckets shared across the HTTP-status-driven integrations. */
export type IntegrationClassification =
  "success" | "transient" | "reauth_required" | "persistent";

export interface ClassifiedHttpResponse {
  classification: IntegrationClassification;
  /** The HTTP status code that drove the verdict (undefined if none seen). */
  httpStatus: number | undefined;
  /** Short human-readable label for logs / audit details. */
  reason: string;
}

/**
 * Classify a single integration API response by its HTTP status code.
 *
 * @param httpStatus  The HTTP status from fetch.
 */
export function classifyHttpStatus(httpStatus: number): ClassifiedHttpResponse {
  if (httpStatus >= 200 && httpStatus < 300) {
    return { classification: "success", httpStatus, reason: "ok" };
  }
  // 429 is rate-limit — honour the vendor's backoff header at the call site,
  // but the verdict is a plain transient so the next sync retries.
  if (httpStatus === 429) {
    return { classification: "transient", httpStatus, reason: "http_429" };
  }
  // 401/403 — the bearer token is rejected or the grant revoked. The user has
  // to reconnect; do not retry silently.
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      classification: "reauth_required",
      httpStatus,
      reason: `http_${httpStatus}`,
    };
  }
  // Any other 4xx is a malformed request / contract mismatch — persistent.
  if (httpStatus >= 400 && httpStatus < 500) {
    return {
      classification: "persistent",
      httpStatus,
      reason: `http_${httpStatus}`,
    };
  }
  // 5xx upstream outage — retryable.
  if (httpStatus >= 500 && httpStatus < 600) {
    return {
      classification: "transient",
      httpStatus,
      reason: `http_${httpStatus}`,
    };
  }
  // 3xx (a CDN / redirect glitch — safeFetch uses redirect:"manual", so a
  // surfaced 3xx is unexpected) and everything else defaults to transient.
  return {
    classification: "transient",
    httpStatus,
    reason: `http_${httpStatus}_unknown`,
  };
}

/**
 * Typed Error base carrying the classification verdict so downstream
 * `try/catch` blocks can branch without re-parsing the message. Each vendor
 * subclass sets `vendor` (the wire label used in the message prefix) and its
 * own `name`; the message shape (`<Vendor> <verb> error: <status> - <err>`,
 * capped at 1024 chars) is identical across vendors.
 */
export class IntegrationApiError extends Error {
  readonly vendor: string;
  readonly classification: IntegrationClassification;
  readonly httpStatus: number | undefined;
  readonly reason: string;
  readonly verb: string;
  /**
   * The OAuth `error` code from a token-endpoint failure body (e.g.
   * `invalid_grant` when a refresh token is revoked). Undefined for the
   * collection endpoints, which signal failure through the status code alone.
   */
  readonly upstreamError: string | undefined;
  /**
   * How long the provider asked to wait (`Retry-After`, in ms), when the
   * failed response said. The backfill retry rule reads it as the floor of
   * its wait (`jobs/integration-backfill-retry.ts`), for every provider.
   */
  readonly retryAfterMs: number | undefined;

  constructor(opts: {
    vendor: string;
    verb: string;
    classification: IntegrationClassification;
    httpStatus: number | undefined;
    reason: string;
    upstreamError?: string;
    retryAfterMs?: number;
  }) {
    const statusLabel =
      typeof opts.httpStatus === "number" ? opts.httpStatus : "?";
    const errSegment = opts.upstreamError ? ` - ${opts.upstreamError}` : "";
    // Cap the message at 1024 chars so a misbehaving upstream returning a
    // multi-MB error body can't bloat an AuditLog row downstream.
    const raw = `${opts.vendor} ${opts.verb} error: ${statusLabel}${errSegment}`;
    super(raw.slice(0, 1024));
    this.name = "IntegrationApiError";
    this.vendor = opts.vendor;
    this.verb = opts.verb;
    this.classification = opts.classification;
    this.httpStatus = opts.httpStatus;
    this.reason = opts.reason;
    this.upstreamError = opts.upstreamError;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/**
 * True when a caught error is an OAuth `invalid_grant` on a 400 from the token
 * endpoint — the canonical signal that the stored refresh token was revoked
 * (the user disconnected the app, or the upstream expired the grant). A plain
 * `classifyHttpStatus(400)` buckets this as `persistent`, which never prompts a
 * reconnect; lifting it to `reauth_required` makes the connection surface the
 * reauth prompt. Scoped tightly to a 400 carrying `invalid_grant` so other
 * 400s (a malformed request, a bad client_secret → `invalid_client`) stay
 * persistent.
 *
 * Robust to a lost prototype across a pg-boss retry: it reads the dedicated
 * `upstreamError` field when present, else falls back to the
 * `"<Vendor> <verb> error: 400 - invalid_grant"` message segment. The `vendor`
 * label scopes the message-shape fallback to the calling integration.
 */
export function isOAuthInvalidGrant(err: unknown, vendor: string): boolean {
  if (err instanceof IntegrationApiError) {
    if (err.httpStatus !== 400) return false;
    if (err.upstreamError === "invalid_grant") return true;
    return /\binvalid_grant\b/.test(err.message);
  }
  const msg = err instanceof Error ? err.message : String(err);
  const re = new RegExp(
    `${vendor}\\s+\\w+\\s+error:\\s*400\\b[\\s\\S]*\\binvalid_grant\\b`,
  );
  return re.test(msg);
}

/**
 * Read the classification from any caught `IntegrationApiError`, falling back
 * to parsing the HTTP status out of the legacy `"<Vendor> <verb> error:
 * <status>"` message shape for callers that lose the original prototype across
 * a pg-boss retry. A non-`IntegrationApiError` with no parseable status
 * defaults to `transient` so a plain `Error` retries rather than permanently
 * disabling the integration.
 */
export function classifyIntegrationError(
  err: unknown,
  vendor: string,
): IntegrationClassification {
  if (err instanceof IntegrationApiError) return err.classification;
  const msg = err instanceof Error ? err.message : String(err);
  const re = new RegExp(`${vendor}\\s+\\w+\\s+error:\\s*(\\d+)`);
  const m = re.exec(msg);
  if (!m) return "transient";
  const status = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(status)) return "transient";
  return classifyHttpStatus(status).classification;
}
