/**
 * v1.4.39.3 — pure helper that merges the dashboard's slim
 * (`/api/analytics?slice=summaries`) and thick (`/api/analytics`)
 * payloads into the single shape the dashboard tile-strip + chart row
 * consumes.
 *
 * Background — v1.4.39.2 split `useAnalyticsQuery` into two parallel
 * mounts so the per-type tile strip paints as soon as the slim slice
 * lands and the BD-Zielbereich + glucose tiles stream in from the
 * thick slice afterwards. The inline `useMemo` that performed the
 * merge originally used `slim?.summaries ?? thick?.summaries` —
 * structurally correct on production where both routes agree, but
 * silently buggy when slim resolves first with an *empty* `{}` (e.g.
 * a freshly-seeded tenant whose rollup tier hasn't folded yet, or a
 * test environment that mocks thick but not slim). The empty object
 * is truthy by JS semantics so `??` short-circuited and the tile
 * strip painted blank even though thick carried the full payload —
 * exactly the regression the v1.4.39.3 e2e CI surfaced across eight
 * dashboard / chart specs.
 *
 * Post-fix: object emptiness is the discriminator. A non-empty slim
 * payload still wins on overlapping fields (the v1.4.39.2 progressive-
 * paint contract). An empty slim falls through to thick. When both
 * are empty, the caller receives an empty record and the dashboard's
 * data-floor gates render the appropriate empty state.
 *
 * Kept as a pure helper so the regression is verified with a tight
 * unit test (`merge-slim-thick.test.ts`) rather than a source-text
 * snapshot — string matching against `src/app/page.tsx` would not
 * have caught the empty-object short-circuit bug.
 */
import type { DataSummary } from "@/lib/analytics/trends";

export interface AnalyticsSlimLike {
  summaries?: Record<string, DataSummary> | null;
  lastSeenByType?: Record<
    string,
    { lastSeenAt: string; daysAgo: number } | null
  > | null;
}

export interface AnalyticsThickLike extends AnalyticsSlimLike {
  bpInTargetPct?: number | null;
  bpInTargetPct7d?: number | null;
  bpInTargetPct30d?: number | null;
  bpInTargetPctAllTime?: number | null;
  bpInTargetPctPriorMonth?: number | null;
  bpInTargetPctPriorYear?: number | null;
  glucoseByContext?: Record<string, unknown> | null;
}

export interface MergedDashboardAnalytics {
  summaries: Record<string, DataSummary>;
  lastSeenByType?:
    | Record<string, { lastSeenAt: string; daysAgo: number } | null>
    | undefined;
  bpInTargetPct: number | null;
  bpInTargetPct7d: number | null;
  bpInTargetPct30d: number | null;
  bpInTargetPctAllTime: number | null;
  bpInTargetPctPriorMonth: number | null;
  bpInTargetPctPriorYear: number | null;
  glucoseByContext: Record<string, unknown> | undefined;
}

function hasContent(record: Record<string, unknown> | null | undefined): boolean {
  return record != null && Object.keys(record).length > 0;
}

/**
 * Merge a slim and a thick analytics payload into the shape the
 * dashboard renders against. Either input may be `undefined`
 * (TanStack query unresolved) or carry an empty record (zero-data
 * tenant); the helper falls back to whichever side has content
 * without ever returning a payload that ignores a populated source.
 *
 * Returns `undefined` when neither input has resolved yet so the
 * caller can keep its loading-state branch unchanged.
 */
export function mergeSlimAndThickAnalytics(
  slim: AnalyticsSlimLike | undefined,
  thick: AnalyticsThickLike | undefined,
): MergedDashboardAnalytics | undefined {
  if (!slim && !thick) return undefined;

  const slimSummariesHaveContent = hasContent(slim?.summaries ?? null);
  const summaries: Record<string, DataSummary> = slimSummariesHaveContent
    ? (slim!.summaries as Record<string, DataSummary>)
    : ((thick?.summaries as Record<string, DataSummary> | null | undefined) ??
        (slim?.summaries as Record<string, DataSummary> | null | undefined) ??
        {});

  const slimFreshnessHasContent = hasContent(slim?.lastSeenByType ?? null);
  const lastSeenByType:
    | Record<string, { lastSeenAt: string; daysAgo: number } | null>
    | undefined = slimFreshnessHasContent
    ? (slim!.lastSeenByType as Record<
        string,
        { lastSeenAt: string; daysAgo: number } | null
      >)
    : (thick?.lastSeenByType ?? undefined);

  return {
    summaries,
    lastSeenByType,
    bpInTargetPct: thick?.bpInTargetPct ?? null,
    bpInTargetPct7d: thick?.bpInTargetPct7d ?? null,
    bpInTargetPct30d: thick?.bpInTargetPct30d ?? null,
    bpInTargetPctAllTime: thick?.bpInTargetPctAllTime ?? null,
    bpInTargetPctPriorMonth: thick?.bpInTargetPctPriorMonth ?? null,
    bpInTargetPctPriorYear: thick?.bpInTargetPctPriorYear ?? null,
    glucoseByContext: thick?.glucoseByContext ?? undefined,
  };
}
