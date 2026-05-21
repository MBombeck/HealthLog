/**
 * Off-response classifier for Withings API replies.
 *
 * The Withings API has three failure shapes the legacy client treated
 * uniformly as "throw with a message":
 *
 *   1. HTTP 5xx — upstream outage, retry on the next sync.
 *   2. HTTP 200 + `status: <non-zero>` — Withings returns its semantic
 *      error code in the JSON body, with HTTP 200. The status code
 *      taxonomy is documented at
 *      https://developer.withings.com/api-reference/#section/Response-status .
 *   3. HTTP 200 + `status: 0` + empty `measuregrps` — no data, but the
 *      connection is healthy. Not a failure at all.
 *
 * Pre-v1.4.42 the sync path inferred reauth-vs-transient from the error
 * MESSAGE via a regex (`isWithingsRefreshReauthFailure` in sync.ts).
 * That worked because the only failure shape the client threw was
 * `Withings <verb> error: <status>`, but it tightly coupled the
 * classifier to the literal message format and meant rate-limit
 * responses (601) and quota responses (293) were silently bucketed as
 * transient errors that never escalated even when they kept recurring.
 *
 * This module introduces an explicit classifier:
 *
 *   - `classifyWithingsResponse(httpStatus, body)` — pure function,
 *     returns a `WithingsClassification`.
 *   - `WithingsApiError` — typed Error subclass carrying the
 *     classification so downstream catch-blocks don't need to re-parse
 *     a string.
 *
 * Classification buckets:
 *
 *   - `success`         → HTTP 200 + body.status === 0
 *   - `transient`       → retryable: HTTP 5xx, 429, Withings status 503
 *                         (upstream unavailable), 601 (rate-limited),
 *                         2554 (too many subscriptions in flight),
 *                         3xx network/CDN glitches
 *   - `reauth_required` → permanent revoke: Withings 100, 101, 102,
 *                         200–299 (invalid grant family). The user has
 *                         to redo OAuth.
 *   - `persistent`      → operator-attention error: invalid params
 *                         (293), missing scope (293 with body.scope_hint),
 *                         unknown action (294 outside subscribeWebhook).
 *                         These should NOT be retried silently — they
 *                         indicate a contract mismatch.
 *
 * The classifier is deliberately conservative: anything it doesn't
 * recognise defaults to `transient` so we don't hard-fail an integration
 * over a Withings status we've never seen. The audit log + admin-alert
 * ladder in `recordSyncFailure` already catches the "this keeps
 * happening" case for unknown transients.
 */

/** Outcome buckets for a Withings response. */
export type WithingsClassification =
  | "success"
  | "transient"
  | "reauth_required"
  | "persistent";

export interface ClassifiedResponse {
  classification: WithingsClassification;
  /** The Withings body status code (or undefined if HTTP-only failure). */
  withingsStatus: number | undefined;
  /** Short human-readable label for logs / audit details. */
  reason: string;
}

/**
 * The minimum body shape we read. Withings adds many additional fields
 * (`body`, `error`, `scope_hint`, `more`, `measuregrps`, …); callers
 * keep their own typed views — we only need `status` and (optionally)
 * `error` for the reason string.
 */
export interface WithingsBodyLike {
  status?: number;
  error?: string;
}

/**
 * Withings status codes that map to a permanent-revoke (user MUST
 * redo OAuth). See https://developer.withings.com/api-reference for
 * the full table — these are the values both Withings' own SDKs and
 * the existing HealthLog code treated as terminal.
 */
const REAUTH_CODES = new Set<number>([100, 101, 102]);

/**
 * Withings status codes that map to a transient / retryable error.
 * Conservative on purpose — 503 is the documented "service unavailable"
 * response, 601 is rate-limit, 2554/2555/2556 are notify-subscribe
 * transients.
 */
const TRANSIENT_CODES = new Set<number>([503, 601, 2554, 2555, 2556]);

/**
 * Withings status codes that indicate a persistent contract mismatch —
 * the request itself is malformed or the integration is missing a
 * required field. Retrying without operator intervention will not
 * succeed; the audit log surfaces these.
 *
 *   - 293 = "invalid params" / "missing required field"
 *   - 294 = "already subscribed" (subscribeWebhook treats it as success;
 *           any OTHER endpoint receiving 294 is a contract bug)
 *
 * Note: 294 is intentionally listed here. `subscribeWebhook` overrides
 * the classification for its own call site (already-subscribed is
 * idempotent there); every other client call that sees 294 surfaces it
 * as a persistent failure so the bug doesn't hide.
 */
const PERSISTENT_CODES = new Set<number>([293, 294]);

/**
 * Classify a single Withings API response.
 *
 * @param httpStatus  The HTTP status code from fetch (200 for the
 *                    happy path, 5xx for upstream outages).
 * @param body        The parsed JSON body. Only `status` (and
 *                    optionally `error`) are read.
 */
