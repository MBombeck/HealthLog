/**
 * Google Health API client — OAuth + data-point reads (v1.27.0).
 * Docs: https://developers.google.com/health (health.googleapis.com/v4, the
 * successor to the Fitbit Web API, unifying Fitbit + Pixel Watch + Fitbit Air).
 *
 * Hand-rolled fetch over `safeFetch` (no SDK): the OAuth handshake
 * (`getAuthorizationUrl` / `exchangeCode` / `refreshAccessToken`), a single
 * profile fetch for the connection's external user id, and the paginated
 * `dataPoints.list` walker + per-type mappers.
 *
 * KEY OAUTH SEMANTICS (verified 2026 contract):
 *   - Access-token TTL = 1 h (contrast the classic Fitbit Web API's 8 h).
 *   - Refresh tokens do NOT rotate — a routine refresh returns a fresh
 *     `access_token` WITHOUT a `refresh_token`; the sync layer keeps the stored
 *     one (see `getValidToken` in `sync.ts`). Refresh tokens are time-based:
 *     they expire after 6 months of disuse, or — in a consent screen still in
 *     "Testing" publishing mode — after 7 DAYS, at which point the user must
 *     re-consent. A revoked / expired refresh token surfaces `invalid_grant`
 *     (or a 401) on the token endpoint; `postToken` lifts that onto the
 *     `reauth_required` class so the connection prompts a reconnect rather than
 *     a generic hard error.
 *   - PKCE (S256): the authorize request carries a `code_challenge`; the
 *     callback presents the matching `code_verifier` on exchange. Google's
 *     web-server (confidential) client also sends the client secret via HTTP
 *     Basic auth (RFC 6749 §2.3.1) — Basic + PKCE together.
 *   - `access_type=offline` + `prompt=consent` are required to reliably receive
 *     a refresh token (and force one on every re-consent).
 *
 * The pure mapping layer (payload → Measurement / Workout shapes) lives in
 * `mappers.ts` and is re-exported below, so the sync layer and tests keep a
 * single `./client` import surface. The shared wire-shape symbols
 * (`GoogleHealthDataType`, `GOOGLE_HEALTH_DATA_TYPES`, the point types) live in
 * `mappers.ts` and are imported here type-only — that direction keeps the
 * module graph acyclic (`client` → `mappers`, never back).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { annotate, getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import {
  GoogleHealthApiError,
  classifyGoogleHealthResponse,
  type GoogleHealthClassification,
} from "./response-classifier";
import type {
  GoogleHealthDataPoint,
  GoogleHealthDataType,
  GoogleHealthRollupPoint,
} from "./mappers";
import { envValue } from "@/lib/env";

export * from "./mappers";

export interface GoogleHealthClientOutcome {
  pages: number;
  fetched: number;
  mapped: number;
  written: number;
  truncated: boolean;
  reasonCode:
    | "collection_failed"
    | "token_failed"
    | "upsert_failed"
    | "rollup_failed"
    | "existing_page_limit"
    | null;
}

const clientOutcomeStorage = new AsyncLocalStorage<GoogleHealthClientOutcome>();

function addOutcomeCount(current: number, value: number): number {
  if (!Number.isFinite(value) || value <= 0) return current;
  return Math.min(2_147_483_647, current + Math.trunc(value));
}

function notePagination(
  pages: number,
  fetched: number,
  truncated: boolean,
): void {
  const tracker = clientOutcomeStorage.getStore();
  if (!tracker) return;
  tracker.pages = addOutcomeCount(tracker.pages, pages);
  tracker.fetched = addOutcomeCount(tracker.fetched, fetched);
  if (truncated) {
    tracker.truncated = true;
    tracker.reasonCode = "existing_page_limit";
  }
}

export function noteGoogleHealthMapped(count: number): void {
  const tracker = clientOutcomeStorage.getStore();
  if (tracker) tracker.mapped = addOutcomeCount(tracker.mapped, count);
}

export function noteGoogleHealthWritten(count: number): void {
  const tracker = clientOutcomeStorage.getStore();
  if (tracker) tracker.written = addOutcomeCount(tracker.written, count);
}

export function noteGoogleHealthOutcomeFailure(
  reasonCode: Exclude<GoogleHealthClientOutcome["reasonCode"], null>,
): void {
  const tracker = clientOutcomeStorage.getStore();
  if (tracker && !tracker.reasonCode) tracker.reasonCode = reasonCode;
}

export async function runWithGoogleHealthClientOutcome<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; outcome: GoogleHealthClientOutcome }> {
  const outcome: GoogleHealthClientOutcome = {
    pages: 0,
    fetched: 0,
    mapped: 0,
    written: 0,
    truncated: false,
    reasonCode: null,
  };
  const result = await clientOutcomeStorage.run(outcome, fn);
  return { result, outcome };
}

/**
 * A stop condition for the walks below, set by a caller that runs under a
 * time limit (the full-history backfill, which runs under its pg-boss job's
 * budget and abort signal). A walk asks it before each request and, when it
 * says stop, ends there and reports itself truncated, the same outcome as
 * reaching the page ceiling: the resource is incomplete, the cycle is not
 * stamped, and the reason shown is that only part of the history was
 * processed. Outside such a scope the walks never stop early.
 */
