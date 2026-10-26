"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useAiCapability, useAiProviderState } from "@/hooks/use-ai-capability";
import { useAuth } from "@/hooks/use-auth";
import { pollAttemptCount } from "@/lib/queries/refetch-interval";
import { useTranslations } from "@/lib/i18n/context";
import type { MetricStatusMetricId } from "@/lib/insights/metric-status-registry";
import type { AssessmentStatus } from "@/lib/insights/status-shared";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { STATUS_MODEL_CALLS } from "@/lib/ai/ai-budgets";
import { clientAbortMs } from "@/lib/ai/effective-timeout";

/**
 * Shape returned by every `/api/insights/<metric>-status` endpoint.
 *
 * - `hasProvider` — whether the user has configured an AI provider; the
 *   sub-page hides the status card entirely when false.
 * - `text` — the rendered status string; null when the provider has
 *   not yet produced one.
 * - `cached` — whether the payload came from the per-locale cache or a
 *   fresh provider round-trip.
 * - `updatedAt` — ISO timestamp of the cached payload's creation, or
 *   null when the route has never produced a value.
 */
export interface InsightStatusData {
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
  /**
   * v1.8.3 — the route is read-only: a cache miss enqueues an out-of-band
   * generation and returns `preparing: true` with `text: null`. The card
   * shows a preparing state and the hook polls (bounded) until the worker
   * warms the cache. Absent / false means the payload is terminal.
   */
  preparing?: boolean;
  /**
   * v1.9.0 — true when the route serves last-good (stale) text AND a fresh
   * generation is in flight. The served payload would otherwise be terminal
   * (`preparing` false), so the open card would stop polling and never pick
   * up the warmed assessment until a remount. The hook keeps polling on
   * `preparing || revalidating` (bounded by the same attempt ceiling) so the
   * card upgrades to the fresh text in the same session.
   */
  revalidating?: boolean;
  /** Explicit terminal/pending state consumed by every assessment wrapper. */
  assessment?: AssessmentStatus;
  /** True only after this query identity reaches the bounded poll ceiling. */
  pollExhausted?: boolean;
}

/**
 * v1.8.3 — client-side ceiling on the status GET. The route is now
 * read-only (sub-second cache read), so a slow response means the network
 * itself is degraded, not the LLM. Mirror the advisor hook's 8 s
 * `ADVISOR_TIMEOUT_MS`: abort and surface the empty / preparing state
 * rather than letting a hung request pin the navigation. No user
 * navigation may ever await an uncapped round-trip.
 */
const STATUS_TIMEOUT_MS = 8_000;

/**
 * Poll interval while a card is `preparing`. Bounded by `staleTime` so a
 * settled (terminal) payload never re-fetches on a timer; only the
 * preparing state keeps polling, and it stops as soon as text lands.
 */
const STATUS_POLL_MS = 4_000;

/**
 * v1.8.4 — the fast part of the preparing poll: ~12 attempts (≈ 48 s at the
 * 4 s cadence), the window a healthy generation lands in. It is also the
 * ceiling for a caller that does not know the response timeout.
 * `dataUpdateCount` counts every settled fetch — initial load plus each poll
 * round — so once it crosses the ceiling we stop scheduling the next one.
 */
export const STATUS_POLL_MAX_ATTEMPTS = 12;

/**
 * The cadence once the fast part has passed: a slow model is still within
 * its time, and a read every 15 s picks its note up without hammering the
 * route for twenty minutes.
 */
export const STATUS_SLOW_POLL_MS = 15_000;

/**
 * #1274 — the attempt ceiling for a status card while its generation runs.
 *
 * The note is written by a background job whose run may wait the person's
 * response timeout on each of `STATUS_MODEL_CALLS` calls (the call, and the
 * one repeat a thinking model gets when it answered with reasoning alone).
 * A fixed 12 attempts stopped watching after 48 s, so a slow local model
 * delivered its note to a page that had stopped looking, and the card kept
 * its fallback until a reload. The window is that run read off the
 * published setting (`clientAbortMs`), covered by the fast polls and then
 * the slow ones, plus the first read and one interval for the queue to pick
 * the job up. It never falls below the fast ceiling, and it only matters
 * while the server reports the generation in flight: a terminal payload
 * stops the poll whatever the ceiling.
 */
export function statusPollMaxAttempts(
  responseTimeoutMs: number | null | undefined,
): number {
  const runMs = clientAbortMs(responseTimeoutMs, STATUS_MODEL_CALLS);
  const fastMs = STATUS_POLL_MAX_ATTEMPTS * STATUS_POLL_MS;
  const slow = Math.max(0, Math.ceil((runMs - fastMs) / STATUS_SLOW_POLL_MS));
  return STATUS_POLL_MAX_ATTEMPTS + slow + 2;
}