export function classifyWithingsResponse(
  httpStatus: number,
  body: WithingsBodyLike | null | undefined,
): ClassifiedResponse {
  // HTTP layer first — a 503 / 502 / 504 from Withings means we never
  // got to the JSON envelope.
  if (httpStatus >= 500 && httpStatus < 600) {
    return {
      classification: "transient",
      withingsStatus: undefined,
      reason: `http_${httpStatus}`,
    };
  }
  if (httpStatus === 429) {
    return {
      classification: "transient",
      withingsStatus: undefined,
      reason: "http_429",
    };
  }
  // 4xx outside 429 is unexpected from Withings — they always reply 200
  // even on auth failures, embedding the real status in the body. We
  // bucket as persistent so a regression to a 4xx-throwing upstream
  // surfaces in audit logs rather than retrying forever.
  if (httpStatus >= 400 && httpStatus < 500) {
    return {
      classification: "persistent",
      withingsStatus: undefined,
      reason: `http_${httpStatus}`,
    };
  }

  // Body status — Withings' own taxonomy.
  const status = body?.status;
  if (status === 0) {
    return {
      classification: "success",
      withingsStatus: 0,
      reason: "ok",
    };
  }
  if (typeof status !== "number") {
    // Off-spec body — no `status` field at all. The legacy client
    // would have crashed reading `json.status`; we treat it as a
    // transient so the retry catches a one-off CDN error page.
    return {
      classification: "transient",
      withingsStatus: undefined,
      reason: "no_status_field",
    };
  }

  // Explicit lists take precedence over ranges so a contract-mismatch
  // code (293, 294) that happens to live inside the 200..299 OAuth
  // range stays classified as persistent rather than reauth.
  if (PERSISTENT_CODES.has(status)) {
    return {
      classification: "persistent",
      withingsStatus: status,
      reason: `withings_${status}`,
    };
  }
  if (TRANSIENT_CODES.has(status)) {
    return {
      classification: "transient",
      withingsStatus: status,
      reason: `withings_${status}`,
    };
  }
  if (REAUTH_CODES.has(status)) {
    return {
      classification: "reauth_required",
      withingsStatus: status,
      reason: `withings_${status}`,
    };
  }
  // The 200..299 invalid_grant family — Withings uses this range for
  // OAuth grant failures. Membership is by range rather than an
  // explicit list because individual codes in there can shift between
  // Withings firmware revisions. Explicit persistent/transient codes
  // above this check are deliberate exemptions.
  if (status >= 200 && status <= 299) {
    return {
      classification: "reauth_required",
      withingsStatus: status,
      reason: `withings_${status}`,
    };
  }

  // Default: anything we don't recognise becomes transient. The
  // 3-strike admin alert ladder in `recordSyncFailure` already catches
  // the "keeps happening" case, and silently degrading to "no data"
  // (the legacy behaviour) is strictly worse than a retry.
  return {
    classification: "transient",
    withingsStatus: status,
    reason: `withings_${status}_unknown`,
  };
}

/**
 * Typed Error subclass that carries the classification verdict so
 * `try/catch` blocks downstream can branch without re-parsing the
 * message.
 *
 * The `message` field still uses the legacy
 * `"Withings <verb> error: <status> - <error>"` format so the existing
 * regex-based `extractWithingsStatus` / `isWithingsRefreshReauthFailure`
 * helpers in sync.ts continue to work for callers that haven't been
 * migrated yet. Callers that import the new class can read
 * `err.classification` directly.
 */
export class WithingsApiError extends Error {
  readonly classification: WithingsClassification;
  readonly withingsStatus: number | undefined;
  readonly reason: string;
  readonly verb: string;

  constructor(opts: {
    verb: string;
    classification: WithingsClassification;
    withingsStatus: number | undefined;
    reason: string;
    upstreamError?: string;
  }) {
    const statusLabel =
      typeof opts.withingsStatus === "number" ? opts.withingsStatus : "?";
    const errSegment = opts.upstreamError ? ` - ${opts.upstreamError}` : "";
    // v1.4.43 W3-SECURITY (H-2, v1.4.42 L-1 carry-over): cap the
    // message at 1024 chars in the constructor so every downstream
    // audit / notification path inherits the bound. A misbehaving
    // upstream that returns a multi-MB error body must not be able to
    // bloat an `AuditLog.details` row.
    const raw = `Withings ${opts.verb} error: ${statusLabel}${errSegment}`;
    super(raw.slice(0, 1024));
    this.name = "WithingsApiError";
    this.verb = opts.verb;
    this.classification = opts.classification;
    this.withingsStatus = opts.withingsStatus;
    this.reason = opts.reason;
  }
}

/**
 * Read the classification from any caught error. Returns
 * `transient` for non-`WithingsApiError` inputs so existing call
 * sites that surface a plain `Error` continue to retry rather than
 * permanently disabling the integration.
 *
 * Falls back to message-regex parsing so callers that wrap
 * `WithingsApiError` in `new Error(`... ${err.message}`)` (e.g.
 * pg-boss job retries that lose the original prototype) still
 * classify correctly.
 */
export function classifyError(err: unknown): WithingsClassification {
  if (err instanceof WithingsApiError) return err.classification;

  // Best-effort regex fallback for unwrapped messages — same shape
  // sync.ts's `extractWithingsStatus` reads.
  const msg = err instanceof Error ? err.message : String(err);
  const m = /Withings\s+\w+\s+error:\s*(\d+)/.exec(msg);
  if (!m) return "transient";
  const status = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(status)) return "transient";
  // Run the body classifier with a synthetic HTTP-200 envelope.
  return classifyWithingsResponse(200, { status }).classification;
}
