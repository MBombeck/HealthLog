/**
 * Polar AccessLink v3 transport and endpoints: user registration and
 * collection reads.
 * Docs: https://www.polar.com/accesslink-api/ (re-verify at build).
 * Envelope shapes + windows below verified against the live AccessLink swagger
 * (`accesslink-api/swagger.yaml`) on 2026-07-24; a body that no longer matches
 * emits a `polar.envelope.drift` breadcrumb rather than silently reading empty.
 *
 * Hand-rolled fetch over `safeFetch` (no SDK). The wire shapes are
 * `./wire-types.ts`, the record → row mapping is `./map.ts`, the OAuth
 * handshake is `./oauth.ts`.
 *
 * Polar specifics that differ from WHOOP:
 *   - The token endpoint uses HTTP Basic auth (`base64(client_id:client_secret)`)
 *     rather than client_id/secret in the body.
 *   - Polar access tokens DO NOT expire and there is NO refresh token. The
 *     `User.polarRefreshTokenEncrypted` column stays null; `getValidToken`
 *     never refreshes. A revoked grant surfaces as a 401 on the next data read.
 *   - The token response carries `x_user_id` — Polar's numeric member id. It
 *     remains necessary for user registration and direct user-information
 *     lookups, while collection reads identify the user from the access token.
 *   - The client must register the user once (`POST /v3/users`) before data
 *     reads work; a 409 from registration means "already registered" and is
 *     treated as success.
 */
import { annotate, getEvent } from "@/lib/logging/context";

import { safeFetch } from "@/lib/safe-fetch";

import { PolarApiError, classifyPolarResponse } from "./response-classifier";

import type {
  PolarNightlyRecharge,
  PolarSleep,
  PolarActivity,
  PolarCardioLoad,
  PolarSpo2,
  PolarExercise,
} from "./wire-types";
import { EXERCISE_LIST_KEYS, normaliseExerciseList } from "./map";

const POLAR_API_BASE = "https://www.polaraccesslink.com";

/**
 * Register the user with the Polar app (`POST /v3/users`). Required once before
 * any data read works. A 409 means the member is already registered for this
 * app — treated as success. Other non-2xx throw a classified error.
 */
export async function registerUser(
  accessToken: string,
  memberId: string,
): Promise<void> {
  const start = performance.now();
  const res = await safeFetch(`${POLAR_API_BASE}/v3/users`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ "member-id": memberId }),
  });
  const verdict = classifyPolarResponse(res.status);
  getEvent()?.addExternalCall({
    service: "polar",
    method: "registerUser",
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error:
      res.status === 409 || verdict.classification === "success"
        ? undefined
        : verdict.reason,
  });
  // 409 Conflict — member already registered for this app. Idempotent success.
  if (res.status === 409) return;
  if (verdict.classification !== "success") {
    throw new PolarApiError({
      verb: "registerUser",
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
    });
  }
}

interface CollectionResult<T> {
  records: T[];
}

/** Top-level key NAMES of a drifted response envelope, capped at 10. NAMES
 *  only, never values — no health data can ride the drift annotation. */
function topLevelKeys(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.keys(body as Record<string, unknown>).slice(0, 10);
}

/** Emit the fixed-shape envelope-drift breadcrumb, then let the caller degrade
 *  to `[]`. Pinned `{verb, httpStatus, keys}` shape so the wide-event dashboard
 *  stays stable; a Polar-side envelope rename shows up here instead of silently
 *  reading as "no data". */
function annotateEnvelopeDrift(
  verb: string,
  httpStatus: number,
  body: unknown,
): void {
  annotate({
    action: {
      name: "polar.envelope.drift",
      details: { verb, httpStatus, keys: topLevelKeys(body) },
    },
  });
}