const stopStorage = new AsyncLocalStorage<() => boolean>();

function stopRequested(): boolean {
  return stopStorage.getStore()?.() === true;
}

export async function runWithGoogleHealthStop<T>(
  shouldStop: () => boolean,
  fn: () => Promise<T>,
): Promise<T> {
  return stopStorage.run(shouldStop, fn);
}

export const GOOGLE_HEALTH_API_BASE = "https://health.googleapis.com/v4";
const GOOGLE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleHealthCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Resolve the OAuth `redirect_uri`, then assert it against an allowlist
 * (defence-in-depth).
 *
 * The value is operator-controlled config (`GOOGLE_HEALTH_REDIRECT_URI`, else
 * derived from `NEXT_PUBLIC_APP_URL`), not user input, so Google's
 * registered-redirect check is the real backstop. But a misconfigured or
 * `Host`-coerced `NEXT_PUBLIC_APP_URL` (a mis-deployed reverse proxy reflecting
 * a forwarded Host) would otherwise send the authorization code's landing URL
 * off-origin. Pin the target here so a malformed origin fails fast at the
 * handshake rather than silently redirecting elsewhere:
 *   - must be an absolute, parseable URL,
 *   - must be https (the one exception is a localhost/loopback dev host, which
 *     Google itself permits over http),
 *   - must land on the fixed `/api/google-health/callback` path,
 *   - when derived from `NEXT_PUBLIC_APP_URL`, must stay same-origin with it.
 */
export function getGoogleHealthRedirectUri(): string {
  // An empty or blank value counts as unset: the compose whitelist
  // materialises an unset var as an empty string, which must fall through to
  // the derived URI rather than read as "not configured".
  const explicit = envValue("GOOGLE_HEALTH_REDIRECT_URI");
  const appUrl = envValue("NEXT_PUBLIC_APP_URL");
  const raw =
    explicit ?? (appUrl ? `${appUrl}/api/google-health/callback` : undefined);

  if (!raw) {
    throw new Error(
      "Google Health redirect_uri is not configured — set GOOGLE_HEALTH_REDIRECT_URI or NEXT_PUBLIC_APP_URL",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `Google Health redirect_uri is not an absolute URL: ${raw}`,
    );
  }

  const isLoopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "::1";
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopback)
  ) {
    throw new Error(
      `Google Health redirect_uri must be https (or http on localhost): ${parsed.origin}`,
    );
  }

  if (parsed.pathname !== "/api/google-health/callback") {
    throw new Error(
      `Google Health redirect_uri must target /api/google-health/callback, got ${parsed.pathname}`,
    );
  }

  // When an explicit GOOGLE_HEALTH_REDIRECT_URI is set alongside
  // NEXT_PUBLIC_APP_URL, require them to share an origin so the pinned value
  // can't drift to an unexpected host relative to the app's own base URL.
  if (explicit && appUrl) {
    let appOrigin: string;
    try {
      appOrigin = new URL(appUrl).origin;
    } catch {
      throw new Error(`NEXT_PUBLIC_APP_URL is not an absolute URL: ${appUrl}`);
    }
    if (parsed.origin !== appOrigin) {
      throw new Error(
        `Google Health redirect_uri origin ${parsed.origin} does not match NEXT_PUBLIC_APP_URL origin ${appOrigin}`,
      );
    }
  }

  return parsed.toString();
}

/**
 * The four core Restricted read scopes HealthLog requests for v1. Every scope
 * is Restricted → the operator's OAuth client needs Google verification + an
 * annual CASA assessment before it leaves "Testing" publishing mode (staying in
 * Testing with ≤100 test users avoids CASA at the cost of a 7-day refresh-token
 * expiry).
 */
export const GOOGLE_HEALTH_CORE_SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  "https://www.googleapis.com/auth/googlehealth.profile.readonly",
] as const;

