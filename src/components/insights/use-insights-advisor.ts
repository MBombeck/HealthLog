"use client";

import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InsightResult } from "@/lib/ai/types";
import {
  dailyBriefingSchema,
  trendAnnotationsSchema,
  type DailyBriefing as DailyBriefingPayload,
  type TrendAnnotations,
} from "@/lib/ai/schema";
import { queryKeys } from "@/lib/query-keys";

/**
 * v1.4.16 phase D reconcile (CRITICAL C1 + C2) — shared TanStack Query
 * helper that reads the rich advisor payload from `/api/insights/generate`.
 *
 * Why a POST under a `useQuery` rather than a dedicated GET endpoint:
 * the route already cache-returns the most recent generation (24h TTL on
 * `User.insightsCachedAt` / `User.insightsCachedText`) without burning a
 * rate-limit token, so a single POST-without-`force` is functionally a
 * GET-or-generate. Adding a separate GET would duplicate the cache-read
 * branch and split the audit-log surface; the reconcile report deferred
 * C1+C2 specifically because it assumed that duplication was required,
 * but the route already supports the cache-aware path.
 *
 * Every surface that mounts the query under the same key shares the
 * cache, so a regenerate from one surface refreshes the others without
 * a second LLM call.
 */
export interface InsightAdvisorPayload {
  insights: InsightResult;
  cached: boolean;
  cachedAt?: string | null;
  legacyPayload?: boolean;
  /**
   * v1.4.20 phase B1 — Daily Briefing block surfaced for the new hero
   * strip + briefing card. Lives on the cached payload alongside the
   * legacy `insights` shape (see `aiInsightResponseSchema` — the
   * `.passthrough()` lets the field round-trip through any provider).
   * Validated client-side via the schema's `safeParse` to keep a
   * malformed payload from poisoning the briefing card.
   */
  dailyBriefing?: DailyBriefingPayload | null;
  /**
   * v1.4.20 phase B3 — optional trend annotations for the Trends row.
   * Same lift-pattern as `dailyBriefing` — validated client-side and
   * left null when the cached payload predates PROMPT_VERSION 4.20.1.
   */
  trendAnnotations?: TrendAnnotations | null;
}

/**
 * v1.4.31 — bound the advisor POST with an 8-second
 * `AbortController` so a cache-miss path (server still waiting on
 * the provider chain) does not pin the mother-page main thread for
 * the LLM's full completion tail. The strip stays interactive in
 * the DOM, but every re-render of a parent during a long pending
 * fetch competes with WebKit's gesture-recognition timeout —
 * dropping the worst case from 30 s to 8 s eliminates the
 * mobile-tap-block window per
 * `.planning/research/v15-insights-blocking-bug.md` fix 1.
 */
const ADVISOR_TIMEOUT_MS = 8_000;

async function fetchAdvisor(
  options: { force?: boolean } = {},
): Promise<InsightAdvisorPayload | null> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(),
    ADVISOR_TIMEOUT_MS,
  );
  let res: Response;
  try {
    res = await fetch("/api/insights/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options.force ? { force: true } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      // Graceful empty payload — the UI surfaces the empty / regen
      // CTA exactly as it does for the 422 / 429 / 503 paths below.
      return null;
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }
  if (!res.ok) {
    // 422 (no provider configured) and 429 (rate-limited) are expected
    // surfaces — return null so the consuming UI shows the empty / error
    // state without the query slipping into an `isError` retry loop.
    if (res.status === 422 || res.status === 429 || res.status === 503) {
      return null;
    }
    throw new Error(`HTTP ${res.status}`);
  }
  const json = await res.json();
  const payload = json.data as InsightAdvisorPayload;
  // The cached `insights` blob may carry a `dailyBriefing` from a fresh
  // PROMPT_VERSION 4.20.x generation. Lift it onto the payload so
  // consumers don't have to know the legacy shape.
  const briefingCandidate = (payload?.insights as Record<string, unknown>)
    ?.dailyBriefing;
  if (briefingCandidate != null) {
    const parsed = dailyBriefingSchema.safeParse(briefingCandidate);
    if (parsed.success) {
      payload.dailyBriefing = parsed.data;
    } else {
      // Malformed cached briefing — keep null so the UI shows the
      // empty-state CTA instead of a half-rendered card.
      payload.dailyBriefing = null;
    }
  } else {
    payload.dailyBriefing = null;
  }

  // v1.4.20 phase B3 — same lift for `trendAnnotations`. Cached payloads
  // from the 4.20.0 line predate the field, so null is the expected
  // default. A malformed candidate also resolves to null so the UI
  // surfaces the per-metric empty hint instead of a half-rendered card.
  const annotationsCandidate = (payload?.insights as Record<string, unknown>)
    ?.trendAnnotations;
  if (annotationsCandidate != null) {
    const parsed = trendAnnotationsSchema.safeParse(annotationsCandidate);
    payload.trendAnnotations = parsed.success ? parsed.data : null;
  } else {
    payload.trendAnnotations = null;
  }
  return payload;
}

export interface UseInsightsAdvisorResult {
  payload: InsightAdvisorPayload | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  regenerate: () => void;
  isRegenerating: boolean;
  regenerateError: Error | null;
}

/**
 * Read-only consumer for the advisor payload. Use this on surfaces that
 * just want to render the cached insight (e.g. dashboard preview).
 */
export function useInsightsAdvisorQuery(
  enabled: boolean,
): UseInsightsAdvisorResult {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.insightsAdvisor(),
    queryFn: () => fetchAdvisor(),
    enabled,
    // 24h cache window matches the server-side `insightsCachedAt` TTL.
    staleTime: 60 * 60 * 1000,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: () => fetchAdvisor({ force: true }),
    onSuccess: (next) => {
      if (next) {
        queryClient.setQueryData(queryKeys.insightsAdvisor(), next);
      } else {
        queryClient.invalidateQueries({
          queryKey: queryKeys.insightsAdvisor(),
        });
      }
      // Per-status caches are evicted server-side on regenerate; refresh
      // their query subtree so the per-section text below the advisor card
      // re-fetches.
      queryClient.invalidateQueries({ queryKey: queryKeys.insightsRoot() });
    },
  });

  // v1.8.3 — stabilise the `regenerate` callback so the memoised
  // `<InsightsTabStrip>` (which receives it as `onRegenerate`) is not
  // re-rendered on every shell render by a fresh arrow reference. A
  // status-query flip on a sub-page that re-renders the shell would
  // otherwise re-reconcile the whole strip mid-gesture and eat taps.
  const { mutate } = mutation;
  const regenerate = useCallback(() => mutate(), [mutate]);

  return {
    payload: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    error: (query.error as Error | null) ?? null,
    regenerate,
    isRegenerating: mutation.isPending,
    regenerateError: (mutation.error as Error | null) ?? null,
  };
}
