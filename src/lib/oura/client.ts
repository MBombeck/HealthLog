/**
 * Oura Cloud API v2 transport and endpoints: hand-rolled fetch over
 * `safeFetch` (no SDK), collection reads with `next_token` pagination, read
 * by `start_date` / `end_date` (YYYY-MM-DD).
 * Docs: https://cloud.ouraring.com/v2/docs (re-verify at build).
 *
 * The wire shapes are `./wire-types.ts`, the record → measurement mapping is
 * `./map.ts`, the OAuth handshake is `./oauth.ts`.
 */
import { getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";
import { OuraApiError, classifyOuraResponse } from "./response-classifier";

import { walkPages } from "@/lib/integrations/page-walk";
import { retryAfterMsOf } from "@/lib/integrations/oauth-kit/retry-after";
import { parseOuraMissingScope } from "./scope";
import type {
  OuraCollection,
  OuraSleep,
  OuraReadiness,
  OuraDailySleep,
  OuraDailySpo2,
  OuraVo2Max,
  OuraCardiovascularAge,
  OuraResilience,
  OuraCyclePhase,
  OuraDailyActivity,
  OuraWorkout,
  OuraHeartRateSample,
} from "./wire-types";

const OURA_API_BASE = "https://api.ouraring.com";

interface DateRangeQuery {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  maxPages?: number;
}

/** A time-range read (`heartrate`): instants, not calendar dates. */
export interface DateTimeRangeQuery {
  start: Date;
  end: Date;
  maxPages?: number;
}

/**
 * The error for a refused collection read. Oura's status alone does not say
 * what went wrong; its body does (see `./scope`):
 *
 *   - 401 naming a scope: the token is fine, the grant does not cover this
 *     collection. `missingScope` carries the name, and the sync neither
 *     refreshes over it nor counts it toward the reconnect threshold.
 *   - any other 401: the token is dead or expired (refresh, then reconnect).
 *   - 403: a lapsed Oura membership, per the API reference. A reconnect does
 *     not fix that, so it is a persistent failure rather than a reauth.
 *   - 429 (and 503): transient, with the `Retry-After` delay on
 *     `retryAfterMs` so a backfill can wait it out instead of guessing.
 */
function collectionRefusal(
  verb: string,
  res: Pick<Response, "status" | "headers">,
  verdict: ReturnType<typeof classifyOuraResponse>,
  body: unknown,
): OuraApiError {
  const status = res.status;
  if (status === 401) {
    const missingScope = parseOuraMissingScope(body);
    if (missingScope) {
      return new OuraApiError({
        verb,
        classification: "reauth_required",
        httpStatus: status,
        reason: "scope_missing",
        missingScope,
      });
    }
  }
  if (status === 403) {
    return new OuraApiError({
      verb,
      classification: "persistent",
      httpStatus: status,
      reason: "http_403",
    });
  }
  return new OuraApiError({
    verb,
    classification: verdict.classification,
    httpStatus: verdict.httpStatus,
    reason: verdict.reason,
    ...(status === 429 || status === 503
      ? { retryAfterMs: retryAfterMsOf(res) }
      : {}),
  });
}

/**
 * The Oura account id of a grant (`personal_info.id`), or null when the grant
 * does not cover the `personal` scope or Oura does not answer. Read once at
 * connect so one Oura account cannot be attached to two records; a null id
 * skips that check rather than failing the connect.
 */
export async function fetchOuraAccountId(
  accessToken: string,
): Promise<string | null> {
  try {
    const res = await safeFetch(
      `${OURA_API_BASE}/v2/usercollection/personal_info`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
    );
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as {
      id?: unknown;
    } | null;
    return typeof json?.id === "string" && json.id.length > 0 ? json.id : null;
  } catch {
    return null;
  }
}

/** Read one page of a collection; throws the classified refusal. */
async function readCollectionPage<T>(
  path: string,
  accessToken: string,
  verb: string,
  params: URLSearchParams,
  page: number,
): Promise<{ items: T[]; next: string | null }> {
  const pageStart = performance.now();
  const res = await safeFetch(`${OURA_API_BASE}${path}?${params}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const json = (await res.json().catch(() => null)) as OuraCollection<T> | null;
  const verdict = classifyOuraResponse(res.status);
  getEvent()?.addExternalCall({
    service: "oura",
    method: `${verb}(page=${page})`,
    duration_ms: Math.round(performance.now() - pageStart),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw collectionRefusal(verb, res, verdict, json);
  }
  return { items: json?.data ?? [], next: json?.next_token ?? null };
}

async function fetchCollection<T>(
  path: string,
  accessToken: string,
  verb: string,
  query: DateRangeQuery,
): Promise<T[]> {
  const walk = await walkPages<string, T>(
    `oura.${verb}`,
    query.maxPages ?? 100,
    (nextToken, page) => {
      const params = new URLSearchParams({
        start_date: query.startDate,
        end_date: query.endDate,
      });
      if (nextToken) params.set("next_token", nextToken);
      return readCollectionPage<T>(path, accessToken, verb, params, page);
    },
  );
  return walk.items;
}

/** What a streamed walk came to. */
export interface OuraStreamedWalk {
  pages: number;
  /** Stopped at the page ceiling or on a repeated cursor with pages left. */
  truncated: boolean;
}

/**
 * Walk a time-range collection page by page, handing each page to `onPage`
 * before the next is read. Nothing is collected: the walk keeps one page at a
 * time, so a dense stream (heart rate, a sample every few minutes for years)
 * costs the memory of a page, not of the history.
 */
async function streamCollection<T>(
  path: string,
  accessToken: string,
  verb: string,
  query: DateTimeRangeQuery,
  onPage: (items: T[]) => Promise<void>,
): Promise<OuraStreamedWalk> {
  const walk = await walkPages<string, never>(
    `oura.${verb}`,
    query.maxPages ?? 200,
    async (nextToken, page) => {
      const params = new URLSearchParams({
        start_datetime: query.start.toISOString(),
        end_datetime: query.end.toISOString(),
      });
      if (nextToken) params.set("next_token", nextToken);
      const { items, next } = await readCollectionPage<T>(
        path,
        accessToken,
        verb,
        params,
        page,
      );
      await onPage(items);
      return { items: [], next };
    },
  );
  return { pages: walk.pages, truncated: walk.truncated };
}

export function fetchSleep(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraSleep[]> {
  return fetchCollection<OuraSleep>(
    "/v2/usercollection/sleep",
    accessToken,
    "fetchSleep",
    query,
  );
}

export function fetchReadiness(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraReadiness[]> {
  return fetchCollection<OuraReadiness>(
    "/v2/usercollection/daily_readiness",
    accessToken,
    "fetchReadiness",
    query,
  );
}

export function fetchDailyActivity(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraDailyActivity[]> {
  return fetchCollection<OuraDailyActivity>(
    "/v2/usercollection/daily_activity",
    accessToken,
    "fetchDailyActivity",
    query,
  );
}

export function fetchDailySleep(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraDailySleep[]> {
  return fetchCollection<OuraDailySleep>(
    "/v2/usercollection/daily_sleep",
    accessToken,
    "fetchDailySleep",
    query,
  );
}

export function fetchDailySpo2(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraDailySpo2[]> {
  return fetchCollection<OuraDailySpo2>(
    "/v2/usercollection/daily_spo2",
    accessToken,
    "fetchDailySpo2",
    query,
  );
}

// Oura `daily_stress` → STRESS_SCORE is deferred pending STRESS_SCORE
// source-priority + graded-series wiring (an HRV-derived COMPUTED producer
// already exists; a second producer here would double-count). The mapping is
// withdrawn until the ladder is in place.

export function fetchVo2Max(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraVo2Max[]> {
  // Oura camel-cases this path segment (`vO2_max`); every other collection is
  // snake_case. Matched verbatim against cloud.ouraring.com/v2/docs.
  return fetchCollection<OuraVo2Max>(
    "/v2/usercollection/vO2_max",
    accessToken,
    "fetchVo2Max",
    query,
  );
}

export function fetchCardiovascularAge(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraCardiovascularAge[]> {
  return fetchCollection<OuraCardiovascularAge>(
    "/v2/usercollection/daily_cardiovascular_age",
    accessToken,
    "fetchCardiovascularAge",
    query,
  );
}

export function fetchResilience(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraResilience[]> {
  return fetchCollection<OuraResilience>(
    "/v2/usercollection/daily_resilience",
    accessToken,
    "fetchResilience",
    query,
  );
}

/** See the `OuraCyclePhase` docstring for the endpoint's documentation gap. */
export function fetchDailyCyclePhases(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraCyclePhase[]> {
  return fetchCollection<OuraCyclePhase>(
    "/v2/usercollection/daily_cycle_phases",
    accessToken,
    "fetchDailyCyclePhases",
    query,
  );
}

export function fetchWorkouts(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraWorkout[]> {
  return fetchCollection<OuraWorkout>(
    "/v2/usercollection/workout",
    accessToken,
    "fetchWorkouts",
    query,
  );
}

/**
 * Stream the `heartrate` collection for a time range, one page at a time.
 * Oura answers it by instant (`start_datetime` / `end_datetime`) and pages
 * with `next_token`; a page goes to `onPage` and is dropped before the next
 * is read.
 */
export function forEachHeartRatePage(
  accessToken: string,
  query: DateTimeRangeQuery,
  onPage: (samples: OuraHeartRateSample[]) => Promise<void>,
): Promise<OuraStreamedWalk> {
  return streamCollection<OuraHeartRateSample>(
    "/v2/usercollection/heartrate",
    accessToken,
    "fetchHeartRate",
    query,
    onPage,
  );
}