/**
 * Resolve the scope list HealthLog requests: the four core Restricted bundles.
 * ECG/IRN are a future enhancement — add those two Restricted read scopes only
 * together with an ECG/IRN reader, never before (Google penalizes requesting a
 * Restricted scope the app never consumes).
 */
export function resolveGoogleHealthScopes(): string[] {
  return [...GOOGLE_HEALTH_CORE_SCOPES];
}

/** The space-separated scope string sent on the authorize request. */
export function getGoogleHealthScopeString(): string {
  return resolveGoogleHealthScopes().join(" ");
}

// ─── PKCE ──────────────────────────────────────────────────────
//
// Google's authorization-code flow accepts S256 PKCE. The verifier is a
// high-entropy random string; the challenge is BASE64URL(SHA256(verifier)). The
// verifier is stashed on the OAuth-state row at connect and presented on the
// token exchange at callback — never in the cookie or the URL.

export interface GoogleHealthPkcePair {
  verifier: string;
  challenge: string;
}

/**
 * Mint a PKCE verifier + S256 challenge. 64 random bytes → 86 base64url chars,
 * comfortably inside the RFC 7636 43–128 char verifier range and well past the
 * 256-bit entropy floor.
 */
export function generatePkcePair(): GoogleHealthPkcePair {
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Build the Google authorization URL (a browser redirect, not a fetch). `state`
 * is the opaque CSRF nonce minted by `oauth-state.ts`; `codeChallenge` is the
 * S256 PKCE challenge whose verifier the callback presents on token exchange.
 *
 * `access_type=offline` + `prompt=consent` are Google's requirement to receive
 * a refresh token; `prompt=consent` forces the consent screen so a re-connect
 * always returns a fresh refresh token even if the user previously granted.
 */
export function getAuthorizationUrl(
  state: string,
  creds: GoogleHealthCredentials,
  codeChallenge: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: creds.clientId,
    redirect_uri: getGoogleHealthRedirectUri(),
    scope: getGoogleHealthScopeString(),
    access_type: "offline",
    prompt: "consent",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  return `${GOOGLE_OAUTH_AUTH_URL}?${params}`;
}

export interface GoogleHealthTokenResponse {
  access_token: string;
  /**
   * Present on the initial code exchange and whenever Google issues a new
   * refresh token; ABSENT on a routine refresh because Google does not rotate.
   * The sync layer keeps the stored token when this is missing.
   */
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

/** Basic-auth header carrying the confidential client credentials. */
function basicAuthHeader(creds: GoogleHealthCredentials): string {
  const raw = `${creds.clientId}:${creds.clientSecret}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

async function postToken(
  params: URLSearchParams,
  creds: GoogleHealthCredentials,
  verb: string,
): Promise<GoogleHealthTokenResponse> {
  const start = performance.now();
  const res = await safeFetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(creds),
    },
    body: params.toString(),
  });

  const json = await res.json().catch(() => null);
  const verdict = classifyGoogleHealthResponse(res.status);
  const upstreamError =
    typeof json?.error === "string" ? (json.error as string) : undefined;

  // Google signals a revoked / expired refresh token — the user disconnected
  // the app upstream, OR the 7-day "Testing"-mode refresh window lapsed — via
  // `invalid_grant` on the token endpoint (sometimes a 400, sometimes a 401). A
  // bare status classification buckets a 400 as `persistent` (never prompts a
  // reconnect); lift an `invalid_grant` onto `reauth_required` so the connection
  // surfaces the reconnect CTA. A 401 already classifies as `reauth_required`.
  const classification: GoogleHealthClassification =
    upstreamError === "invalid_grant"
      ? "reauth_required"
      : verdict.classification;

  getEvent()?.addExternalCall({
    service: "google-health",
    method: verb,
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (classification !== "success") {
    throw new GoogleHealthApiError({
      verb,
      classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
      upstreamError,
    });
  }
  return json as GoogleHealthTokenResponse;
}

/**
 * Exchange an authorization code for the initial token pair, presenting the
 * PKCE verifier. `redirect_uri` must exactly match the one sent to the
 * authorize endpoint.
 */
export async function exchangeCode(
  code: string,
  codeVerifier: string,
  creds: GoogleHealthCredentials,
): Promise<GoogleHealthTokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: creds.clientId,
      redirect_uri: getGoogleHealthRedirectUri(),
      code_verifier: codeVerifier,
    }),
    creds,
    "exchangeCode",
  );
}

/**
 * Refresh an expired access token. Google does NOT rotate refresh tokens — the
 * response carries a fresh `access_token` + `expires_in` but usually omits
 * `refresh_token`. The caller persists the new access token + expiry and keeps
 * the stored refresh token unless a new one is returned. The original scope is
 * preserved by Google, so no `scope` param is re-sent. A revoked / expired
 * refresh token throws a `GoogleHealthApiError` classified `reauth_required`.
 */
export async function refreshAccessToken(
  refreshToken: string,
  creds: GoogleHealthCredentials,
): Promise<GoogleHealthTokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: creds.clientId,
    }),
    creds,
    "refreshAccessToken",
  );
}

/**
 * The Google Health profile carries the external user id used as the
 * connection's `externalUserId`. A single GET, not a paginated collection.
 */
export interface GoogleHealthProfile {
  /**
   * External user identifier. Google returns `me`-relative profile data; the
   * stable id is surfaced under `name` (a `users/{id}` resource name) or `id`
   * depending on the API surface — both are captured here and resolved at the
   * call site. Re-verify the exact field against a live account at build.
   */
  name?: string;
  id?: string;
}

export async function fetchProfile(
  accessToken: string,
): Promise<GoogleHealthProfile> {
  const start = performance.now();
  const res = await safeFetch(`${GOOGLE_HEALTH_API_BASE}/users/me/profile`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await res
    .json()
    .catch(() => null)) as GoogleHealthProfile | null;
  const verdict = classifyGoogleHealthResponse(res.status);
  const apiErrorDetail =
    verdict.classification === "success"
      ? undefined
      : extractGoogleApiErrorDetail(json);
  getEvent()?.addExternalCall({
    service: "google-health",
    method: "fetchProfile",
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error:
      verdict.classification === "success"
        ? undefined
        : apiErrorDetail
          ? `${verdict.reason} ${apiErrorDetail}`
          : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new GoogleHealthApiError({
      verb: "fetchProfile",
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
      upstreamError: apiErrorDetail,
    });
  }
  return (json ?? {}) as GoogleHealthProfile;
}

/**
 * Resolve the stable external user id from a Google Health profile. The
 * `users/{id}` resource name is the canonical anchor; fall back to a bare `id`
 * or "me" so the connection always persists a non-empty `externalUserId`.
 */
export function resolveGoogleHealthUserId(
  profile: GoogleHealthProfile,
): string {
  if (profile.name) {
    const tail = profile.name.split("/").pop();
    if (tail) return tail;
  }
  if (profile.id) return profile.id;
  return "me";
}

// ─── Data-point reads (Google Health `dataPoints.list` / `:dailyRollUp`) ──────
//
// The Google Health API exposes one uniform `DataPoint` resource shape across
// every data type. Spot / daily-summary / session types are read through
// `GET /v4/users/me/dataTypes/{dataType}/dataPoints` with `nextPageToken`
// pagination; the cumulative activity types (steps / distance / active energy /
// floors) are read through `POST …/dataPoints:dailyRollUp` — their `list`
// surface returns minute-grain observation buckets (or, for floors, does not
// exist at all), so the daily totals MUST come from the rollup.
//
// Casing gotcha (three encodings per type, all pinned in
// `GOOGLE_HEALTH_DATA_TYPES` so a fetcher can never mix them up):
//   - request path:      kebab-case  (`body-fat`)
//   - `filter` predicate: snake_case (`body_fat.sample_time.physical_time`) —
//     EXCEPT daily-summary `.date` filters, where the docs contradict
//     themselves and the worked example uses the camelCase payload key; the
//     client sends camel first and falls back to snake on a first-page 400
//     (see `GoogleHealthDateFilterStyle`).
//   - response payload:   camelCase — the `DataPoint` value is a union keyed by
//     the camelCase type name (`bodyFat`, `dailyRestingHeartRate`, …) with
//     camelCase nested objects (`sampleTime.physicalTime`,
//     `interval.startTime`, `civilStartTime.date`).
//
// proto3 int64 fields arrive as JSON **strings** (`"12345"`) — every numeric
// extractor coerces numeric strings before the finite check.

/**
 * Page-size ceiling for `dataPoints.list`. The daily/intraday reads default to
 * 1440 (one-per-minute) and cap at 10 000; sleep/exercise cap at 25. The launch
 * metrics use the daily/spot reads, so the default page size is the larger.
 */
export const GOOGLE_HEALTH_PAGE_SIZE = 1000;
/** Sleep/exercise read cap — matches the Google Health 25-cap for those types. */
export const GOOGLE_HEALTH_ACTIVITY_PAGE_SIZE = 25;

/**
 * Page ceiling for the intraday heart-rate walk.
 *
 * The default of 1000 pages is a million points, which a watch that records
 * a reading a minute passes in under two years. A walk that hits the ceiling
 * reports `truncated`, the backfill treats that as incomplete and throws, and
 * pg-boss retries it — so an account with a longer history re-ran the whole
 * walk on every retry and every boot and never completed. Ten thousand pages
 * is nineteen years at that rate: still a bound on a runaway cursor, no longer
 * a bound a real history reaches. The walk is paged (`forEachDataPointPage`),
 * so the ceiling costs time, not memory.
 */
export const GOOGLE_HEALTH_DENSE_MAX_PAGES = 10_000;

/** `dataPoints.list` envelope: `{ dataPoints, nextPageToken }`. */
interface GoogleHealthDataPointPage {
  dataPoints?: GoogleHealthDataPoint[];
  nextPageToken?: string | null;
}

interface DataPointQuery {
  /** Lower-bound incremental cursor; omitted on a full backfill. */
  start?: Date;
  /** Page size (defaults to `GOOGLE_HEALTH_PAGE_SIZE`). */
  pageSize?: number;
  /** Hard ceiling on pages walked (defence against a runaway cursor). */
  maxPages?: number;
  /**
   * The user's IANA zone — needed only by the `civilStart` filter (the
   * offset-less civil bound must be the watermark's wall clock in the USER'S
   * zone). Omitted → the bound forms in UTC.
   */
  tz?: string;
  /**
   * Observes which daily-summary `.date` filter prefix style the walk settled
   * on (`camel` worked-example vs `snake` fallback) — the structure probe
   * surfaces it so a live account reports which grammar Google accepted.
   */
  onDateFilterStyle?: (style: GoogleHealthDateFilterStyle) => void;
}

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

/**
 * Walk every `DataPoint` for one data type since the incremental cursor via
 * `dataPoints.list` with `nextPageToken` pagination. The data-type id is
 * kebab-cased in the path; the `filter` predicate is built per-shape against
 * the type's time anchor. `rollup` types refuse — they read via
 * `fetchDailyRollUp`.
 *
 * DAILY-SUMMARY FILTER FALLBACK: the docs contradict themselves on the `.date`
 * filter's type-name prefix (the index's "filter parameter" column says
 * snake_case; the list reference's only worked example says camelCase — see
 * `GoogleHealthDateFilterStyle`). The walk sends the camelCase worked-example
 * form first; if the VERY FIRST request of the walk is rejected with a 400,
 * the whole walk retries once with the snake_case form. The style that
 * succeeded is annotated as `googleHealth.dateFilter.style` so live behaviour
 * reports which grammar Google actually accepts. Any other failure, or a 400
 * past the first request, propagates.
 */
export async function fetchDataPoints(
  dataType: GoogleHealthDataType,
  accessToken: string,
  verb: string,
  query: DataPointQuery = {},
): Promise<GoogleHealthDataPoint[]> {
  const points: GoogleHealthDataPoint[] = [];
  await forEachDataPointPage(dataType, accessToken, verb, query, (page) => {
    for (const p of page) points.push(p);
  });
  return points;
}

/**
 * The same walk as `fetchDataPoints`, handing each page to `onPage` as it
 * arrives instead of collecting the whole collection first.
 *
 * A dense collection has to be read this way. Intraday heart rate is one
 * point a minute, so a full-history backfill of two years is over a million
 * points; held as parsed JSON and then again as mapped readings, that is more
 * than a 1 GB heap, and the process that runs the backfill also serves the
 * app. Page by page, only one page is ever resident.
 *
 * `onPage` is awaited before the next page is requested, so a slow write
 * applies back-pressure to the fetch. The date-filter fallback still works:
 * it only fires when the first request is rejected, which is before any page
 * reaches `onPage`.
 */
export async function forEachDataPointPage(
  dataType: GoogleHealthDataType,
  accessToken: string,
  verb: string,
  query: DataPointQuery,
  onPage: (points: GoogleHealthDataPoint[]) => void | Promise<void>,
): Promise<void> {
  const maxPages = query.maxPages ?? 1000;
  const pageSize = query.pageSize ?? GOOGLE_HEALTH_PAGE_SIZE;

  let requestCount = 0;

  const walk = async (
    dateStyle: GoogleHealthDateFilterStyle,
  ): Promise<void> => {
    let fetched = 0;
    let pageToken: string | null | undefined;
    let pageCount = 0;
    let stopped = false;

    do {
      if (stopRequested()) {
        stopped = true;
        break;
      }
      const params = new URLSearchParams({ pageSize: String(pageSize) });
      if (query.start) {
        const { field, bound } = incrementalFilter(
          dataType,
          query.start,
          query.tz,
          dateStyle,
        );
        params.set("filter", `${field} >= "${bound}"`);
      }
      if (pageToken) params.set("pageToken", pageToken);

      requestCount += 1;
      const pageStart = performance.now();
      const res = await safeFetch(
        `${GOOGLE_HEALTH_API_BASE}/users/me/dataTypes/${dataType.path}/dataPoints?${params}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );

      const json = (await res
        .json()
        .catch(() => null)) as GoogleHealthDataPointPage | null;
      const verdict = classifyGoogleHealthResponse(res.status);
      const apiErrorDetail =
        verdict.classification === "success"
          ? undefined
          : extractGoogleApiErrorDetail(json);
      // v1.42 (#1023) — the first filtered daily-summary read answering 400
      // is the expected trigger for the snake_case retry below, not a
      // failure: some accounts reject the documented camelCase prefix on
      // some types, and the very next request answers 200. It was logged as
      // an error next to the 200 that followed it. It is recorded as a note
      // now; any other 400 still carries its error.
      const expectedFallback =
        canFallBack &&
        dateStyle === "camel" &&
        requestCount === 1 &&
        res.status === 400;
      getEvent()?.addExternalCall({
        service: "google-health",
        method: `${verb}(page=${pageCount})`,
        duration_ms: Math.round(performance.now() - pageStart),
        status: res.status,
        ...(expectedFallback
          ? { note: "date_filter_rejected_retrying_snake_case" }
          : {
              error:
                verdict.classification === "success"
                  ? undefined
                  : apiErrorDetail
                    ? `${verdict.reason} ${apiErrorDetail}`
                    : verdict.reason,
            }),
      });
      if (verdict.classification !== "success") {
        throw new GoogleHealthApiError({
          verb,
          classification: verdict.classification,
          httpStatus: verdict.httpStatus,
          reason: verdict.reason,
          upstreamError: apiErrorDetail,
        });
      }

      const page = json?.dataPoints ?? [];
      pageToken = json?.nextPageToken ?? null;
      pageCount += 1;
      fetched += page.length;
      await onPage(page);
    } while (pageToken && pageCount < maxPages);

    notePagination(pageCount, fetched, stopped || Boolean(pageToken));
  };

  // The fallback only exists for filtered daily-summary reads — every other
  // shape has one documented, doc-consistent filter field.
  const canFallBack =
    dataType.timeField === "date" && query.start !== undefined;

  let style: GoogleHealthDateFilterStyle = "camel";
  try {
    await walk("camel");
  } catch (err) {
    const firstRequestRejected =
      canFallBack &&
      requestCount === 1 &&
      err instanceof GoogleHealthApiError &&
      err.httpStatus === 400;
    if (!firstRequestRejected) throw err;
    style = "snake";
    await walk("snake");
  }
  if (canFallBack) {
    annotate({ meta: { "googleHealth.dateFilter.style": style } });
    query.onDateFilterStyle?.(style);
  }
}

