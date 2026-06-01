/**
 * Withings API client for OAuth and data fetching.
 * Docs: https://developer.withings.com/api-reference
 */
import { getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";
import {
  WithingsApiError,
  classifyWithingsResponse,
} from "./response-classifier";

const WITHINGS_OAUTH_URL =
  "https://account.withings.com/oauth2_user/authorize2";
const WITHINGS_TOKEN_URL = "https://wbsapi.withings.net/v2/oauth2";
const WITHINGS_MEASURE_URL = "https://wbsapi.withings.net/measure";
const WITHINGS_NOTIFY_URL = "https://wbsapi.withings.net/notify";

export interface WithingsCredentials {
  clientId: string;
  clientSecret: string;
}

function getRedirectUri(): string {
  return (
    process.env.WITHINGS_REDIRECT_URI ??
    `${process.env.NEXT_PUBLIC_APP_URL}/api/withings/callback`
  );
}

/**
 * v1.4.25 W5d — Withings OAuth scope set HealthLog requests.
 *
 *   - `user.metrics`  : every meastype the Measure / Heart-list /
 *                       Sleep endpoints expose (weight, BP, pulse,
 *                       SpO2, body comp, temperature, VO2 max, …)
 *   - `user.activity` : steps / active energy / distance / floors —
 *                       served by `POST /v2/measure?action=getactivity`.
 *                       The sync routine itself lands in v1.4.26; the
 *                       scope is requested now so existing users
 *                       reconnect once instead of twice.
 *
 * v1.4.24-and-earlier connections requested `user.metrics` only — the
 * Settings → Integrations card surfaces a reconnect banner for those
 * users (see `WithingsConnection.scope IS NULL` or scope without
 * `user.activity`).
 */
export const WITHINGS_OAUTH_SCOPE = "user.metrics,user.activity" as const;

/**
 * Parse the persisted scope string into a Set for membership checks.
 * Legacy NULL → empty set (treated as "no scopes yet") so the
 * reconnect-banner conditional reads as truthy.
 */
export function parseWithingsScope(scope: string | null): Set<string> {
  if (!scope) return new Set();
  return new Set(
    scope
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Returns true when the connection holds `user.activity` — the
 * minimum scope required by the Activity / Sleep endpoints.
 */
export function hasActivityScope(scope: string | null): boolean {
  return parseWithingsScope(scope).has("user.activity");
}

/**
 * Generate Withings OAuth authorization URL.
 */
export function getAuthorizationUrl(
  state: string,
  creds: WithingsCredentials,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: creds.clientId,
    redirect_uri: getRedirectUri(),
    scope: WITHINGS_OAUTH_SCOPE,
    state,
  });
  return `${WITHINGS_OAUTH_URL}?${params}`;
}

export interface WithingsTokenResponse {
  userid: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/**
 * Exchange authorization code for tokens.
 */
export async function exchangeCode(
  code: string,
  creds: WithingsCredentials,
): Promise<WithingsTokenResponse> {
  const params = new URLSearchParams({
    action: "requesttoken",
    grant_type: "authorization_code",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: getRedirectUri(),
    code,
  });

  const start = performance.now();
  const res = await safeFetch(WITHINGS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const json = await res.json();
  const verdict = classifyWithingsResponse(res.status, json);
  getEvent()?.addExternalCall({
    service: "withings",
    method: "exchangeCode",
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new WithingsApiError({
      verb: "token",
      classification: verdict.classification,
      withingsStatus: verdict.withingsStatus,
      reason: verdict.reason,
      upstreamError: typeof json?.error === "string" ? json.error : undefined,
    });
  }
  return json.body as WithingsTokenResponse;
}

/**
 * Refresh an expired access token.
 */
export async function refreshAccessToken(
  refreshToken: string,
  creds: WithingsCredentials,
): Promise<WithingsTokenResponse> {
  const params = new URLSearchParams({
    action: "requesttoken",
    grant_type: "refresh_token",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: refreshToken,
  });

  const start = performance.now();
  const res = await safeFetch(WITHINGS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const json = await res.json();
  const verdict = classifyWithingsResponse(res.status, json);
  getEvent()?.addExternalCall({
    service: "withings",
    method: "refreshAccessToken",
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new WithingsApiError({
      verb: "refresh",
      classification: verdict.classification,
      withingsStatus: verdict.withingsStatus,
      reason: verdict.reason,
      upstreamError: typeof json?.error === "string" ? json.error : undefined,
    });
  }
  return json.body as WithingsTokenResponse;
}

// Withings measure type mapping. The single source of truth is
// `src/lib/withings/mapping.md` — keep both in sync when adding entries.
// https://developer.withings.com/api-reference#tag/measure/operation/measure-getmeas
export const MEASURE_TYPE_MAP: Record<
  number,
  { type: string; factor?: number }
> = {
  1: { type: "WEIGHT" }, // Weight (kg)
  9: { type: "BLOOD_PRESSURE_DIA" }, // Diastolic BP
  10: { type: "BLOOD_PRESSURE_SYS" }, // Systolic BP
  11: { type: "PULSE" }, // Heart rate
  6: { type: "BODY_FAT" }, // Body fat %
  // v1.4.25 — first-gen Thermo (WBT01) reports temperature as meastype 12;
  // current-gen Thermo ships meastype 71. Both canonical °C, both into
  // the BODY_TEMPERATURE bucket. Skin temperature (73, ScanWatch) stays
  // out until v1.4.26 ships a SKIN_TEMPERATURE enum — surface temps
  // (~32 °C) and core temps (~37 °C) must not share a rollup.
  12: { type: "BODY_TEMPERATURE" },
  71: { type: "BODY_TEMPERATURE" },
  77: { type: "TOTAL_BODY_WATER" }, // Hydration / water mass (kg)
  88: { type: "BONE_MASS" }, // Bone mass (kg)
  54: { type: "OXYGEN_SATURATION" }, // SpO2 (% — only ScanWatch / pulse-ox products)
  // v1.4.25 — older Withings firmware (and some SDK examples) report
  // SpO2 under meastype 35 instead of 54. Both target OXYGEN_SATURATION
  // in percent; the exponent decode handles 0.97 vs 97 transparently.
  35: { type: "OXYGEN_SATURATION" },
  // v1.4.25 — VO2 max from the ScanWatch family. Withings reports
  // mL/(kg·min) directly, matching the canonical DB unit.
  123: { type: "VO2_MAX" },
  // ── v1.4.25 W5d — Withings full coverage ──
  // Body composition expansion (Body+, Body Cardio, Body Comp, Body
  // Scan ship these values on every measurement). All canonical kg.
  5: { type: "FAT_FREE_MASS" }, // Fat-free mass
  8: { type: "FAT_MASS" }, // Fat mass (kg form of BODY_FAT)
  76: { type: "MUSCLE_MASS" }, // Muscle mass
  // Skin temperature (ScanWatch dermal sensor). Distinct from
  // BODY_TEMPERATURE — surface temps ~32 °C, core ~37 °C. Same °C
  // unit; the SKIN_TEMPERATURE enum value keeps the rollup honest.
  73: { type: "SKIN_TEMPERATURE" },
  // Pulse-wave velocity m/s — Body Cardio / Body Scan exclusive.
  91: { type: "PULSE_WAVE_VELOCITY" },
  // Vascular age in years — Body Scan composite of PWV + age.
  155: { type: "VASCULAR_AGE" },
  // Visceral fat rating (Withings 1–12 scale). Stored under the
  // canonical VISCERAL_FAT enum with `rating` as the unit string.
  170: { type: "VISCERAL_FAT" },
};

export interface WithingsMeasure {
  type: string;
  value: number;
  measuredAt: Date;
}

export interface WithingsMeasureGroup {
  grpid: number;
  date: number; // unix timestamp
  measures: Array<{ type: number; value: number; unit: number }>;
}

/**
 * Fetch measurements from Withings API.
 */
export async function fetchMeasurements(
  accessToken: string,
  startDate?: Date,
  endDate?: Date,
): Promise<WithingsMeasure[]> {
  const baseParams: Record<string, string> = {
    action: "getmeas",
    meastypes: Object.keys(MEASURE_TYPE_MAP).join(","),
  };
  if (startDate) {
    baseParams.startdate = String(Math.floor(startDate.getTime() / 1000));
  }
  if (endDate) {
    baseParams.enddate = String(Math.floor(endDate.getTime() / 1000));
  }

  const results: WithingsMeasure[] = [];
  let offset = 0;
  let pageCount = 0;

  while (true) {
    const params = new URLSearchParams({
      ...baseParams,
      offset: String(offset),
    });

    const pageStart = performance.now();
    const res = await safeFetch(WITHINGS_MEASURE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${accessToken}`,
      },
      body: params.toString(),
    });

    const json = await res.json();
    const verdict = classifyWithingsResponse(res.status, json);
    getEvent()?.addExternalCall({
      service: "withings",
      method: `fetchMeasurements(page=${pageCount})`,
      duration_ms: Math.round(performance.now() - pageStart),
      status: res.status,
      error: verdict.classification === "success" ? undefined : verdict.reason,
    });
    if (verdict.classification !== "success") {
      throw new WithingsApiError({
        verb: "measure",
        classification: verdict.classification,
        withingsStatus: verdict.withingsStatus,
        reason: verdict.reason,
        upstreamError: typeof json?.error === "string" ? json.error : undefined,
      });
    }

    const body = json.body ?? {};
    const groups: WithingsMeasureGroup[] = body.measuregrps ?? [];

    for (const group of groups) {
      const measuredAt = new Date(group.date * 1000);

      for (const m of group.measures) {
        const mapping = MEASURE_TYPE_MAP[m.type];
        if (!mapping) continue;

        // Withings stores value * 10^unit (unit is usually negative)
        const value = m.value * Math.pow(10, m.unit);

        results.push({
          type: mapping.type,
          value: parseFloat(value.toFixed(2)),
          measuredAt,
        });
      }
    }

    const hasMore = body.more === true || body.more === 1;
    if (!hasMore) break;

    const nextOffset = Number(body.offset);
    if (!Number.isFinite(nextOffset) || nextOffset <= offset) break;
    offset = nextOffset;
    pageCount += 1;
    if (pageCount > 1000) break;
  }

  return results;
}

/**
 * Subscribe to Withings webhook notifications.
 */
export async function subscribeWebhook(
  accessToken: string,
  callbackUrl: string,
  appli: number = 1, // 1 = user measures
): Promise<void> {
  const params = new URLSearchParams({
    action: "subscribe",
    callbackurl: callbackUrl,
    appli: String(appli),
  });

  const start = performance.now();
  const res = await safeFetch(WITHINGS_NOTIFY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${accessToken}`,
    },
    body: params.toString(),
  });

  const json = await res.json();
  const verdict = classifyWithingsResponse(res.status, json);
  // 294 = already-subscribed is idempotent success at the subscribe
  // call-site (Withings preserves the existing subscription). The
  // classifier surfaces it as `persistent` because any OTHER endpoint
  // receiving 294 is a contract bug; here we explicitly downgrade it.
  const isAlreadySubscribed = json?.status === 294;
  const treatAsSuccess =
    verdict.classification === "success" || isAlreadySubscribed;
  getEvent()?.addExternalCall({
    service: "withings",
    method: "subscribeWebhook",
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: treatAsSuccess ? undefined : verdict.reason,
  });
  if (!treatAsSuccess) {
    throw new WithingsApiError({
      verb: "subscribe",
      classification: verdict.classification,
      withingsStatus: verdict.withingsStatus,
      reason: verdict.reason,
      upstreamError: typeof json?.error === "string" ? json.error : undefined,
    });
  }
}

/**
 * Unsubscribe from Withings webhook notifications.
 */
export async function unsubscribeWebhook(
  accessToken: string,
  callbackUrl: string,
  appli: number = 1,
): Promise<void> {
  const params = new URLSearchParams({
    action: "revoke",
    callbackurl: callbackUrl,
    appli: String(appli),
  });

  const start = performance.now();
  const res = await safeFetch(WITHINGS_NOTIFY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${accessToken}`,
    },
    body: params.toString(),
  });

  const json = await res.json();
  const verdict = classifyWithingsResponse(res.status, json);
  getEvent()?.addExternalCall({
    service: "withings",
    method: "unsubscribeWebhook",
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  // Unsubscribe is best-effort — a stale subscription will eventually
  // be garbage-collected by Withings, so we never throw here. We do
  // bubble the verdict into a warning so the audit-log path still
  // sees the off-response.
  if (verdict.classification !== "success") {
    getEvent()?.addWarning(
      `Withings unsubscribe warning: ${verdict.reason}`,
    );
  }
}
