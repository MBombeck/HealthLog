/**
 * Fitbit Web API client — classic `api.fitbit.com` transport (v1.20.0).
 * Docs: https://dev.fitbit.com/build/reference/web-api/
 *
 * v1.20.0 retargets the Fitbit integration from the Google Health API
 * (`health.googleapis.com`, Restricted scopes behind brand-verification + an
 * annual CASA assessment — a hard adoption wall for self-hosters) onto the
 * CLASSIC Fitbit Web API. A self-hoster registers an app at dev.fitbit.com in
 * minutes (no CASA), so this is the path that actually ships to users.
 *
 * Only the TRANSPORT layer is forked: the auth/token URLs, PKCE handshake,
 * classic scopes, rotating-refresh-token handling, per-endpoint REST fetchers,
 * and the classic-shape value extractors. Everything downstream — the
 * `FitbitMappedMeasurement` / `FitbitMappedWorkout` output shapes, the
 * upsert/dedup/rollup tail in `sync.ts`, the source-priority ladders, the
 * settings card, the rotation registry, the poll worker, the backfill — reuses
 * unchanged.
 *
 * KEY DELTAS vs the prior Google transport:
 *  - PKCE (S256). Fitbit recommends PKCE; we mint a `code_verifier` at connect,
 *    stash it on the OAuth-state row, and present it on the token exchange. The
 *    confidential client secret still rides in the Basic-auth header (Fitbit
 *    accepts Basic + PKCE together), so a self-hoster's secret is not the only
 *    protection.
 *  - Refresh tokens ROTATE (one-time use). The refresh response carries a NEW
 *    `refresh_token` that MUST be persisted, replacing the stored one — the
 *    inverse of the Google path. `getValidToken` (sync.ts) persists it
 *    unconditionally now.
 *  - 150 requests/hour/user rate limit (far tighter than Google). The reads are
 *    date-RANGE endpoints (one request covers a whole window, capped per the
 *    per-endpoint range limits), and the page-walk / cohort concurrency caps are
 *    re-tuned accordingly.
 *
 * NOTE (deprecation): the classic Fitbit Web API is announced for deprecation in
 * September 2026, with migration directed back at the Google Health API. Until a
 * self-serve Google path exists, the classic API is the only viable transport
 * for self-hosters; the card keeps its experimental badge.
 */
import { getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";
import { canonicalDailyTimestamp } from "@/lib/measurements/consolidation-tz";
import { zonedWallClockToUtc } from "@/lib/tz/wall-clock";
import { FitbitApiError, classifyFitbitResponse } from "./response-classifier";
import { importValue } from "@/lib/integrations/import-value";

/** Classic Fitbit Web API base. */
export const FITBIT_API_BASE = "https://api.fitbit.com";

/**
 * Fitbit returns body weight / distance in metric (kg / km) only when an
 * `Accept-Language` that maps to a metric locale is sent — the US default is
 * imperial. Pin a metric locale on every data read so the mappers can trust the
 * unit. (`en_GB` is metric for weight + distance.)
 */
const FITBIT_METRIC_LOCALE = "en_GB";

/**
 * The Fitbit profile carries the stable external user id (`encodedId`) used as
 * the connection's `fitbitUserId`. A single GET, not a paginated collection.
 */
export interface FitbitProfile {
  user?: { encodedId?: string };
}

export async function fetchProfile(
  accessToken: string,
): Promise<FitbitProfile> {
  const start = performance.now();
  const res = await safeFetch(`${FITBIT_API_BASE}/1/user/-/profile.json`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json().catch(() => null)) as FitbitProfile | null;
  const verdict = classifyFitbitResponse(res.status);
  getEvent()?.addExternalCall({
    service: "fitbit",
    method: "fetchProfile",
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new FitbitApiError({
      verb: "fetchProfile",
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
    });
  }
  return (json ?? {}) as FitbitProfile;
}

/**
 * Resolve the stable external user id from a Fitbit profile. The `encodedId` is
 * the canonical anchor; fall back to "me" so the connection always persists a
 * non-empty `fitbitUserId` even if the field is missing.
 */
export function resolveFitbitUserId(profile: FitbitProfile): string {
  return profile.user?.encodedId ?? "me";
}

// ─── Date-range reads (classic Fitbit Web API) ─────────────────
//
// Unlike the Google Health uniform `dataPoints` walker, the classic API exposes
// one bespoke endpoint per metric, each returning a date-RANGE array in its own
// JSON shape. A single request covers a whole window (no token pagination), so
// the 150 req/h budget is spent on a handful of range calls per sync rather than
// a per-day fan-out. Each endpoint caps its own range, so a deep backfill is
// chunked into per-endpoint windows by the sync layer.

/**
 * The longest date range (in days) the chunking sync layer requests per call.
 * The tightest launch endpoint cap is 30 days (body-fat, SpO2, respiratory rate,
 * VO2 max); pin the chunk to 30 so one chunk is always a single valid request.
 */
export const FITBIT_RANGE_DAYS = 30;

/** Sleep is fetched on the same 30-day chunk; one request per chunk. */
export const FITBIT_SLEEP_RANGE_DAYS = 30;

/** `YYYY-MM-DD` (UTC) for a Fitbit date-path segment. */
export function fitbitDate(d: Date): string {
  // eslint-disable-next-line healthlog/no-utc-day-key -- baseline: request window edge for the provider API, not a displayed day; rows carry their own dates
  return d.toISOString().slice(0, 10);
}

/**
 * Longest `Retry-After` delay (seconds) `fitbitGet` will sit out in-process
 * before retrying a rate-limited request.
 *
 * Fitbit's per-user budget resets on the hour, so a 429 raised near the reset
 * boundary carries a small `Retry-After` that a bounded wait turns into a
 * completed walk. A large value (an exhausted budget, up to a full hour) must
 * NOT be slept out: the poll cohort walks users sequentially, so a long hold
 * starves every other user in the tick, and inside a pg-boss job the default
 * expiration would lap the wait and admit a second execution. Above the cap the
 * request fails fast — the classified transient rides the ledger, the watermark
 * holds, and the next scheduled tick refetches the window.
 */
export const FITBIT_RETRY_AFTER_WAIT_CAP_S = 120;

/**
 * Read `Retry-After` in its delay-seconds form. Fitbit sends the seconds form;
 * the HTTP-date form is deliberately ignored (returns undefined → fail fast)
 * rather than parsed into a wait of unknown length.
 */
function parseRetryAfterSeconds(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const seconds = Number.parseInt(trimmed, 10);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function waitSeconds(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

interface FitbitGetAttempt {
  json: unknown;
  verdict: ReturnType<typeof classifyFitbitResponse>;
  retryAfterSeconds: number | undefined;
}

/** One GET attempt against a classic Fitbit endpoint, classified but not thrown. */
async function fitbitGetOnce(
  path: string,
  accessToken: string,
  verb: string,
): Promise<FitbitGetAttempt> {
  const start = performance.now();
  const res = await safeFetch(`${FITBIT_API_BASE}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Accept-Language": FITBIT_METRIC_LOCALE,
    },
  });
  const json = await res.json().catch(() => null);
  const verdict = classifyFitbitResponse(res.status);
  const retryAfterSeconds =
    res.status === 429 ? parseRetryAfterSeconds(res) : undefined;
  getEvent()?.addExternalCall({
    service: "fitbit",
    method: verb,
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error:
      verdict.classification === "success"
        ? undefined
        : retryAfterSeconds === undefined
          ? verdict.reason
          : `${verdict.reason} retry_after=${retryAfterSeconds}`,
  });
  return { json, verdict, retryAfterSeconds };
}

/**
 * GET a classic Fitbit endpoint and return the parsed JSON body.
 *
 * Honours `Retry-After` on a 429 within `FITBIT_RETRY_AFTER_WAIT_CAP_S`: the
 * request waits out the delay and retries ONCE. A missing header, a delay above
 * the cap, or a second 429 throws exactly as an unhandled failure would — the
 * classified error carries `retryAfterSeconds` so the wide event records what
 * the upstream asked for.
 */
async function fitbitGet(
  path: string,
  accessToken: string,
  verb: string,
): Promise<unknown> {
  const toError = (attempt: FitbitGetAttempt): FitbitApiError =>
    new FitbitApiError({
      verb,
      classification: attempt.verdict.classification,
      httpStatus: attempt.verdict.httpStatus,
      reason: attempt.verdict.reason,
      retryAfterSeconds: attempt.retryAfterSeconds,
    });

  const first = await fitbitGetOnce(path, accessToken, verb);
  if (first.verdict.classification === "success") return first.json;

  const wait = first.retryAfterSeconds;
  if (wait === undefined || wait > FITBIT_RETRY_AFTER_WAIT_CAP_S) {
    throw toError(first);
  }

  await waitSeconds(wait);
  const second = await fitbitGetOnce(path, accessToken, verb);
  if (second.verdict.classification === "success") return second.json;
  throw toError(second);
}

// ─── Field → Measurement mapping ───────────────────────────────
// The single source of truth is `src/lib/fitbit/mapping.md` — keep both in sync
// when adding entries. Every mapper takes the parsed endpoint body and returns
// `FitbitMappedMeasurement[]` (the source + final externalId are stamped by the
// sync layer).

/** Finite + strictly-positive guard. */
function positive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** Finite + non-negative guard — cumulative metrics admit a legitimate 0. */
function nonNegative(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/**
 * Coerce a Fitbit value that may arrive as a number OR a numeric string (the
 * activity time-series returns string values, e.g. `"2504"`). Returns null when
 * not finite.
 */
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Validate a Fitbit `YYYY-MM-DD` civil date and return it as a day key, or
 * null for an unparseable string. The key names the row's externalId; the
 * row's instant is the key's local noon in the user's zone
 * (`canonicalDailyTimestamp`), which reads the same calendar day there.
 * Noon UTC, the previous anchor, is already the next day from UTC+13 on.
 */
function parseCivilKey(dateStr: unknown): string | null {
  if (typeof dateStr !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * A single mapped Fitbit reading destined for one `Measurement` row. The
 * `source` (`FITBIT`) and final `externalId` are stamped by the sync layer; the
 * mapper emits type/value/unit/measuredAt + the field-tag that forms the
 * externalId.
 */
export interface FitbitMappedMeasurement {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  /** Full externalId payload for the row (`<anchor>:<tag>` / `<tag>:<day>`). */
  fieldTag: string;
  /** Per-stage sleep rows carry the SleepStage; everything else omits it. */
  sleepStage?: FitbitSleepStage;
  /**
   * `true` when the externalId carries the `stats:` daily-total prefix (the
   * cumulative activity metrics). The sync layer reads this flag to assemble the
   * `stats:<tag>:<YYYY-MM-DD>` overwrite-in-place shape (matching the
   * Apple-Health daily-total contract).
   */
  cumulativeDaily?: boolean;
}

/** HealthLog `SleepStage` values a Fitbit sleep stage maps onto. */
export type FitbitSleepStage =
  "IN_BED" | "AWAKE" | "ASLEEP" | "REM" | "CORE" | "DEEP";

// ── Weight + body fat (/body/log/{weight,fat}) ─────────────────
//
// GET /1/user/-/body/log/weight/date/{start}/{end}.json
//   → { weight: [{ date, time, weight, logId, bmi, fat?, source }] }
// GET /1/user/-/body/log/fat/date/{start}/{end}.json
//   → { fat:    [{ date, time, fat,   logId, source }] }
// Weight is kg under the metric Accept-Language. The `logId` is a stable
// per-reading id → a re-fetch overwrites in place.

interface FitbitBodyLogEntry {
  date?: string;
  time?: string;
  logId?: number;
  weight?: number;
  fat?: number;
}

/**
 * Resolve the measuredAt for a body-log entry from its `date` + `time`. Both
 * are the user's local wall clock (Fitbit logs carry no offset), so they are
 * read in the user's zone. Reading them as UTC put a morning weigh-in hours
 * off, and on the previous or next day for anyone far from UTC.
 */
function bodyLogInstant(entry: FitbitBodyLogEntry, tz?: string): Date {
  const date = typeof entry.date === "string" ? entry.date : undefined;
  const time = typeof entry.time === "string" ? entry.time : "12:00:00";
  if (date) {
    const d = parseLocalInstant(`${date}T${time}`, tz ?? "UTC");
    if (d) return d;
    const civil = parseCivilKey(date);
    if (civil) return canonicalDailyTimestamp(civil, tz);
  }
  return new Date();
}

/**
 * Stable anchor for a body-log externalId — the logId, else the logged wall
 * clock. The wall clock is spelled the way earlier versions spelled it (as
 * if it were UTC), so an entry without a logId keeps its externalId.
 */
function bodyLogAnchor(entry: FitbitBodyLogEntry): string {
  if (typeof entry.logId === "number" && Number.isFinite(entry.logId)) {
    return String(entry.logId);
  }
  const date = typeof entry.date === "string" ? entry.date : undefined;
  const time = typeof entry.time === "string" ? entry.time : "12:00:00";
  const asWritten = date ? new Date(`${date}T${time}Z`) : null;
  return asWritten && !Number.isNaN(asWritten.getTime())
    ? asWritten.toISOString()
    : bodyLogInstant(entry).toISOString();
}

export function mapWeight(
  body: unknown,
  tz?: string,
): FitbitMappedMeasurement[] {
  const arr = readArray(body, "weight");
  const out: FitbitMappedMeasurement[] = [];
  for (const raw of arr) {
    const e = raw as FitbitBodyLogEntry;
    if (!positive(e.weight)) continue;
    out.push({
      type: "WEIGHT",
      value: importValue(e.weight),
      unit: "kg",
      measuredAt: bodyLogInstant(e, tz),
      fieldTag: `${bodyLogAnchor(e)}:weight`,
    });
  }
  return out;
}

export function mapBodyFat(
  body: unknown,
  tz?: string,
): FitbitMappedMeasurement[] {
  const arr = readArray(body, "fat");
  const out: FitbitMappedMeasurement[] = [];
  for (const raw of arr) {
    const e = raw as FitbitBodyLogEntry;
    if (!positive(e.fat)) continue;
    out.push({
      type: "BODY_FAT",
      value: importValue(e.fat),
      unit: "%",
      measuredAt: bodyLogInstant(e, tz),
      fieldTag: `${bodyLogAnchor(e)}:body_fat`,
    });
  }
  return out;
}

// ── Daily-summary metrics keyed on a civil date ────────────────
//
// SpO2, HRV, resting HR, respiratory rate, and VO2 max are one reading per
// calendar day. The externalId is day-keyed so a re-fetch of the same day
// overwrites in place. The reading is dropped (not zero-filled) when its value
// is absent or non-positive — these metrics are all strictly positive.

/** A `{ dateTime, value: {...} }` daily-summary row. */
interface FitbitDailyRow {
  dateTime?: string;
  value?: unknown;
}

/**
 * Map a list of daily-summary rows pulling `value[leaf]` (or an alt leaf) into
 * one strictly-positive Measurement per day, day-keyed externalId.
 */
function mapDailySummary(
  rows: FitbitDailyRow[],
  spec: {
    type: string;
    unit: string;
    fieldTag: string;
    leaves: string[];
    factor?: number;
  },
  tz: string | undefined,
): FitbitMappedMeasurement[] {
  const out: FitbitMappedMeasurement[] = [];
  for (const row of rows) {
    const day = parseCivilKey(row.dateTime);
    if (!day) continue;
    const value = firstPositiveLeaf(row.value, spec.leaves);
    if (value === null) continue;
    const scaled = spec.factor ? value * spec.factor : value;
    out.push({
      type: spec.type,
      value: importValue(scaled),
      unit: spec.unit,
      measuredAt: canonicalDailyTimestamp(day, tz),
      fieldTag: `${day}:${spec.fieldTag}`,
    });
  }
  return out;
}

/** First strictly-positive `obj[leaf]` across candidate leaves, or null. */
function firstPositiveLeaf(obj: unknown, leaves: string[]): number | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  for (const leaf of leaves) {
    if (positive(o[leaf])) return o[leaf] as number;
  }
  return null;
}

export function mapOxygenSaturation(
  body: unknown,
  tz?: string,
): FitbitMappedMeasurement[] {
  // The SpO2 summary endpoint returns a BARE ARRAY of daily rows (not wrapped).
  const rows = Array.isArray(body) ? (body as FitbitDailyRow[]) : [];
  return mapDailySummary(
    rows,
    {
      type: "OXYGEN_SATURATION",
      unit: "%",
      fieldTag: "spo2",
      leaves: ["avg"],
    },
    tz,
  );
}

export function mapHeartRateVariability(
  body: unknown,
  tz?: string,
): FitbitMappedMeasurement[] {
  // Fitbit's HRV summary is an RMSSD estimator (`value.dailyRmssd`), so it lands
  // in `HRV_RMSSD` beside WHOOP / Oura / Polar. `HEART_RATE_VARIABILITY` is the
  // SDNN series; the two estimators are not interchangeable, and a Fitbit night
  // ranked into the SDNN ladder used to splice RMSSD values into an Apple
  // Watch SDNN series day by day.
  const rows = readArray(body, "hrv") as FitbitDailyRow[];
  return mapDailySummary(
    rows,
    {
      type: "HRV_RMSSD",
      unit: "ms",
      fieldTag: "hrv",
      leaves: ["dailyRmssd"],
    },
    tz,
  );
}

export function mapRespiratoryRate(
  body: unknown,
  tz?: string,
): FitbitMappedMeasurement[] {
  const rows = readArray(body, "br") as FitbitDailyRow[];
  return mapDailySummary(
    rows,
    {
      type: "RESPIRATORY_RATE",
      unit: "breaths/min",
      fieldTag: "resp_rate",
      leaves: ["breathingRate"],
    },
    tz,
  );
}

/**
 * Resting heart rate lives inside the heart-rate time series:
 * GET /1/user/-/activities/heart/date/{start}/{end}.json
 *   → { "activities-heart": [{ dateTime, value: { restingHeartRate } }] }
 */
export function mapRestingHeartRate(
  body: unknown,
  tz?: string,
): FitbitMappedMeasurement[] {
  const rows = readArray(body, "activities-heart") as FitbitDailyRow[];
  return mapDailySummary(
    rows,
    {
      type: "RESTING_HEART_RATE",
      unit: "bpm",
      fieldTag: "rhr",
      leaves: ["restingHeartRate"],
    },
    tz,
  );
}

/**
 * VO2 max (cardio fitness score):
 * GET /1/user/-/cardioscore/date/{start}/{end}.json
 *   → { cardioScore: [{ dateTime, value: { vo2Max: "44-48" | "45" } }] }
 * The value is a STRING that may be a single number or a range; a range resolves
 * to its midpoint. Daily latest-wins, day-keyed externalId.
 */
export function mapVo2Max(
  body: unknown,
  tz?: string,
): FitbitMappedMeasurement[] {
  const rows = readArray(body, "cardioScore") as FitbitDailyRow[];
  const out: FitbitMappedMeasurement[] = [];
  for (const row of rows) {
    const day = parseCivilKey(row.dateTime);
    if (!day) continue;
    const v = parseVo2Max(
      (row.value as Record<string, unknown> | undefined)?.vo2Max,
    );
    if (v === null || !positive(v)) continue;
    out.push({
      type: "VO2_MAX",
      value: importValue(v),
      unit: "mL/(kg·min)",
      measuredAt: canonicalDailyTimestamp(day, tz),
      fieldTag: `vo2_max:${day}`,
      cumulativeDaily: true,
    });
  }
  return out;
}

/** Parse a Fitbit VO2max value: a single number, or a "lo-hi" range midpoint. */
export function parseVo2Max(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const range = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(s);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    if (Number.isFinite(lo) && Number.isFinite(hi)) return (lo + hi) / 2;
    return null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ── Daily cumulative activity (activities time series) ─────────
//
// GET /1/user/-/activities/{steps,distance,floors,activityCalories}/date/{s}/{e}.json
//   → { "activities-{resource}": [{ dateTime, value: "<number-string>" }] }
// One daily total per civil day. The externalId carries the `stats:` daily-total
// prefix (assembled in the sync layer) so a re-fetched day overwrites in place,
// matching the Apple-Health `stats:<HK>:<YYYY-MM-DD>` contract. A rest day of 0
// is preserved (dropping it would leave a chart gap misread as missing data).
// distance is reported in km under the metric locale → ×1000 to metres.

/** Map an activity time-series body for one cumulative metric. */
function mapActivitySeries(
  body: unknown,
  spec: {
    arrayKey: string;
    type: string;
    unit: string;
    fieldTag: string;
    factor?: number;
  },
  tz: string | undefined,
): FitbitMappedMeasurement[] {
  const rows = readArray(body, spec.arrayKey) as FitbitDailyRow[];
  const out: FitbitMappedMeasurement[] = [];
  for (const row of rows) {
    const day = parseCivilKey(row.dateTime);
    if (!day) continue;
    const n = toFiniteNumber(row.value);
    if (n === null || !nonNegative(n)) continue;
    const scaled = spec.factor ? n * spec.factor : n;
    out.push({
      type: spec.type,
      value: importValue(scaled),
      unit: spec.unit,
      measuredAt: canonicalDailyTimestamp(day, tz),
      fieldTag: `${spec.fieldTag}:${day}`,
      cumulativeDaily: true,
    });
  }
  return out;
}

export function mapSteps(
  body: unknown,
  tz?: string,
): FitbitMappedMeasurement[] {
  return mapActivitySeries(
    body,
    {
      arrayKey: "activities-steps",
      type: "ACTIVITY_STEPS",
      unit: "steps",
      fieldTag: "steps",
    },
    tz,
  );
}

export function mapDistance(
  body: unknown,
  tz?: string,
): FitbitMappedMeasurement[] {
  // The metric-locale distance series reports kilometres → metres.
  return mapActivitySeries(
    body,
    {
      arrayKey: "activities-distance",
      type: "WALKING_RUNNING_DISTANCE",
      unit: "m",
      fieldTag: "distance",
      factor: 1000,
    },
    tz,
  );
}

export function mapActiveCalories(
  body: unknown,
  tz?: string,
): FitbitMappedMeasurement[] {
  // `activityCalories` is the ACTIVE portion (excludes BMR), unlike the total
  // `calories` resource.
  return mapActivitySeries(
    body,
    {
      arrayKey: "activities-activityCalories",
      type: "ACTIVE_ENERGY_BURNED",
      unit: "kcal",
      fieldTag: "active_calories",
    },
    tz,
  );
}

export function mapFloors(
  body: unknown,
  tz?: string,
): FitbitMappedMeasurement[] {
  return mapActivitySeries(
    body,
    {
      arrayKey: "activities-floors",
      type: "FLIGHTS_CLIMBED",
      unit: "flights",
      fieldTag: "floors",
    },
    tz,
  );
}

/**
 * Read a named array off a `{ key: [...] }` envelope; [] on any miss. Tolerates
 * the endpoint returning a bare array (some endpoints do) by returning it
 * directly when the key is absent but the body is itself an array.
 */
function readArray(body: unknown, key: string): unknown[] {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const v = (body as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v;
  }
  if (Array.isArray(body)) return body;
  return [];
}

// ─── Field→Measurement mapping table (mirror of mapping.md) ─────

export const FITBIT_FIELD_MAP: Record<
  string,
  { type: string; unit: string; note?: string }
> = {
  weight: {
    type: "WEIGHT",
    unit: "kg",
    note: "body/log/weight; picker ranks a real Withings scale above Fitbit",
  },
  bodyFat: { type: "BODY_FAT", unit: "%", note: "body/log/fat" },
  oxygenSaturation: {
    type: "OXYGEN_SATURATION",
    unit: "%",
    note: "spo2 summary value.avg",
  },
  heartRateVariability: {
    type: "HRV_RMSSD",
    unit: "ms",
    note: "hrv summary value.dailyRmssd (RMSSD estimator), apart from SDNN",
  },
  restingHeartRate: {
    type: "RESTING_HEART_RATE",
    unit: "bpm",
    note: "activities/heart value.restingHeartRate",
  },
  respiratoryRate: {
    type: "RESPIRATORY_RATE",
    unit: "breaths/min",
    note: "br summary value.breathingRate",
  },
  steps: {
    type: "ACTIVITY_STEPS",
    unit: "steps",
    note: "activities/steps daily total; stats: externalId overwrites; 0 valid",
  },
  distance: {
    type: "WALKING_RUNNING_DISTANCE",
    unit: "m",
    note: "activities/distance (km → m); stats: externalId overwrites",
  },
  activeCalories: {
    type: "ACTIVE_ENERGY_BURNED",
    unit: "kcal",
    note: "activities/activityCalories (ACTIVE portion only); stats: overwrites",
  },
  floors: {
    type: "FLIGHTS_CLIMBED",
    unit: "flights",
    note: "activities/floors daily total; stats: externalId overwrites",
  },
  vo2Max: {
    type: "VO2_MAX",
    unit: "mL/(kg·min)",
    note: "cardioscore value.vo2Max (range → midpoint); daily latest-wins",
  },
  sleep: {
    type: "SLEEP_DURATION",
    unit: "minutes",
    note: "1.2 sleep levels.data per-segment rows; measuredAt = segment END",
  },
  exercise: {
    type: "Workout",
    unit: "—",
    note: "activities list → Workout row (NOT a Measurement); read-time dedup",
  },
};

// ── Sleep (1.2 sleep log) ──────────────────────────────────────
//
// GET /1.2/user/-/sleep/date/{start}/{end}.json
//   → { sleep: [{ logId, startTime, endTime, levels: { data: [
//        { dateTime: "<local ISO>", level: "wake|light|deep|rem|asleep|restless|awake", seconds } ] } }] }
// One SLEEP_DURATION row per segment, `measuredAt = segment START + seconds`
// (the segment END), value = seconds → minutes. Stage labels harmonise onto the
// shared SleepStage enum. The timeline is MEASURED (real onsets), so rows are
// NOT flagged reconstructed.

/** Classic Fitbit sleep `level` → HealthLog `SleepStage`. */
const FITBIT_SLEEP_STAGE_MAP: Record<string, FitbitSleepStage> = {
  // Stages logs.
  wake: "AWAKE",
  awake: "AWAKE",
  light: "CORE", // Fitbit "light" ↔ Apple "core" (same shallow-NREM band)
  core: "CORE",
  deep: "DEEP",
  rem: "REM",
  // Classic (non-stages) logs.
  asleep: "ASLEEP",
  restless: "AWAKE",
  in_bed: "IN_BED",
  inbed: "IN_BED",
} as const;

/** Normalise a raw Fitbit sleep `level` to a `SleepStage`, or null if unknown. */
export function mapFitbitSleepStage(raw: unknown): FitbitSleepStage | null {
  if (typeof raw !== "string") return null;
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return (
    FITBIT_SLEEP_STAGE_MAP[key] ??
    FITBIT_SLEEP_STAGE_MAP[key.replace(/_/g, "")] ??
    null
  );
}

interface FitbitSleepLevelEntry {
  dateTime?: string;
  level?: string;
  seconds?: number;
}

interface FitbitSleepSession {
  logId?: number;
  startTime?: string;
  endTime?: string;
  levels?: { data?: FitbitSleepLevelEntry[] };
}

/**
 * The stable session anchor for a sleep externalId — the logId, else the start
 * (or end) instant. A re-scored night reuses the same logId → overwrites in
 * place. The fallback prefers `startTime` because it is the session's identity;
 * `endTime` moves when Fitbit revises a night's scoring, which would mint a new
 * externalId for the same session. Pre-existing rows keyed on the old endTime
 * fallback are rare (logId is normally present); a changed key simply creates
 * one fresh row.
 */
function sleepSessionAnchor(s: FitbitSleepSession, tz?: string): string {
  if (typeof s.logId === "number" && Number.isFinite(s.logId)) {
    return String(s.logId);
  }
  for (const t of [s.startTime, s.endTime]) {
    if (typeof t === "string") {
      const d = parseLocalInstant(t, tz);
      if (d) return d.toISOString();
    }
  }
  return new Date(0).toISOString();
}

/**
 * Matches an offset-less local ISO wall-clock string Fitbit emits on the classic
 * sleep + activity logs (`2020-01-26T03:02:30` / `...T03:02:30.000`). No trailing
 * `Z`, no `±hh:mm` — those denote an absolute instant and are honoured verbatim.
 */
const OFFSET_LESS_LOCAL_ISO =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

/**
 * Parse a Fitbit timestamp into a UTC instant. The classic 1.2 sleep log and the
 * activities list emit LOCAL wall-clock strings WITHOUT an offset (e.g.
 * `2020-01-26T03:02:30.000`) — the night/activity belongs to the user's local
 * clock, so the wall clock must be resolved against the USER'S timezone, not the
 * process zone. A bare `new Date(iso)` parses an offset-less string in the host
 * zone (UTC in production), which shifts a non-UTC user's segment by their UTC
 * offset and can flip the wake-day in the night reconstruction. When `tz` is
 * omitted (no user zone on the path) the host-local fallback preserves the prior
 * behaviour. Strings that DO carry an offset/`Z` are absolute and parsed as-is.
 * Returns null on a miss.
 */
function parseLocalInstant(iso: string, tz?: string): Date | null {
  const m = OFFSET_LESS_LOCAL_ISO.exec(iso.trim());
  if (m) {
    return zonedWallClockToUtc(
      {
        year: Number(m[1]),
        month: Number(m[2]),
        day: Number(m[3]),
        hour: Number(m[4]),
        minute: Number(m[5]),
        second: m[6] ? Number(m[6]) : 0,
      },
      tz,
    );
  }
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * One mapped Fitbit sleep session: the stable anchor, the session's covered time
 * window (earliest segment start → latest segment end, both UTC), and the
 * per-segment rows. The window drives the sync's replace-by-window cleanup of
 * stale rows a re-score orphaned; `rows` is what gets upserted.
 */
export interface FitbitSleepSessionMapped {
  /** Stable session anchor — also the `<anchor>:sleep:` externalId prefix. */
  anchor: string;
  /** Earliest segment start across the session (UTC), or null if none map. */
  windowStart: Date | null;
  /** Latest segment end across the session (UTC), or null if none map. */
  windowEnd: Date | null;
  rows: FitbitMappedMeasurement[];
}

/**
 * Map one Fitbit sleep session into per-SEGMENT `SLEEP_DURATION` rows plus its
 * covered window. Each segment's `dateTime` is its START; END = START + seconds.
 * value = minutes. Unknown stage labels are skipped; a session with no parseable
 * segment yields empty `rows` (and a null window).
 *
 * Each segment's fieldTag keys off the STABLE session anchor plus the segment's
 * own START instant — `<anchor>:sleep:<segment-start>` — NOT a positional index
 * and NOT the stage label. This is the fix for the re-score duplication: the
 * index renumbered (and a stage-scoped tag changed) whenever Fitbit re-scored a
 * night after the fact, minting fresh externalIds so the upsert created parallel
 * rows the night total then double-counted, with no sweep to clear the strays. A
 * segment's start instant is stable per block, and dropping the stage from the
 * key means a mere re-classification (light→deep on the same block) UPDATES the
 * row in place rather than orphaning it. Two segments of one session cannot
 * share a start instant, so the key stays unique within the session; across
 * sessions the logId anchor separates them.
 *
 * The 1.2 sleep log emits OFFSET-LESS local wall-clock timestamps, so `tz` (the
 * user's stored zone) anchors them to the correct UTC instant — without it a
 * non-UTC user's near-midnight segment END would shift by their UTC offset and
 * could land on the wrong wake-day in the night reconstruction.
 */
export function mapSleepSessionDetailed(
  session: FitbitSleepSession,
  tz?: string,
): FitbitSleepSessionMapped {
  const anchor = sleepSessionAnchor(session, tz);
  const data = session.levels?.data;
  const rows: FitbitMappedMeasurement[] = [];
  let windowStart: Date | null = null;
  let windowEnd: Date | null = null;
  if (!Array.isArray(data) || data.length === 0) {
    return { anchor, windowStart, windowEnd, rows };
  }

  for (const seg of data) {
    const stage = mapFitbitSleepStage(seg.level);
    if (!stage) continue;
    if (!positive(seg.seconds)) continue;
    const startStr = typeof seg.dateTime === "string" ? seg.dateTime : null;
    if (!startStr) continue;
    const start = parseLocalInstant(startStr, tz);
    if (!start) continue;
    const minutes = seg.seconds / 60;
    const end = new Date(start.getTime() + seg.seconds * 1000);
    if (!windowStart || start < windowStart) windowStart = start;
    if (!windowEnd || end > windowEnd) windowEnd = end;
    rows.push({
      type: "SLEEP_DURATION",
      value: importValue(minutes),
      unit: "minutes",
      measuredAt: end,
      fieldTag: `${anchor}:sleep:${start.toISOString()}`,
      sleepStage: stage,
    });
  }
  return { anchor, windowStart, windowEnd, rows };
}

/** Read the sleep-session array off the 1.2 sleep-log envelope. */
export function readSleepSessions(body: unknown): FitbitSleepSession[] {
  return readArray(body, "sleep") as FitbitSleepSession[];
}

// ── Workouts (activities list) ─────────────────────────────────
//
// GET /1/user/-/activities/list.json?afterDate=...&sort=asc&offset=0&limit=100
//   → { activities: [{ logId, activityName/activityTypeId, startTime,
//        duration(ms), calories, distance(km), averageHeartRate, ... }] }
// Each becomes a Workout row keyed on `(userId, source, externalId=logId)`.

interface FitbitActivityLogEntry {
  logId?: number;
  activityName?: string;
  activityTypeId?: number;
  startTime?: string;
  duration?: number; // milliseconds
  calories?: number;
  distance?: number; // km (metric locale)
  averageHeartRate?: number;
}

/** Classic Fitbit activity name → HealthLog `WorkoutSportType` label. */
const FITBIT_EXERCISE_TYPE_MAP: Record<string, string> = {
  walk: "walking",
  walking: "walking",
  run: "running",
  running: "running",
  treadmill: "running",
  bike: "cycling",
  biking: "cycling",
  cycling: "cycling",
  spinning: "cycling",
  hike: "hiking",
  hiking: "hiking",
  swim: "swimming",
  swimming: "swimming",
  rowing: "rowing",
  elliptical: "elliptical",
  stairclimber: "stairClimber",
  yoga: "yoga",
  pilates: "mindAndBody",
  weights: "strength",
  strength: "strength",
  workout: "strength",
  hiit: "hiit",
  interval_workout: "hiit",
  dance: "dance",
  golf: "golf",
  tennis: "tennis",
  basketball: "basketball",
  soccer: "soccer",
  bootcamp: "crossTraining",
  circuit_training: "crossTraining",
  sport: "mixedCardio",
} as const;

/** Resolve a Fitbit activity name to a canonical sport label. */
export function mapFitbitSportType(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") return "other";
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return (
    FITBIT_EXERCISE_TYPE_MAP[key] ??
    FITBIT_EXERCISE_TYPE_MAP[key.replace(/_/g, "")] ??
    "other"
  );
}

/** Raw Fitbit workout identity retained alongside the canonical sport type. */
export interface FitbitWorkoutMetadata {
  fitbitActivityName?: string;
  fitbitActivityTypeId?: number;
}

/** One mapped Fitbit activity destined for a `Workout` row. */
export interface FitbitMappedWorkout {
  externalId: string;
  sportType: string;
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
  totalEnergyKcal: number | null;
  totalDistanceM: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  minHeartRate: number | null;
  metadata: FitbitWorkoutMetadata;
}

/**
 * Map one Fitbit activity-list entry into a `Workout` shape. Returns null when
 * there is no usable start + positive duration. The externalId anchors on the
 * `logId` (stable) so a re-fetch overwrites the same row. The classic
 * activities-list endpoint does not surface min/max HR, so those stay null.
 *
 * `startTime` is an offset-less local wall-clock string, so `tz` (the user's
 * stored zone) anchors it to the correct UTC instant rather than the process
 * zone.
 */
export function mapWorkout(
  entry: FitbitActivityLogEntry,
  tz?: string,
): FitbitMappedWorkout | null {
  const start =
    typeof entry.startTime === "string"
      ? parseLocalInstant(entry.startTime, tz)
      : null;
  if (!start) return null;
  if (!positive(entry.duration)) return null;

  const durationSec = Math.round(entry.duration / 1000);
  const endedAt = new Date(start.getTime() + entry.duration);

  const externalId =
    typeof entry.logId === "number" && Number.isFinite(entry.logId)
      ? String(entry.logId)
      : `exercise:${start.toISOString()}`;

  const energyKcal = positive(entry.calories)
    ? Math.round(entry.calories)
    : null;
  // distance is km under the metric locale → metres.
  const distanceM =
    typeof entry.distance === "number" && entry.distance >= 0
      ? importValue(entry.distance * 1000)
      : null;
  const avgHr = positive(entry.averageHeartRate)
    ? Math.round(entry.averageHeartRate)
    : null;

  const metadata: FitbitWorkoutMetadata = {
    ...(typeof entry.activityName === "string"
      ? { fitbitActivityName: entry.activityName }
      : {}),
    ...(typeof entry.activityTypeId === "number" &&
    Number.isFinite(entry.activityTypeId)
      ? { fitbitActivityTypeId: entry.activityTypeId }
      : {}),
  };

  return {
    externalId,
    sportType: mapFitbitSportType(entry.activityName),
    startedAt: start,
    endedAt,
    durationSec,
    totalEnergyKcal: energyKcal,
    totalDistanceM: distanceM,
    avgHeartRate: avgHr,
    maxHeartRate: null,
    minHeartRate: null,
    metadata,
  };
}

/** Read the activity-list array off the activities/list envelope. */
export function readActivityList(body: unknown): FitbitActivityLogEntry[] {
  return readArray(body, "activities") as FitbitActivityLogEntry[];
}

// ─── Per-endpoint fetchers ─────────────────────────────────────
//
// Each returns the raw parsed body for its date-range window; the per-resource
// sync layer maps it. A single request per endpoint per chunk keeps the 150/h
// budget healthy.

export async function fetchWeightRange(
  accessToken: string,
  start: Date,
  end: Date,
): Promise<unknown> {
  return fitbitGet(
    `/1/user/-/body/log/weight/date/${fitbitDate(start)}/${fitbitDate(end)}.json`,
    accessToken,
    "fetchWeight",
  );
}

export async function fetchBodyFatRange(
  accessToken: string,
  start: Date,
  end: Date,
): Promise<unknown> {
  return fitbitGet(
    `/1/user/-/body/log/fat/date/${fitbitDate(start)}/${fitbitDate(end)}.json`,
    accessToken,
    "fetchBodyFat",
  );
}

export async function fetchSpo2Range(
  accessToken: string,
  start: Date,
  end: Date,
): Promise<unknown> {
  return fitbitGet(
    `/1/user/-/spo2/date/${fitbitDate(start)}/${fitbitDate(end)}.json`,
    accessToken,
    "fetchSpo2",
  );
}

export async function fetchHrvRange(
  accessToken: string,
  start: Date,
  end: Date,
): Promise<unknown> {
  return fitbitGet(
    `/1/user/-/hrv/date/${fitbitDate(start)}/${fitbitDate(end)}.json`,
    accessToken,
    "fetchHrv",
  );
}

export async function fetchRestingHeartRateRange(
  accessToken: string,
  start: Date,
  end: Date,
): Promise<unknown> {
  return fitbitGet(
    `/1/user/-/activities/heart/date/${fitbitDate(start)}/${fitbitDate(end)}.json`,
    accessToken,
    "fetchRhr",
  );
}

export async function fetchRespiratoryRateRange(
  accessToken: string,
  start: Date,
  end: Date,
): Promise<unknown> {
  return fitbitGet(
    `/1/user/-/br/date/${fitbitDate(start)}/${fitbitDate(end)}.json`,
    accessToken,
    "fetchRespiratoryRate",
  );
}

export async function fetchVo2MaxRange(
  accessToken: string,
  start: Date,
  end: Date,
): Promise<unknown> {
  return fitbitGet(
    `/1/user/-/cardioscore/date/${fitbitDate(start)}/${fitbitDate(end)}.json`,
    accessToken,
    "fetchVo2Max",
  );
}

/** Activity time-series for one cumulative resource (steps/distance/...). */
export async function fetchActivitySeries(
  resource: "steps" | "distance" | "floors" | "activityCalories",
  accessToken: string,
  start: Date,
  end: Date,
): Promise<unknown> {
  return fitbitGet(
    `/1/user/-/activities/${resource}/date/${fitbitDate(start)}/${fitbitDate(end)}.json`,
    accessToken,
    `fetchActivity:${resource}`,
  );
}

export async function fetchSleepRange(
  accessToken: string,
  start: Date,
  end: Date,
): Promise<unknown> {
  return fitbitGet(
    `/1.2/user/-/sleep/date/${fitbitDate(start)}/${fitbitDate(end)}.json`,
    accessToken,
    "fetchSleep",
  );
}

/**
 * Activity log list since a date. Uses the offset/limit list endpoint with
 * `afterDate` + `sort=asc`. One page of up to `limit` activities; the sync layer
 * caps the page count to stay within the rate budget.
 */
export async function fetchActivityList(
  accessToken: string,
  afterDate: Date,
  opts: { limit?: number; offset?: number } = {},
): Promise<unknown> {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  return fitbitGet(
    `/1/user/-/activities/list.json?afterDate=${fitbitDate(afterDate)}&sort=asc&offset=${offset}&limit=${limit}`,
    accessToken,
    "fetchExercise",
  );
}