// ─── Daily roll-up reads (`POST …/dataPoints:dailyRollUp`) ─────────────────

/**
 * Max civil days one dailyRollUp request range may span. Per the v4 reference
 * (`users.dataTypes.dataPoints/dailyRollUp`, `range`): "The maximum range for
 * `calories-in-heart-rate-zone`, `heart-rate`, `active-minutes` and
 * `total-calories` is 14 days. The maximum range for all other data types is
 * 90 days." The four types read here (steps / distance / active-energy-burned /
 * floors) all sit in the 90-day class; the 14-day cap would only bind if
 * `heart-rate` or `total-calories` ever moved onto the rollup path.
 */
export const GOOGLE_HEALTH_ROLLUP_RANGE_DAYS = 90;

/**
 * Conservative chunk span for the one-shot fallback walk: the tightest range
 * cap the dailyRollUp docs state for ANY data type (the 14-day class above).
 * Used only after the standard 90-day first request is rejected with a 400 —
 * see `fetchDailyRollUp`.
 */
export const GOOGLE_HEALTH_ROLLUP_FALLBACK_RANGE_DAYS = 14;

/**
 * Full-sync horizon for the rollup types, in civil days. The rollup read needs
 * an explicit range (unlike the unbounded list walk), so the backfill is
 * pinned: 5 years ≈ 21 chunks per type — bounded, and deeper than any
 * wearable-history horizon the dashboard reads.
 */