async function fetchCollection<T>(
  path: string,
  accessToken: string,
  verb: string,
  recordsKey?: string,
): Promise<T[]> {
  const start = performance.now();
  const res = await safeFetch(`${POLAR_API_BASE}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const verdict = classifyPolarResponse(res.status);
  getEvent()?.addExternalCall({
    service: "polar",
    method: verb,
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new PolarApiError({
      verb,
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
    });
  }
  // 204 No Content — a window with no records. Polar returns an empty body.
  if (res.status === 204) return [];
  const json = (await res.json().catch(() => null)) as
    CollectionResult<T> | Record<string, T[]> | T[] | null;
  // A 200 with a null/unparseable body where the contract documents 204 for an
  // empty window: log the drift, then degrade to [] (behavior unchanged).
  if (json === null) {
    annotateEnvelopeDrift(verb, res.status, null);
    return [];
  }
  if (Array.isArray(json)) return json;
  if (!recordsKey) {
    // A bare array is the verified shape for this endpoint (activities /
    // cardio-load / spo2) but the body is a non-array object — an envelope
    // rename would read as "no data". Log, then degrade.
    annotateEnvelopeDrift(verb, res.status, json);
    return [];
  }
  const list = (json as Record<string, unknown>)[recordsKey];
  if (Array.isArray(list)) return list as T[];
  // The expected records key (`recharges` / `nights`) is missing or not an
  // array — the same silent-"no data" drift class. Log, then degrade.
  annotateEnvelopeDrift(verb, res.status, json);
  return [];
}

/** Nightly Recharge collection. Verified envelope: wrapped `{recharges: [...]}`.
 *  Window: the last 28 days, server-fixed (no request params, no pagination). */
export function fetchNightlyRecharges(
  accessToken: string,
): Promise<PolarNightlyRecharge[]> {
  return fetchCollection<PolarNightlyRecharge>(
    "/v3/users/nightly-recharge",
    accessToken,
    "fetchNightlyRecharges",
    "recharges",
  );
}

/** Sleep collection. Verified envelope: wrapped `{nights: [...]}`. Window: the
 *  last 28 days, server-fixed (no request params, no pagination). */
export function fetchSleeps(accessToken: string): Promise<PolarSleep[]> {
  return fetchCollection<PolarSleep>(
    "/v3/users/sleep",
    accessToken,
    "fetchSleeps",
    "nights",
  );
}

/** Daily-activity collection. Verified envelope: a BARE array (no wrapper key).
 *  Window: defaults to the last 28 days; optional `from`/`to` (max 28-day range,
 *  `from` ≤ 365 days back) are deliberately not sent — the default equals the
 *  in-window maximum, so pinning them buys no coverage and adds a request-surface
 *  failure mode. No pagination. */
export function fetchActivities(accessToken: string): Promise<PolarActivity[]> {
  return fetchCollection<PolarActivity>(
    "/v3/users/activities",
    accessToken,
    "fetchActivities",
  );
}

/** Training Load Pro collection — `cardio_load` strain figures. Verified
 *  envelope: a BARE array (no wrapper key). Window: the last 28 days on the bare
 *  list (ranged `/date` and `/period/days/{1..180}` variants exist for deeper
 *  history but are backfill machinery, not sent here). No pagination. */
export function fetchCardioLoads(
  accessToken: string,
): Promise<PolarCardioLoad[]> {
  return fetchCollection<PolarCardioLoad>(
    "/v3/users/cardio-load",
    accessToken,
    "fetchCardioLoads",
  );
}

/** SpO2 (Elixir pulse-ox) collection — nightly blood-oxygen readings. Verified
 *  envelope: a BARE array (no wrapper key). Window: defaults to the last 28 days
 *  (optional `from`/`to`, max 28-day range, not sent). No pagination. */
export function fetchSpo2(accessToken: string): Promise<PolarSpo2[]> {
  return fetchCollection<PolarSpo2>(
    "/v3/users/biosensing/spo2",
    accessToken,
    "fetchSpo2",
  );
}

/**
 * Fetch the user's exercises (`GET /v3/exercises`). Summary only — the
 * `samples` / `zones` / `route` inline params are deliberately omitted (route /
 * per-sample import is out of scope). Returns `[]` on 204 No Content, a bare
 * array, or a paged envelope whose list key is unrecognised. Throws a
 * classified `PolarApiError` on a non-2xx — including a 403, which the workout
 * sync classifies as a soft/recoverable integration error so a scope gap on
 * exercises never hard-fails the whole Polar sync.
 */
export async function fetchExercises(
  accessToken: string,
): Promise<PolarExercise[]> {
  const start = performance.now();
  const res = await safeFetch(`${POLAR_API_BASE}/v3/exercises`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const verdict = classifyPolarResponse(res.status);
  getEvent()?.addExternalCall({
    service: "polar",
    method: "fetchExercises",
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new PolarApiError({
      verb: "fetchExercises",
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
    });
  }
  // 204 No Content — a window with no uploads. Polar returns an empty body.
  if (res.status === 204) return [];
  const json = (await res.json().catch(() => null)) as unknown;
  // Drift: a non-null object body carrying no recognised list array (none of
  // EXERCISE_LIST_KEYS holds an array) would silently read as "no uploads". Log
  // at the fetch site — `normaliseExerciseList` stays a pure function — then
  // degrade to its []. A correctly-shaped `{exercises: []}` finds an (empty)
  // array under a known key and does NOT drift.
  if (
    json !== null &&
    typeof json === "object" &&
    !Array.isArray(json) &&
    !EXERCISE_LIST_KEYS.some((k) =>
      Array.isArray((json as Record<string, unknown>)[k]),
    )
  ) {
    annotateEnvelopeDrift("fetchExercises", res.status, json);
  }
  return normaliseExerciseList(json);
}