/**
 * Decide whether a card should schedule its next poll. Pure and shared
 * between the `useInsightStatus` hooks and the inline medication-compliance
 * query so every site enforces the same schedule. Returns the interval in ms
 * while polling is warranted, or `false` once the payload is terminal OR the
 * attempt ceiling (`statusPollMaxAttempts`) is reached.
 *
 * v1.9.0 — `revalidating` joins `preparing` as a "keep polling" signal: when
 * the route serves last-good (stale) text it would otherwise be terminal and
 * stop the poll, so the freshly-warmed assessment never reaches the open card
 * until a remount. The attempt ceiling bounds both signals identically, so a
 * persistently failing generation still cannot poll an open page forever.
 */
export function nextStatusPollInterval(
  preparing: boolean | undefined,
  dataUpdateCount: number,
  revalidating?: boolean | undefined,
  maxAttempts: number = STATUS_POLL_MAX_ATTEMPTS,
): number | false {
  if (!preparing && !revalidating) return false;
  if (dataUpdateCount >= maxAttempts) return false;
  return dataUpdateCount < STATUS_POLL_MAX_ATTEMPTS
    ? STATUS_POLL_MS
    : STATUS_SLOW_POLL_MS;
}

/**
 * Normalize the legacy route DTO into the shared discriminated contract.
 * Existing routes can roll forward independently because the old scalar
 * fields remain intact; consumers branch on `assessment.kind`.
 */
export function assessmentStatusFromData(
  data: Pick<
    InsightStatusData,
    "hasProvider" | "text" | "updatedAt" | "preparing" | "revalidating"
  >,
): AssessmentStatus {
  if (data.text) {
    if (data.revalidating) {
      return {
        kind: "revalidating",
        text: data.text,
        hasProvider: true,
        updatedAt: data.updatedAt,
        retryable: true,
      };
    }
    if (!data.hasProvider) {
      // Legacy endpoints encode deterministic timeout/screening fallbacks as
      // `hasProvider:false` plus safe text. Text outranks provider metadata:
      // never hide it behind the provider-setup CTA.
      return {
        kind: "screened-fallback",
        text: data.text,
        hasProvider: false,
        updatedAt: null,
        retryable: true,
        reason: "unparseable_output",
      };
    }
    return {
      kind: "generated",
      text: data.text,
      hasProvider: true,
      updatedAt: data.updatedAt,
      retryable: false,
    };
  }
  if (data.preparing || data.revalidating) {
    return {
      kind: "preparing",
      text: null,
      hasProvider: true,
      updatedAt: null,
      retryable: true,
    };
  }
  if (!data.hasProvider) {
    return {
      kind: "no-provider",
      text: null,
      hasProvider: false,
      updatedAt: null,
      retryable: false,
    };
  }
  return {
    kind: "error",
    text: null,
    hasProvider: true,
    updatedAt: null,
    retryable: true,
  };
}

function normalizeStatusData(data: InsightStatusData): InsightStatusData {
  return {
    ...data,
    assessment: data.assessment ?? assessmentStatusFromData(data),
  };
}

function failureStatusData(kind: "timeout" | "error"): InsightStatusData {
  return {
    hasProvider: true,
    text: null,
    cached: false,
    updatedAt: null,
    preparing: false,
    revalidating: false,
    assessment: {
      kind,
      text: null,
      hasProvider: true,
      updatedAt: null,
      retryable: true,
    },
  };
}

async function fetchStatusData(
  url: string,
  querySignal: AbortSignal,
): Promise<InsightStatusData> {
  const controller = new AbortController();
  const abortOnUnmount = () => controller.abort();
  querySignal.addEventListener("abort", abortOnUnmount, { once: true });
  const timeoutHandle = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    const data = await apiGet<InsightStatusData>(url, {
      signal: controller.signal,
    });
    return normalizeStatusData(data);
  } catch {
    const timedOut =
      controller.signal.aborted && !querySignal.aborted ? "timeout" : "error";
    return failureStatusData(timedOut);
  } finally {
    clearTimeout(timeoutHandle);
    querySignal.removeEventListener("abort", abortOnUnmount);
  }
}

function useStatusPollAttemptCount(queryKey: readonly unknown[]): number {
  const queryClient = useQueryClient();
  const state = queryClient.getQueryState<InsightStatusData>(queryKey);
  return state ? pollAttemptCount(state) : 0;
}

