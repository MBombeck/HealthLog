/**
 * WHOOP API v2 transport and endpoints: hand-rolled fetch over `safeFetch`
 * (no SDK), collection reads with `next_token` pagination and single-record
 * reads. Docs: https://developer.whoop.com (re-verify at build; the space
 * moves).
 *
 * v2 only (v1 was removed 2025-10-01). Sleep, workout and recovery ids are
 * UUID strings; cycle ids are int64. The wire shapes are `./wire-types.ts`,
 * the record → measurement mapping is `./map.ts`, the OAuth handshake is
 * `./oauth.ts`.
 */
import { getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";

import { WhoopApiError, classifyWhoopResponse } from "./response-classifier";

import { walkPages } from "@/lib/integrations/page-walk";
import type {
  WhoopCollection,
  WhoopRecovery,
  WhoopSleep,
  WhoopCycle,
  WhoopWorkout,
  WhoopBodyMeasurement,
  WhoopProfile,
} from "./wire-types";

const WHOOP_API_BASE = "https://api.prod.whoop.com/developer";

/** WHOOP collection reads cap `limit` at 25. */
export const WHOOP_PAGE_LIMIT = 25;

interface CollectionQuery {
  start?: Date;
  end?: Date;
  /**
   * Ceiling on pages walked (defence against a runaway cursor). A walk that
   * reaches it is reported truncated (`walkPages`).
   */
  maxPages?: number;
}

async function fetchCollection<T>(
  path: string,
  accessToken: string,
  verb: string,
  query: CollectionQuery = {},
): Promise<T[]> {
  const walk = await walkPages<string, T>(
    `whoop.${verb}`,
    query.maxPages ?? 1000,
    async (nextToken, page) => {
      const params = new URLSearchParams({ limit: String(WHOOP_PAGE_LIMIT) });
      if (query.start) params.set("start", query.start.toISOString());
      if (query.end) params.set("end", query.end.toISOString());
      if (nextToken) params.set("nextToken", nextToken);

      const pageStart = performance.now();
      const res = await safeFetch(`${WHOOP_API_BASE}${path}?${params}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const json = (await res
        .json()
        .catch(() => null)) as WhoopCollection<T> | null;
      const verdict = classifyWhoopResponse(res.status);
      getEvent()?.addExternalCall({
        service: "whoop",
        method: `${verb}(page=${page})`,
        duration_ms: Math.round(performance.now() - pageStart),
        status: res.status,
        error:
          verdict.classification === "success" ? undefined : verdict.reason,
      });
      if (verdict.classification !== "success") {
        throw new WhoopApiError({
          verb,
          classification: verdict.classification,
          httpStatus: verdict.httpStatus,
          reason: verdict.reason,
        });
      }
      return { items: json?.records ?? [], next: json?.next_token ?? null };
    },
  );
  return walk.items;
}

async function fetchSingle<T>(
  path: string,
  accessToken: string,
  verb: string,
): Promise<T> {
  const start = performance.now();
  const res = await safeFetch(`${WHOOP_API_BASE}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json().catch(() => null)) as T | null;
  const verdict = classifyWhoopResponse(res.status);
  getEvent()?.addExternalCall({
    service: "whoop",
    method: verb,
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new WhoopApiError({
      verb,
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
    });
  }
  return json as T;
}

export function fetchRecoveries(
  accessToken: string,
  query?: CollectionQuery,
): Promise<WhoopRecovery[]> {
  return fetchCollection<WhoopRecovery>(
    "/v2/recovery",
    accessToken,
    "fetchRecoveries",
    query,
  );
}

export function fetchSleeps(
  accessToken: string,
  query?: CollectionQuery,
): Promise<WhoopSleep[]> {
  return fetchCollection<WhoopSleep>(
    "/v2/activity/sleep",
    accessToken,
    "fetchSleeps",
    query,
  );
}

export function fetchCycles(
  accessToken: string,
  query?: CollectionQuery,
): Promise<WhoopCycle[]> {
  return fetchCollection<WhoopCycle>(
    "/v2/cycle",
    accessToken,
    "fetchCycles",
    query,
  );
}

export function fetchWorkouts(
  accessToken: string,
  query?: CollectionQuery,
): Promise<WhoopWorkout[]> {
  return fetchCollection<WhoopWorkout>(
    "/v2/activity/workout",
    accessToken,
    "fetchWorkouts",
    query,
  );
}

// ─── Single-record reads (webhook-driven fetch-by-id) ──────────
// A `*.updated` webhook carries only the resource id, not the data. Re-fetch
// that ONE record by id for a targeted refresh — far cheaper than re-walking
// the whole collection, and it lands the record immediately rather than on the
// next overlap window. WHOOP v2 single-record paths (re-verify at build):
//   sleep    GET /v2/activity/sleep/{sleepId}
//   workout  GET /v2/activity/workout/{workoutId}
//   cycle    GET /v2/cycle/{cycleId}
//   recovery GET /v2/cycle/{cycleId}/recovery   (no recovery-by-recovery-id)
// `fetchSingle` throws a `WhoopApiError` on a non-2xx (incl. a 404 for a since-
// deleted id) so the caller's existing classify/soft-skip path handles it.

export function fetchSleepById(
  accessToken: string,
  sleepId: string,
): Promise<WhoopSleep> {
  return fetchSingle<WhoopSleep>(
    `/v2/activity/sleep/${encodeURIComponent(sleepId)}`,
    accessToken,
    "fetchSleepById",
  );
}

export function fetchWorkoutById(
  accessToken: string,
  workoutId: string,
): Promise<WhoopWorkout> {
  return fetchSingle<WhoopWorkout>(
    `/v2/activity/workout/${encodeURIComponent(workoutId)}`,
    accessToken,
    "fetchWorkoutById",
  );
}

export function fetchCycleById(
  accessToken: string,
  cycleId: string,
): Promise<WhoopCycle> {
  return fetchSingle<WhoopCycle>(
    `/v2/cycle/${encodeURIComponent(cycleId)}`,
    accessToken,
    "fetchCycleById",
  );
}

/**
 * WHOOP v2 has no recovery-by-recovery-id route — a recovery is read through
 * its cycle (`GET /v2/cycle/{cycleId}/recovery`). The v2 recovery webhook
 * carries the id of the associated SLEEP, not the cycle, so the targeted
 * refresh first reads the sleep for its `cycle_id` (see
 * `syncWhoopRecoveryById`).
 */
export function fetchRecoveryByCycleId(
  accessToken: string,
  cycleId: string,
): Promise<WhoopRecovery> {
  return fetchSingle<WhoopRecovery>(
    `/v2/cycle/${encodeURIComponent(cycleId)}/recovery`,
    accessToken,
    "fetchRecoveryByCycleId",
  );
}

export function fetchBodyMeasurement(
  accessToken: string,
): Promise<WhoopBodyMeasurement> {
  return fetchSingle<WhoopBodyMeasurement>(
    "/v2/user/measurement/body",
    accessToken,
    "fetchBodyMeasurement",
  );
}

export function fetchProfile(accessToken: string): Promise<WhoopProfile> {
  return fetchSingle<WhoopProfile>(
    "/v2/user/profile/basic",
    accessToken,
    "fetchProfile",
  );
}
