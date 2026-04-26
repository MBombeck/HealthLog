/**
 * Withings API client for OAuth and data fetching.
 * Docs: https://developer.withings.com/api-reference
 */
import { getEvent } from "@/lib/logging/context";

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
    scope: "user.metrics",
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
  const res = await fetch(WITHINGS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const json = await res.json();
  getEvent()?.addExternalCall({
    service: "withings",
    method: "exchangeCode",
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: json.status !== 0 ? `status=${json.status}` : undefined,
  });
  if (json.status !== 0) {
    throw new Error(`Withings token error: ${json.status} - ${json.error}`);
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
  const res = await fetch(WITHINGS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const json = await res.json();
  getEvent()?.addExternalCall({
    service: "withings",
    method: "refreshAccessToken",
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: json.status !== 0 ? `status=${json.status}` : undefined,
  });
  if (json.status !== 0) {
    throw new Error(`Withings refresh error: ${json.status} - ${json.error}`);
  }
  return json.body as WithingsTokenResponse;
}

// Withings measure type mapping
// https://developer.withings.com/api-reference#tag/measure/operation/measure-getmeas
const MEASURE_TYPE_MAP: Record<number, { type: string; factor?: number }> = {
  1: { type: "WEIGHT" }, // Weight (kg)
  9: { type: "BLOOD_PRESSURE_DIA" }, // Diastolic BP
  10: { type: "BLOOD_PRESSURE_SYS" }, // Systolic BP
  11: { type: "PULSE" }, // Heart rate
  6: { type: "BODY_FAT" }, // Body fat %
  77: { type: "TOTAL_BODY_WATER" }, // Hydration / water mass (kg)
  88: { type: "BONE_MASS" }, // Bone mass (kg)
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
    const res = await fetch(WITHINGS_MEASURE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${accessToken}`,
      },
      body: params.toString(),
    });

    const json = await res.json();
    getEvent()?.addExternalCall({
      service: "withings",
      method: `fetchMeasurements(page=${pageCount})`,
      duration_ms: Math.round(performance.now() - pageStart),
      status: res.status,
      error: json.status !== 0 ? `status=${json.status}` : undefined,
    });
    if (json.status !== 0) {
      throw new Error(`Withings measure error: ${json.status}`);
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
  const res = await fetch(WITHINGS_NOTIFY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${accessToken}`,
    },
    body: params.toString(),
  });

  const json = await res.json();
  getEvent()?.addExternalCall({
    service: "withings",
    method: "subscribeWebhook",
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error:
      json.status !== 0 && json.status !== 294
        ? `status=${json.status}`
        : undefined,
  });
  // Status 0 = success, 294 = already subscribed (both OK)
  if (json.status !== 0 && json.status !== 294) {
    throw new Error(`Withings subscribe error: ${json.status}`);
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
  const res = await fetch(WITHINGS_NOTIFY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${accessToken}`,
    },
    body: params.toString(),
  });

  const json = await res.json();
  getEvent()?.addExternalCall({
    service: "withings",
    method: "unsubscribeWebhook",
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: json.status !== 0 ? `status=${json.status}` : undefined,
  });
  if (json.status !== 0) {
    getEvent()?.addWarning(`Withings unsubscribe warning: ${json.status}`);
  }
}