/**
 * Replace a capped pending payload with an honest terminal state. Keeping the
 * legacy flags false ensures older consumers also stop painting preparation.
 */
export function applyStatusPollExhaustion(
  data: InsightStatusData | undefined,
  dataUpdateCount: number,
  maxAttempts: number = STATUS_POLL_MAX_ATTEMPTS,
): InsightStatusData | undefined {
  if (!data) return data;
  const status = data.assessment ?? assessmentStatusFromData(data);
  const pending = status.kind === "preparing" || status.kind === "revalidating";
  const pollExhausted = pending && dataUpdateCount >= maxAttempts;
  if (!pollExhausted) return normalizeStatusData(data);
  return {
    ...data,
    text: status.kind === "revalidating" ? status.text : null,
    preparing: false,
    revalidating: false,
    pollExhausted: true,
    assessment: {
      kind: "exhausted",
      text: null,
      hasProvider: true,
      updatedAt: null,
      retryable: false,
    },
  };
}

/**
 * Metric slugs the sub-pages render. Each slug is paired with the
 * Insights-status endpoint and the matching `queryKeys.*` factory so
 * the cache keys stay aligned across the whole app — a hard-coded
 * `["insights", "weight-status", locale]` array typoed once is exactly
 * the class of bug `queryKeys` was introduced to defend against.
 */
export type InsightStatusMetric =
  | "blood-pressure"
  | "weight"
  | "pulse"
  | "bmi"
  | "mood"
  | "medication-compliance";

const QUERY_KEY_FACTORY: Record<
  InsightStatusMetric,
  (locale: string) => readonly unknown[]
> = {
  "blood-pressure": queryKeys.insightsBpStatus,
  weight: queryKeys.insightsWeightStatus,
  pulse: queryKeys.insightsPulseStatus,
  bmi: queryKeys.insightsBmiStatus,
  mood: queryKeys.insightsMoodStatus,
  "medication-compliance": queryKeys.insightsMedicationComplianceStatus,
};

/**
 * Shared loader for the insight-status payload backing
 * `/insights/<metric>` sub-pages. Five sub-pages previously copy-pasted
 * the same 13-line useQuery block plus an identical `XxxStatusData`
 * interface; the hook collapses them onto one helper plus the existing
 * `queryKeys` factory so the next "add a metric" PR touches one map
 * entry instead of an entire page module.
 *
 * Returns the `useQuery` result narrowed to the `InsightStatusData`
 * payload — callers stay free to use `data` / `isLoading` / refetch
 * helpers without an extra unwrap.
 */
export function useInsightStatus(metric: InsightStatusMetric) {
  const { isAuthenticated } = useAuth();
  // Status notes are model-written: no read while the `statusText`
  // capability is unavailable (the card is hidden then anyway). Unavailable
  // while `/me` loads, so the first paint fires nothing.
  const statusText = useAiCapability("statusText");
  const { responseTimeoutMs } = useAiProviderState();
  const { locale } = useTranslations();
  const queryKey = QUERY_KEY_FACTORY[metric](locale);

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }): Promise<InsightStatusData> =>
      fetchStatusData(
        `/api/insights/${metric}-status?locale=${locale}`,
        signal,
      ),
    enabled: isAuthenticated && statusText.available,
    staleTime: 60 * 1000,
    // v1.4.28 — the status route returns a deterministic envelope on
    // a miss/timeout. Retrying inline re-fires work and lengthens the
    // perceived hang; the bounded `preparing` poll below covers the warm-up.
    retry: 0,
    // v1.8.3 — poll only while the worker is preparing the assessment.
    // Returns false (no timer) for any terminal payload so a settled card
    // never re-fetches on an interval. v1.8.4 — also stop after the
    // attempt ceiling so a persistently failing generation can't poll an
    // open page forever.
    refetchInterval: (query) =>
      nextStatusPollInterval(
        query.state.data?.preparing,
        pollAttemptCount(query.state),
        query.state.data?.revalidating,
        statusPollMaxAttempts(responseTimeoutMs),
      ),
  });
  const pollAttempts = useStatusPollAttemptCount(queryKey);
  return {
    ...query,
    data: applyStatusPollExhaustion(
      query.data,
      pollAttempts,
      statusPollMaxAttempts(responseTimeoutMs),
    ),
  };
}

