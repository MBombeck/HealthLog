/**
 * The Google Health request layer: one data request with the error detail
 * read out of a refusal (redacted), the transient retry, the rate-limit wait,
 * and the civil-time filters the list endpoint takes.
 */
import { getEvent } from "@/lib/logging/context";
import { SafeFetchError } from "@/lib/safe-fetch";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { classifyGoogleHealthResponse } from "./response-classifier";
import { type GoogleHealthDataType } from "./mappers";
import { retryAfterMsOf } from "@/lib/integrations/oauth-kit/retry-after";
import { stopRequested } from "./budget";

export const GOOGLE_HEALTH_API_BASE = "https://health.googleapis.com/v4";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Format a UTC instant as the offset-less civil wall clock an observer in `tz`
 * reads at that moment (`YYYY-MM-DDTHH:MM:SS`, no `Z`, no offset) — the bound
 * format the session `civil_start_time` filter expects. Without `tz` the bound
 * forms in UTC.
 */
export function formatCivilBound(instant: Date, tz?: string): string {
  if (!tz) return instant.toISOString().slice(0, 19);
  const p = wallClockInTz(instant, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

/**
 * The daily-summary `.date` filter prefix style. The official docs contradict
 * themselves on this one point:
 *   - The data-types index states "In a filter parameter … the data type name
 *     must be in snake case, such as `body_fat`" and its per-type "filter
 *     parameter" column lists `daily_heart_rate_variability` etc.
 *   - The `dataPoints.list` reference's ONLY worked daily-summary example is
 *     `dailyHeartRateVariability.date < "2024-08-15"` — the camelCase payload
 *     union key, NOT snake_case.
 * Live behaviour: the snake_case daily filter is accepted (HTTP 200) but has
 * returned zero rows on accounts whose companion app visibly holds daily HRV /
 * RHR — consistent with a vacuously-unmatched predicate. The client therefore
 * sends the worked-example camelCase form first and falls back to snake_case
 * once if the very first page is rejected with a 400 (see `fetchDataPoints`).
 */
export type GoogleHealthDateFilterStyle = "camel" | "snake";

/**
 * Build the incremental `filter` field + bound for one list-read data type.
 * Centralised so the predicate and the read-time anchor resolution can never
 * drift. The legal filter fields are per-shape (anything else 400s):
 *   - `sample`     → `{filter}.sample_time.physical_time` (RFC-3339).
 *   - `date`       → `{key|filter}.date` (`YYYY-MM-DD`) — prefix style per
 *     `GoogleHealthDateFilterStyle` (docs conflict; camel is the worked
 *     example, snake the fallback).
 *   - `sessionEnd` → sleep only: `{filter}.interval.end_time` (RFC-3339) — the
 *     ONLY filterable time field on sleep; watermark semantics improve too (a
 *     night is fetched when it ENDS after the cursor).
 *   - `civilStart` → exercise: `{filter}.interval.civil_start_time` with an
 *     offset-less civil bound in the user's zone.
 * `rollup` types never build a list filter — they read via `:dailyRollUp`.
 */
export function incrementalFilter(
  dataType: GoogleHealthDataType,
  start: Date,
  tz?: string,
  dateStyle: GoogleHealthDateFilterStyle = "camel",
): { field: string; bound: string } {
  switch (dataType.timeField) {
    case "sample":
      return {
        field: `${dataType.filter}.sample_time.physical_time`,
        bound: start.toISOString(),
      };
    case "sessionEnd":
      return {
        field: `${dataType.filter}.interval.end_time`,
        bound: start.toISOString(),
      };
    case "civilStart":
      return {
        field: `${dataType.filter}.interval.civil_start_time`,
        bound: formatCivilBound(start, tz),
      };
    case "date":
      return {
        field: `${dateStyle === "camel" ? dataType.key : dataType.filter}.date`,
        // eslint-disable-next-line healthlog/no-utc-day-key -- baseline: request window edge for the provider API, not a displayed day; rows carry their own dates
        bound: start.toISOString().slice(0, 10),
      };
    case "rollup":
      throw new Error(
        `Google Health data type ${dataType.path} reads via :dailyRollUp, not dataPoints.list`,
      );
  }
}

/**
 * Redact + bound an upstream Google API error message before it reaches an
 * error object / wide event: strip bearer tokens, drop query strings from any
 * embedded URL (they can carry filters echoing user data or tokens), cap at
 * 200 chars.
 */
function redactApiErrorMessage(msg: string): string {
  return msg
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(https?:\/\/[^\s"'?]+)\?[^\s"']*/gi, "$1?[REDACTED]")
    .slice(0, 200);
}

/**
 * Collect the `google.rpc.BadRequest` field violations out of an AIP-193
 * `error.details[]` array as `field: description` fragments. Only the field
 * PATH and the description sentence survive — both run through the message
 * redactor and a per-fragment cap, and at most three violations are kept, so
 * no request value can ride an error string into the logs.
 */
function extractFieldViolations(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  const out: string[] = [];
  for (const d of details) {
    if (!d || typeof d !== "object") continue;
    const fv = (d as { fieldViolations?: unknown }).fieldViolations;
    if (!Array.isArray(fv)) continue;
    for (const v of fv) {
      if (out.length >= 3) return out;
      if (!v || typeof v !== "object") continue;
      const o = v as { field?: unknown; description?: unknown };
      const field =
        typeof o.field === "string"
          ? redactApiErrorMessage(o.field).slice(0, 80)
          : undefined;
      const description =
        typeof o.description === "string"
          ? redactApiErrorMessage(o.description).slice(0, 120)
          : undefined;
      if (!field && !description) continue;
      out.push([field, description].filter(Boolean).join(": "));
    }
  }
  return out;
}

/**
 * Extract the AIP-193 error envelope (`{"error":{code,message,status,details}}`)
 * from a non-2xx Google Health body into a short redacted
 * `STATUS: message [field: description]` detail string, or undefined when the
 * body carries no such envelope. This is what makes a field-grammar 400
 * (`INVALID_ARGUMENT: Invalid filter …`) diagnosable from operator logs: the
 * `details[]` BadRequest field violations name the exact offending request
 * field. (The OAuth token endpoint uses the flat `{"error":"invalid_grant"}`
 * shape instead — handled in `postToken`.)
 */
export function extractGoogleApiErrorDetail(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const e = (json as { error?: unknown }).error;
  if (!e || typeof e !== "object") return undefined;
  const o = e as { status?: unknown; message?: unknown; details?: unknown };
  const status = typeof o.status === "string" ? o.status : undefined;
  const message =
    typeof o.message === "string"
      ? redactApiErrorMessage(o.message)
      : undefined;
  const violations = extractFieldViolations(o.details);
  if (!status && !message && violations.length === 0) return undefined;
  const head = [status, message].filter(Boolean).join(": ");
  const tail = violations.length > 0 ? `[${violations.join("; ")}]` : "";
  return [head, tail].filter(Boolean).join(" ").slice(0, 500);
}

// ─── Token source + one data request ───────────────────────────

/**
 * Where a walk gets its access token. A plain string is used as given. A
 * function is asked before every request, so a walk that runs for longer than
 * the token lives (an access token lasts an hour; a full-history heart-rate
 * walk can take several) picks up the refreshed one instead of carrying an
 * expired token into a 401. `forceRefresh` asks for a new token even though
 * the current one has not reached its expiry, after Google refused it.
 */
export type GoogleHealthTokenSource = (opts: {
  forceRefresh: boolean;
}) => Promise<string>;

export type GoogleHealthAccessToken = string | GoogleHealthTokenSource;

/**
 * How a data request sits out Google's per-user, per-minute quota (429
 * `RESOURCE_EXHAUSTED`). The quota refills within the minute, so a short wait
 * turns a throttled request into a completed one, where failing it used to
 * cost the whole collection. The waits follow `Retry-After` (or the
 * `google.rpc.RetryInfo` delay in the body) when Google sends one, and
 * otherwise double from `baseDelayMs`: 2, 4, 8, 16, 32 s, a minute and a
 * bit in all, which spans a full quota window. A requested delay above
 * `maxDelayMs` is not slept out; the request fails as the transient it is
 * and the next run picks the window up.
 */
export const GOOGLE_HEALTH_RATE_LIMIT = {
  maxRetries: 5,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
} as const;

/**
 * The delay Google asked for on a 429, in ms: the `Retry-After` header in
 * either of its forms, else a `google.rpc.RetryInfo` detail (`"30s"`) in the
 * error body. Undefined when it asked for nothing readable.
 */
export function googleHealthRetryDelayMs(
  res: Response,
  json: unknown,
  now: number = Date.now(),
): number | undefined {
  const fromHeader = retryAfterMsOf(res, now);
  if (fromHeader !== undefined) return fromHeader;
  const details = (json as { error?: { details?: unknown } } | null)?.error
    ?.details;
  if (Array.isArray(details)) {
    for (const d of details) {
      const delay = (d as { retryDelay?: unknown } | null)?.retryDelay;
      if (typeof delay === "string") {
        const m = /^(\d+(?:\.\d+)?)s$/.exec(delay.trim());
        if (m) return Math.round(Number.parseFloat(m[1]!) * 1000);
      }
    }
  }
  return undefined;
}

/**
 * How a data request rides out a server that did not answer properly: a
 * 500, 502, 503 or 504, a timeout, or a broken connection. A short history
 * reads a handful of pages and rarely meets one; a full-history heart-rate
 * walk reads thousands, and a single one used to end the walk and throw away
 * everything it had read. Three tries more, 2, 4 and 8 s apart (or the
 * `Retry-After` a 503 names, up to a minute), before the request fails.
 */
export const GOOGLE_HEALTH_TRANSIENT_RETRY = {
  maxRetries: 3,
  baseDelayMs: 2_000,
};

const GOOGLE_HEALTH_TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GoogleHealthDataResponse<T> {
  status: number;
  json: T | null;
  verdict: ReturnType<typeof classifyGoogleHealthResponse>;
  apiErrorDetail: string | undefined;
}

/**
 * Send one data request and answer with the response it finally got.
 *
 * Three answers are handled here rather than handed back:
 *   - 429: the request waits (see `GOOGLE_HEALTH_RATE_LIMIT`) and is sent
 *     again, up to `maxRetries` times, unless the caller's stop condition
 *     says to end the walk.
 *   - a server error or no answer at all (see
 *     `GOOGLE_HEALTH_TRANSIENT_RETRY`): the same, with its own count.
 *   - 401 with a token source: the token expired or was revoked between
 *     the source's last check and this request. The source is asked once for
 *     a fresh token and the request is repeated. A second 401, or a 401 on a
 *     fixed string token, is returned like any other answer.
 *
 * Every attempt is recorded as its own external call, so the wide event
 * shows the throttling and the waits rather than only their outcome.
 */
export async function googleHealthDataRequest<T>(
  token: GoogleHealthAccessToken,
  label: string,
  send: (accessToken: string) => Promise<Response>,
  expectedFallbackNote: (
    status: number,
    apiErrorDetail: string | undefined,
  ) => string | undefined = () => undefined,
): Promise<GoogleHealthDataResponse<T>> {
  let rateLimited = 0;
  let transient = 0;
  let refreshed = false;
  let forceRefresh = false;
  for (;;) {
    const accessToken =
      typeof token === "string" ? token : await token({ forceRefresh });
    forceRefresh = false;
    const started = performance.now();
    let res: Response;
    try {
      res = await send(accessToken);
    } catch (err) {
      // No answer at all: the request timed out or the connection broke.
      // On a walk of a thousand pages one of those is a matter of time, and
      // it cost the whole walk.
      const retry =
        err instanceof SafeFetchError &&
        (err.kind === "timeout" || err.kind === "network") &&
        transient < GOOGLE_HEALTH_TRANSIENT_RETRY.maxRetries &&
        !stopRequested();
      const delayMs =
        GOOGLE_HEALTH_TRANSIENT_RETRY.baseDelayMs * 2 ** transient;
      getEvent()?.addExternalCall({
        service: "google-health",
        method: label,
        duration_ms: Math.round(performance.now() - started),
        ...(retry
          ? { note: `no_response_retrying_in_ms=${delayMs}` }
          : { error: err instanceof Error ? err.message : String(err) }),
      });
      if (!retry) throw err;
      transient += 1;
      await waitMs(delayMs);
      continue;
    }
    const json = (await res.json().catch(() => null)) as T | null;
    const verdict = classifyGoogleHealthResponse(res.status);
    const apiErrorDetail =
      verdict.classification === "success"
        ? undefined
        : extractGoogleApiErrorDetail(json);

    const retryAfterMs =
      res.status === 429 ? googleHealthRetryDelayMs(res, json) : undefined;
    const backoffMs =
      res.status === 429
        ? (retryAfterMs ??
          GOOGLE_HEALTH_RATE_LIMIT.baseDelayMs * 2 ** rateLimited)
        : 0;
    const willWait =
      res.status === 429 &&
      rateLimited < GOOGLE_HEALTH_RATE_LIMIT.maxRetries &&
      backoffMs <= GOOGLE_HEALTH_RATE_LIMIT.maxDelayMs &&
      !stopRequested();
    const willRefresh =
      res.status === 401 && typeof token !== "string" && !refreshed;
    const transientDelayMs = GOOGLE_HEALTH_TRANSIENT_STATUSES.has(res.status)
      ? Math.min(
          googleHealthRetryDelayMs(res, json) ??
            GOOGLE_HEALTH_TRANSIENT_RETRY.baseDelayMs * 2 ** transient,
          GOOGLE_HEALTH_RATE_LIMIT.maxDelayMs,
        )
      : 0;
    const willRetryTransient =
      GOOGLE_HEALTH_TRANSIENT_STATUSES.has(res.status) &&
      transient < GOOGLE_HEALTH_TRANSIENT_RETRY.maxRetries &&
      !stopRequested();

    getEvent()?.addExternalCall({
      service: "google-health",
      method: label,
      duration_ms: Math.round(performance.now() - started),
      status: res.status,
      ...(expectedFallbackNote(res.status, apiErrorDetail)
        ? { note: expectedFallbackNote(res.status, apiErrorDetail) }
        : willWait
          ? { note: `rate_limited_retrying_in_ms=${backoffMs}` }
          : willRefresh
            ? { note: "token_rejected_retrying_with_fresh_token" }
            : willRetryTransient
              ? { note: `server_error_retrying_in_ms=${transientDelayMs}` }
              : {
                  error:
                    verdict.classification === "success"
                      ? undefined
                      : apiErrorDetail
                        ? `${verdict.reason} ${apiErrorDetail}`
                        : verdict.reason,
                }),
    });

    if (willWait) {
      rateLimited += 1;
      await waitMs(backoffMs);
      continue;
    }
    if (willRetryTransient) {
      transient += 1;
      await waitMs(transientDelayMs);
      continue;
    }
    if (willRefresh) {
      refreshed = true;
      forceRefresh = true;
      continue;
    }
    return { status: res.status, json, verdict, apiErrorDetail };
  }
}
