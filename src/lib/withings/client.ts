/**
 * Withings API client: measurement reads and webhook subscriptions. The OAuth
 * handshake is `./oauth.ts`.
 * Docs: https://developer.withings.com/api-reference
 */
import { getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";
import {
  WithingsApiError,
  classifyWithingsResponse,
} from "./response-classifier";
import { importValue } from "@/lib/integrations/import-value";
import { walkPages } from "@/lib/integrations/page-walk";

const WITHINGS_MEASURE_URL = "https://wbsapi.withings.net/measure";
const WITHINGS_NOTIFY_URL = "https://wbsapi.withings.net/notify";

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

/** Every meastype HealthLog maps, in ascending order. */
export const WITHINGS_MEASTYPES: readonly number[] =
  Object.keys(MEASURE_TYPE_MAP).map(Number);

/** Ceiling on the pages one Withings list walk reads (`walkPages`). */
export const WITHINGS_MAX_PAGES = 1000;

/**
 * The offset of the next page of a Withings list body, or null when it has
 * no more. A body that says `more` without an offset past the current one
 * hands back the current offset, which `walkPages` reports as a repeat
 * instead of stopping quietly.
 */
export function withingsNextOffset(
  body: { more?: unknown; offset?: unknown },
  offset: number,
): number | null {
  if (body.more !== true && body.more !== 1) return null;
  const next = Number(body.offset);
  return Number.isFinite(next) && next > offset ? next : offset;
}

/**
 * Fetch measurements from Withings API.
 *
 * `measTypes` narrows the request to a subset of `MEASURE_TYPE_MAP` (the sync
 * leaves out what the account's API plan refuses); omitted, every mapped type
 * is asked for.
 */
export async function fetchMeasurements(
  accessToken: string,
  startDate?: Date,
  endDate?: Date,
  opts: { measTypes?: readonly number[] } = {},
): Promise<WithingsMeasure[]> {
  const baseParams: Record<string, string> = {
    action: "getmeas",
    meastypes: (opts.measTypes ?? WITHINGS_MEASTYPES).join(","),
  };
  if (startDate) {
    baseParams.startdate = String(Math.floor(startDate.getTime() / 1000));
  }
  if (endDate) {
    baseParams.enddate = String(Math.floor(endDate.getTime() / 1000));
  }

  const walk = await walkPages<number, WithingsMeasure>(
    "withings.measure",
    WITHINGS_MAX_PAGES,
    async (cursor, page) => {
      const offset = cursor ?? 0;
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
        method: `fetchMeasurements(page=${page})`,
        duration_ms: Math.round(performance.now() - pageStart),
        status: res.status,
        error:
          verdict.classification === "success" ? undefined : verdict.reason,
      });
      if (verdict.classification !== "success") {
        throw new WithingsApiError({
          verb: "measure",
          classification: verdict.classification,
          withingsStatus: verdict.withingsStatus,
          reason: verdict.reason,
          upstreamError:
            typeof json?.error === "string" ? json.error : undefined,
        });
      }

      const body = json.body ?? {};
      const groups: WithingsMeasureGroup[] = body.measuregrps ?? [];
      const items: WithingsMeasure[] = [];
      for (const group of groups) {
        const measuredAt = new Date(group.date * 1000);
        for (const m of group.measures) {
          const mapping = MEASURE_TYPE_MAP[m.type];
          if (!mapping) continue;
          // Withings stores value * 10^unit (unit is usually negative)
          const value = m.value * Math.pow(10, m.unit);
          items.push({
            type: mapping.type,
            value: importValue(value),
            measuredAt,
          });
        }
      }
      return { items, next: withingsNextOffset(body, offset) };
    },
    0,
  );
  return walk.items;
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
    getEvent()?.addWarning(`Withings unsubscribe warning: ${verdict.reason}`);
  }
}