/**
 * v1.8.7.1 — generic per-metric assessment loader for the HealthKit
 * metric sub-pages. The seven bespoke metrics above (`weight`, `pulse`,
 * …) each own a hand-written `/api/insights/<metric>-status` route; the
 * ~29 HealthKit pages instead share one generic route keyed by the
 * metric id:
 *
 *   GET /api/insights/metric-status?metric=<METRIC_ID>&locale=<locale>
 *
 * where METRIC_ID is the existing HealthKit measurement identifier
 * (`HEART_RATE_VARIABILITY`, `RESTING_HEART_RATE`, `SLEEP_DURATION`, …).
 * The response envelope, the 8 s client ceiling, the no-retry policy and
 * the bounded `preparing` poll are identical to `useInsightStatus` — the
 * card consumes the same `InsightStatusData` shape for every scope.
 *
 * `enabled` lets the page suppress the fetch entirely when the metric has
 * no data (the page renders the insufficient-data empty state instead of
 * the card), so a brand-new account never fires an assessment round-trip.
 */
export function useInsightMetricStatus(
  // The closed registry-id union (the route's Zod enum vocabulary). `""`
  // is the disabled-fetch placeholder the `HealthKitMetricPage` passes when
  // no `statusMetric` is wired (the hook must still run per the rules of
  // hooks); `enabled` is false on that branch so the empty id never reaches
  // a round-trip. A typo'd metric id is therefore a compile error.
  metric: MetricStatusMetricId | "",
  enabled = true,
) {
  const { isAuthenticated } = useAuth();
  const statusText = useAiCapability("statusText");
  const { responseTimeoutMs } = useAiProviderState();
  const { locale } = useTranslations();
  const queryKey = queryKeys.insightsMetricStatus(metric, locale);

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }): Promise<InsightStatusData> =>
      fetchStatusData(
        `/api/insights/metric-status?metric=${encodeURIComponent(
          metric,
        )}&locale=${locale}`,
        signal,
      ),
    enabled: isAuthenticated && enabled && statusText.available,
    staleTime: 60 * 1000,
    retry: 0,
    refetchInterval: (query) =>
      nextStatusPollInterval(
        query.state.data?.preparing,
        pollAttemptCount(query.state),
        query.state.data?.revalidating,
        statusPollMaxAttempts(responseTimeoutMs),
      ),
  });
  const pollAttempts = useStatusPollAttemptCount(queryKey);
  return {
    ...query,
    data: applyStatusPollExhaustion(
      query.data,
      pollAttempts,
      statusPollMaxAttempts(responseTimeoutMs),
    ),
  };
}

/**
 * Per-biomarker assessment loader for the lab-marker detail page. Mirrors
 * `useInsightMetricStatus` exactly — the same `InsightStatusData` envelope,
 * the 8 s client ceiling, the no-retry policy, and the bounded `preparing`
 * poll — but keyed by the marker id against
 * `GET /api/insights/biomarker-assessment?biomarkerId=…`.
 *
 * Read-only + stale-while-revalidate: the route serves cached text and warms
 * a regeneration out of band on a cache miss, exactly like every metric
 * page. Generation never warms on mount beyond that shared seam; the worker
 * cron + the read-only enqueue are the only producers.
 *
 * `enabled` lets the page suppress the fetch when the marker has no readings
 * (the page renders its empty state instead of the card), so a brand-new
 * marker never fires an assessment round-trip.
 */
export function useInsightBiomarkerAssessment(
  biomarkerId: string,
  enabled = true,
) {
  const { isAuthenticated } = useAuth();
  const statusText = useAiCapability("statusText");
  const { responseTimeoutMs } = useAiProviderState();
  const { locale } = useTranslations();
  const queryKey = queryKeys.insightsBiomarkerAssessment(biomarkerId, locale);

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }): Promise<InsightStatusData> =>
      fetchStatusData(
        `/api/insights/biomarker-assessment?biomarkerId=${encodeURIComponent(
          biomarkerId,
        )}&locale=${locale}`,
        signal,
      ),
    enabled:
      isAuthenticated &&
      enabled &&
      statusText.available &&
      biomarkerId.length > 0,
    staleTime: 60 * 1000,
    retry: 0,
    refetchInterval: (query) =>
      nextStatusPollInterval(
        query.state.data?.preparing,
        pollAttemptCount(query.state),
        query.state.data?.revalidating,
        statusPollMaxAttempts(responseTimeoutMs),
      ),
  });
  const pollAttempts = useStatusPollAttemptCount(queryKey);
  return {
    ...query,
    data: applyStatusPollExhaustion(
      query.data,
      pollAttempts,
      statusPollMaxAttempts(responseTimeoutMs),
    ),
  };
}
