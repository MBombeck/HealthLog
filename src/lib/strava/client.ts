/**
 * Strava API v3 transport and endpoints: activity reads.
 * Docs: https://developers.strava.com/docs/reference/ (re-verify at build).
 *
 * Hand-rolled fetch over `safeFetch` (no vendor SDK). The wire shapes are
 * `./wire-types.ts`, the activity → workout mapping is `./map.ts`, the OAuth
 * handshake is `./oauth.ts`.
 *
 * Strava specifics:
 *   - It is a WORKOUT source only — the API is activity-centric and exposes no
 *     sleep / recovery / body / glucose data. It feeds `Workout` rows and only
 *     `Workout` rows. No training-depth analytics (FTP/TSS/power-curve) are
 *     derived — Strava is just another workout source.
 *   - It ROTATES its refresh token on every refresh, so the sync persists BOTH
 *     rotated tokens (the Oura reactive-refresh + compare-and-set model). There
 *     is no token-expiry column; the sync refreshes reactively on a 401.
 *   - The Activities list (`SummaryActivity`) carries distance / moving_time /
 *     elapsed_time / elevation / HR, but `calories` lives only on the
 *     per-activity `DetailedActivity` (`GET /activities/{id}`).
 *   - Rate limits: 200 requests / 15 min and 2000 / day per app. The sync walks
 *     bounded pages and fetches detail budget-aware.
 */
import { getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";
import { parseRetryAfterMs } from "@/lib/integrations/oauth-kit/retry-after";

import { StravaApiError, classifyStravaResponse } from "./response-classifier";

import type {
  StravaSummaryActivity,
  StravaDetailedActivity,
} from "./wire-types";

const STRAVA_API_BASE = "https://www.strava.com/api/v3";

export interface FetchActivitiesQuery {
  /** Epoch SECONDS cursor — return activities started after this instant. */
  after?: number;
  /** Epoch SECONDS — return activities started before this instant. */
  before?: number;
  page?: number;
  perPage?: number;
}

async function stravaGet<T>(
  path: string,
  accessToken: string,
  verb: string,
): Promise<T> {
  const start = performance.now();
  const res = await safeFetch(`${STRAVA_API_BASE}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const verdict = classifyStravaResponse(res.status);
  getEvent()?.addExternalCall({
    service: "strava",
    method: verb,
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new StravaApiError({
      verb,
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
      ...(res.status === 429
        ? { retryAfterSeconds: stravaRateLimitRetryAfterSeconds(res.headers) }
        : {}),
    });
  }
  return (await res.json().catch(() => null)) as T;
}

const QUARTER_HOUR_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long to wait after a 429, from the response's own headers. Strava sends
 * no `Retry-After` (one is honoured should it appear); it sends
 * `X-RateLimit-Limit` / `X-RateLimit-Usage` and, for reads,
 * `X-ReadRateLimit-Limit` / `X-ReadRateLimit-Usage`, each `<15-min>,<daily>`.
 * The 15-minute window resets at :00, :15, :30 and :45, the daily one at
 * midnight UTC (developers.strava.com/docs/rate-limits). A spent daily count
 * waits for midnight; anything else, the next quarter hour.
 */
export function stravaRateLimitRetryAfterSeconds(
  headers: Headers,
  now: Date = new Date(),
): number {
  const retryAfterMs = parseRetryAfterMs(
    headers.get("retry-after"),
    now.getTime(),
  );
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return Math.ceil(retryAfterMs / 1000);
  }
  const pair = (name: string): [number, number] | null => {
    const parts = (headers.get(name) ?? "").split(",").map(Number);
    return parts.length === 2 && parts.every(Number.isFinite)
      ? [parts[0]!, parts[1]!]
      : null;
  };
  const dailySpent = (limitName: string, usageName: string): boolean => {
    const limit = pair(limitName);
    const usage = pair(usageName);
    return limit !== null && usage !== null && usage[1] >= limit[1];
  };
  const nowMs = now.getTime();
  const resetAt =
    dailySpent("x-ratelimit-limit", "x-ratelimit-usage") ||
    dailySpent("x-readratelimit-limit", "x-readratelimit-usage")
      ? Math.floor(nowMs / DAY_MS) * DAY_MS + DAY_MS
      : Math.floor(nowMs / QUARTER_HOUR_MS) * QUARTER_HOUR_MS + QUARTER_HOUR_MS;
  return Math.max(1, Math.ceil((resetAt - nowMs) / 1000));
}

/** One page of the athlete's activities (newest first). */
export async function fetchActivities(
  accessToken: string,
  query: FetchActivitiesQuery = {},
): Promise<StravaSummaryActivity[]> {
  const params = new URLSearchParams();
  if (typeof query.after === "number")
    params.set("after", String(Math.floor(query.after)));
  if (typeof query.before === "number")
    params.set("before", String(Math.floor(query.before)));
  params.set("page", String(query.page ?? 1));
  params.set("per_page", String(query.perPage ?? 100));
  const json = await stravaGet<StravaSummaryActivity[] | null>(
    `/athlete/activities?${params}`,
    accessToken,
    "fetchActivities",
  );
  return Array.isArray(json) ? json : [];
}

/** One activity's `DetailedActivity` — the only source of `calories`. */
export function fetchActivityById(
  accessToken: string,
  id: number | string,
): Promise<StravaDetailedActivity> {
  return stravaGet<StravaDetailedActivity>(
    `/activities/${encodeURIComponent(String(id))}?include_all_efforts=false`,
    accessToken,
    "fetchActivityById",
  );
}
