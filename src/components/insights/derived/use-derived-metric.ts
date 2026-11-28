"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import type {
  DerivedCoverage,
  DerivedConfidence,
  DerivedProvenance,
} from "@/lib/insights/derived/types";
import type { DerivedAssessment } from "@/lib/insights/derived/derived-assessment";
import { apiGet } from "@/lib/api/api-fetch";

/**
 * v1.10.0 — the single TanStack Query hook for the generic derived-metric
 * route, shared by every client surface (vitals dashboard tiles, composite
 * score-anatomy, the home wellness strip).
 *
 * `GET /api/insights/derived?metric=<id>[&type=<vital>]` returns the
 * compute-once flattened `Derived<T>` the surfaces read. The queryKey comes
 * from the centralised factory (`queryKeys.insightsDerived`) so the bare-array
 * ESLint rule stays satisfied and the cache never poisons across metrics; the
 * read unwraps `(await res.json()).data` per the envelope convention.
 *
 * Pure compute on the server (sub-second on a warm rollup tenant) — so the
 * hook bounds the fetch on an 8 s client ceiling (a slow response means a
 * degraded network, not a provider call), keeps a 60 s `staleTime`, gates on
 * auth, and never inline-retries. These reads NEVER warm/generate on visit —
 * they read already-computed rollup values (the v1.4.36 / v1.9.1 lesson: a
 * warm-on-mount fan-out looks like the app hanging).
 *
 * Type-only import of the `Derived<T>` facets — no server module enters the
 * client bundle (the v1.9.0 lesson). The value `T` is left generic so each
 * caller narrows to its own metric payload (`FitnessAgeValue`, `BmiValue`, …)
 * imported as `import type`.
 */

const DERIVED_TIMEOUT_MS = 8_000;

/** The flattened wire shape the route emits in the `data` envelope slot. */
export interface DerivedMetricResponse<T> {
  metric: string;
  status: "ok" | "insufficient";
  value: T | null;
  coverage: DerivedCoverage;
  confidence: DerivedConfidence | null;
  provenance: DerivedProvenance;
  reason: string | null;
  /**
   * v1.13.2 — the per-score "why is this score what it is" assessment
   * ({ text, source, updatedAt }). Populated only for the assessable scores
   * (READINESS, SLEEP_SCORE, RECOVERY_SCORE, STRAIN_SCORE, STRESS_SCORE) when
   * `status === "ok"`, null otherwise. The single-metric route serves the
   * AI-warm prose (falling back to the deterministic template); the batch route
   * serves the cheap deterministic text only. Optional on the wire shape so
   * grid reads that drop it stay typed. v1.15.12 B3 surfaces it on the web
   * score-anatomy detail page (it already shipped to iOS in v1.13.2).
   */
  assessment?: DerivedAssessment | null;
  /**
   * 1.50 — the score's short name for a tile, worded by the server from the
   * glossary (null for a metric that is no HealthLog score). A tile renders
   * it as given.
   */
  shortLabel?: string | null;
}

export interface UseDerivedMetricOptions {
  /** Optional sub-target (the chosen vital for `VITALS_BASELINE`). */
  type?: string | null;
  /** Gate the fetch (e.g. on a surface flag). Defaults to enabled. */
  enabled?: boolean;
}

export function useDerivedMetric<T>(
  metric: string,
  options: UseDerivedMetricOptions = {},
) {
  const { type = null, enabled = true } = options;
  const { isAuthenticated } = useAuth();
  const gated = enabled && isAuthenticated && metric !== "";

  return useQuery({
    queryKey: queryKeys.insightsDerived(metric, type),
    queryFn: async (): Promise<DerivedMetricResponse<T>> => {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(
        () => controller.abort(),
        DERIVED_TIMEOUT_MS,
      );
      try {
        const params = new URLSearchParams({ metric });
        if (type) params.set("type", type);
        return apiGet<DerivedMetricResponse<T>>(
          `/api/insights/derived?${params.toString()}`,
          { signal: controller.signal },
        );
      } finally {
        clearTimeout(timeoutHandle);
      }
    },
    enabled: gated,
    staleTime: 60_000,
    retry: 0,
  });
}

/**
 * A batch request token: a metric id with an optional VITALS_BASELINE
 * sub-target. Wire form is `metric` or `metric:type` inside the CSV.
 */
export interface DerivedBatchToken {
  metric: string;
  type?: string | null;
}

/** Build the `metric` / `metric:type` wire token for one batch item. */
function tokenString(token: DerivedBatchToken): string {
  return token.type ? `${token.metric}:${token.type}` : token.metric;
}

/** The batch route's `data` shape — a map keyed by the per-request token. */
export interface DerivedBatchResponse {
  metrics: Record<string, DerivedMetricResponse<unknown>>;
}

/**
 * The typed `read` selector `useDerivedBatch` returns — a tile narrows its
 * own metric value out of the resolved map exactly as it did per-metric.
 */
export type DerivedBatchRead = <T>(
  token: DerivedBatchToken,
) => DerivedMetricResponse<T> | null;

/**
 * v1.10.0 — ONE batched read for a set of derived metrics, the dashboard's
 * cold-mount fan-out fix. Replaces N independent `useDerivedMetric` queries
 * (each a separate request sharing the Prisma pool — the v1.9.1 "hangs then
 * recovers" symptom) with a single `GET /api/insights/derived/batch`. The
 * server fans out under a bounded limiter and loads the profile once.
 *
 * Returns a typed `read(token)` selector so a tile pulls its own
 * `DerivedMetricResponse<T>` out of the map with the same narrowing it had
 * per-metric. Same 8 s ceiling + `retry:0` + 60 s `staleTime` as the single
 * hook; these reads never warm/generate on visit.
 */
export function useDerivedBatch(
  tokens: DerivedBatchToken[],
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options;
  const { isAuthenticated } = useAuth();
  const wireTokens = tokens.map(tokenString);
  const gated = enabled && isAuthenticated && wireTokens.length > 0;

  const query = useQuery({
    queryKey: queryKeys.insightsDerivedBatch(wireTokens),
    queryFn: async (): Promise<DerivedBatchResponse> => {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(
        () => controller.abort(),
        DERIVED_TIMEOUT_MS,
      );
      try {
        const params = new URLSearchParams({ metrics: wireTokens.join(",") });
        return apiGet<DerivedBatchResponse>(
          `/api/insights/derived/batch?${params.toString()}`,
          { signal: controller.signal },
        );
      } finally {
        clearTimeout(timeoutHandle);
      }
    },
    enabled: gated,
    staleTime: 60_000,
    retry: 0,
  });

  /** Pull one metric's value out of the resolved map, narrowed to `T`. */
  function read<T>(token: DerivedBatchToken): DerivedMetricResponse<T> | null {
    const entry = query.data?.metrics[tokenString(token)];
    return (entry as DerivedMetricResponse<T> | undefined) ?? null;
  }

  return { ...query, read };
}