export const GOOGLE_HEALTH_ROLLUP_BACKFILL_DAYS = 5 * 365;

/** A civil calendar date (1-based month), the dailyRollUp range unit. */
export interface GoogleHealthCivilDate {
  year: number;
  month: number;
  day: number;
}

/** The civil date an observer in `tz` reads at `instant` (UTC without `tz`). */
export function civilDateInTz(
  instant: Date,
  tz?: string,
): GoogleHealthCivilDate {
  if (!tz) {
    return {
      year: instant.getUTCFullYear(),
      month: instant.getUTCMonth() + 1,
      day: instant.getUTCDate(),
    };
  }
  const p = wallClockInTz(instant, tz);
  return { year: p.year, month: p.month, day: p.day };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function civilToUtcMs(d: GoogleHealthCivilDate): number {
  return Date.UTC(d.year, d.month - 1, d.day);
}

function utcMsToCivil(ms: number): GoogleHealthCivilDate {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/**
 * Split a closed-open civil range into ≤`maxDays` closed-open chunks — the
 * dailyRollUp request range caps at 90 days, so a multi-year backfill walks the
 * range in slices. Returns an empty list when `start >= end`.
 */
export function chunkCivilRange(
  start: GoogleHealthCivilDate,
  endExclusive: GoogleHealthCivilDate,
  maxDays: number = GOOGLE_HEALTH_ROLLUP_RANGE_DAYS,
): Array<{ start: GoogleHealthCivilDate; end: GoogleHealthCivilDate }> {
  const s = civilToUtcMs(start);
  const e = civilToUtcMs(endExclusive);
  const out: Array<{
    start: GoogleHealthCivilDate;
    end: GoogleHealthCivilDate;
  }> = [];
  for (let cur = s; cur < e; cur += maxDays * DAY_MS) {
    const chunkEnd = Math.min(cur + maxDays * DAY_MS, e);
    out.push({ start: utcMsToCivil(cur), end: utcMsToCivil(chunkEnd) });
  }
  return out;
}

/** `dataPoints:dailyRollUp` envelope. */
interface GoogleHealthRollupPage {
  rollupDataPoints?: GoogleHealthRollupPoint[];
  nextPageToken?: string | null;
}

interface RollupQuery {
  /** Lower-bound incremental cursor; a full backfill walks the pinned horizon. */
  start?: Date;
  /** The user's IANA zone — the civil range is user-local. */
  tz?: string;
  /**
   * Observes which request shape the walk settled on (`days90` standard vs
   * `days14` fallback) — the structure probe surfaces it so a live account
   * reports which shape Google actually accepted.
   */
  onShape?: (shape: GoogleHealthRollupShape) => void;
  /**
   * Observes the raw top-level KEY NAMES of the first response page (never
   * values). A rollup read that parses zero points is ambiguous — the service
   * either returned nothing (account-side materialisation) or returned points
   * under an envelope key this reader does not know (a per-cohort naming
   * drift, the class of mismatch this integration has hit three times). The
   * structure probe surfaces these keys so a live account settles it in one
   * report: `["rollupDataPoints"]` = genuinely empty, anything else = drift.
   */
  onEnvelopeKeys?: (keys: string[]) => void;
}

/** The dailyRollUp request shape a walk settled on. */
export type GoogleHealthRollupShape = "days90" | "days14";

/**
 * Build the documented dailyRollUp request body for one closed-open civil-day
 * chunk (`end` exclusive). Doc-example parity (developers.google.com/health/
 * endpoints, dailyRollUp sample): both range bounds carry explicit
 * `{date, time}` CivilDateTime objects, and the `end` bound is the LAST civil
 * day INSIDE the chunk at 23:59:59 — NOT the next day's midnight. The range
 * validator counts the civil days the range touches against the documented
 * cap, so an exclusive next-day-midnight end makes a maximal chunk read one
 * day too wide. `windowSizeDays: 1` is the documented daily-total window;
 * `pageSize` is omitted (the documented default of 1440 already covers the
 * ≤90 daily windows a chunk can produce); `pageToken` rides along on
 * follow-up pages ("All other request fields need to be the same as in the
 * initial request when the page token is specified").
 */
export function buildDailyRollUpBody(
  chunk: { start: GoogleHealthCivilDate; end: GoogleHealthCivilDate },
  pageToken?: string,
): Record<string, unknown> {
  const lastDay = utcMsToCivil(civilToUtcMs(chunk.end) - DAY_MS);
  const body: Record<string, unknown> = {
    range: {
      start: {
        date: chunk.start,
        time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 },
      },
      end: {
        date: lastDay,
        time: { hours: 23, minutes: 59, seconds: 59, nanos: 0 },
      },
    },
    windowSizeDays: 1,
  };
  if (pageToken) body.pageToken = pageToken;
  return body;
}

/**
 * Read one cumulative data type's daily totals via `POST …/dataPoints:dailyRollUp`
 * with `windowSizeDays: 1`. The civil range is user-local, chunked at ≤90 days
 * per request (the documented cap for these types); without an incremental
 * `start` the walk covers the pinned backfill horizon. A `nextPageToken` is
 * honoured defensively (the dailyRollUp response is documented without one,
 * but the request accepts page tokens and the sibling `:rollUp` documents the
 * response field).
 *
 * FALLBACK: if the very first request of a walk is rejected with a 400
 * (INVALID_ARGUMENT — a range/shape constraint, since the body already
 * mirrors the documented example), the whole range is re-walked once with the
 * most conservative documented span (14 days, the tightest cap the docs state
 * for any type). The shape that succeeded is annotated as
 * `googleHealth.rollup.shape` so live behaviour reports which constraint
 * actually binds. Any other failure, or a 400 past the first request,
 * propagates.
 */
export async function fetchDailyRollUp(
  dataType: GoogleHealthDataType,
  accessToken: string,
  verb: string,
  query: RollupQuery = {},
): Promise<GoogleHealthRollupPoint[]> {
  const now = new Date();
  const from =
    query.start ??
    new Date(now.getTime() - GOOGLE_HEALTH_ROLLUP_BACKFILL_DAYS * DAY_MS);
  // End exclusive at tomorrow (user-local) so today's running total is covered.
  const startCivil = civilDateInTz(from, query.tz);
  const endCivil = civilDateInTz(new Date(now.getTime() + DAY_MS), query.tz);

  let requestCount = 0;

  const walk = async (maxDays: number): Promise<GoogleHealthRollupPoint[]> => {
    const points: GoogleHealthRollupPoint[] = [];
    let chunkIndex = 0;
    let totalPages = 0;
    let truncated = false;
    for (const chunk of chunkCivilRange(startCivil, endCivil, maxDays)) {
      if (stopRequested()) {
        truncated = true;
        break;
      }
      let pageToken: string | null | undefined;
      let pageCount = 0;
      do {
        const body = buildDailyRollUpBody(chunk, pageToken ?? undefined);

        requestCount += 1;
        const reqStart = performance.now();
        const res = await safeFetch(
          `${GOOGLE_HEALTH_API_BASE}/users/me/dataTypes/${dataType.path}/dataPoints:dailyRollUp`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          },
        );
        const json = (await res
          .json()
          .catch(() => null)) as GoogleHealthRollupPage | null;
        const verdict = classifyGoogleHealthResponse(res.status);
        const apiErrorDetail =
          verdict.classification === "success"
            ? undefined
            : extractGoogleApiErrorDetail(json);
        getEvent()?.addExternalCall({
          service: "google-health",
          method: `${verb}(chunk=${chunkIndex},page=${pageCount})`,
          duration_ms: Math.round(performance.now() - reqStart),
          status: res.status,
          error:
            verdict.classification === "success"
              ? undefined
              : apiErrorDetail
                ? `${verdict.reason} ${apiErrorDetail}`
                : verdict.reason,
        });
        if (verdict.classification !== "success") {
          throw new GoogleHealthApiError({
            verb,
            classification: verdict.classification,
            httpStatus: verdict.httpStatus,
            reason: verdict.reason,
            upstreamError: apiErrorDetail,
          });
        }

        // Surface the raw envelope key names of the very first page (names
        // only, never values) — see `RollupQuery.onEnvelopeKeys`.
        if (
          chunkIndex === 0 &&
          pageCount === 0 &&
          json &&
          typeof json === "object"
        ) {
          query.onEnvelopeKeys?.(Object.keys(json));
        }
        for (const p of json?.rollupDataPoints ?? []) points.push(p);
        pageToken = json?.nextPageToken ?? null;
        pageCount += 1;
      } while (pageToken && pageCount < 100);
      totalPages += pageCount;
      truncated ||= Boolean(pageToken);
      chunkIndex += 1;
    }
    notePagination(totalPages, points.length, truncated);
    return points;
  };

  let shape: GoogleHealthRollupShape = "days90";
  let points: GoogleHealthRollupPoint[];
  try {
    points = await walk(GOOGLE_HEALTH_ROLLUP_RANGE_DAYS);
  } catch (err) {
    const firstRequestRejected =
      requestCount === 1 &&
      err instanceof GoogleHealthApiError &&
      err.httpStatus === 400;
    if (!firstRequestRejected) throw err;
    shape = "days14";
    points = await walk(GOOGLE_HEALTH_ROLLUP_FALLBACK_RANGE_DAYS);
  }
  annotate({ meta: { "googleHealth.rollup.shape": shape } });
  query.onShape?.(shape);
  return points;
}
