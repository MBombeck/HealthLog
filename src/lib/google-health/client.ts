/**
 * Google Health API endpoints: the profile read that gives a connection its
 * external user id, and the daily roll-up reads.
 * Docs: https://developers.google.com/health (health.googleapis.com/v4, the
 * successor to the Fitbit Web API, unifying Fitbit, Pixel Watch and Fitbit
 * Air).
 *
 * The integration is split by concern: the OAuth handshake is `./oauth.ts`,
 * the request layer (error detail, retry, rate limits) `./request.ts`, the
 * paginated `dataPoints.list` walker `./data-points.ts`, the backfill slice
 * budget and the per-cycle outcome tally `./budget.ts`, and the pure payload
 * mapping `./mappers.ts`.
 */
import { annotate, getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import {
  GoogleHealthApiError,
  classifyGoogleHealthResponse,
} from "./response-classifier";
import {
  type GoogleHealthDataType,
  type GoogleHealthRollupPoint,
} from "./mappers";

import { walkPages } from "@/lib/integrations/page-walk";

import { notePagination, stopRequested, noteSlicePage } from "./budget";
import {
  extractGoogleApiErrorDetail,
  GoogleHealthAccessToken,
  googleHealthDataRequest,
} from "./request";
import { GOOGLE_HEALTH_API_BASE } from "./request";

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

/**
 * Page ceiling for one dailyRollUp chunk. A chunk of at most 90 daily windows
 * fits on one page of the documented default size, so a chunk that pages at
 * all is unusual and one that reaches this is a runaway token.
 */
const GOOGLE_HEALTH_ROLLUP_MAX_PAGES = 100;

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
  accessToken: GoogleHealthAccessToken,
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
      if (stopRequested(false)) {
        truncated = true;
        break;
      }
      const index = chunkIndex;
      const chunkWalk = await walkPages<string, GoogleHealthRollupPoint>(
        `google_health.rollup.${dataType.path}`,
        GOOGLE_HEALTH_ROLLUP_MAX_PAGES,
        async (pageToken, pageCount) => {
          const body = buildDailyRollUpBody(chunk, pageToken);

          requestCount += 1;
          const { json, verdict, apiErrorDetail } =
            await googleHealthDataRequest<GoogleHealthRollupPage>(
              accessToken,
              `${verb}(chunk=${index},page=${pageCount})`,
              (token) =>
                safeFetch(
                  `${GOOGLE_HEALTH_API_BASE}/users/me/dataTypes/${dataType.path}/dataPoints:dailyRollUp`,
                  {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${token}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify(body),
                  },
                ),
            );
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
            index === 0 &&
            pageCount === 0 &&
            json &&
            typeof json === "object"
          ) {
            query.onEnvelopeKeys?.(Object.keys(json));
          }
          noteSlicePage();
          return {
            items: json?.rollupDataPoints ?? [],
            next: json?.nextPageToken || null,
          };
        },
      );
      for (const p of chunkWalk.items) points.push(p);
      totalPages += chunkWalk.pages;
      truncated ||= chunkWalk.truncated;
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
