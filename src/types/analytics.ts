/**
 * v1.4.28 R3d (BK-F-M1) — shared shape for the trimmed `/api/analytics`
 * payload that every insights sub-page consumes.
 *
 * Pre-fix, each of the seven `/insights/<metric>/page.tsx` modules
 * declared its own `interface AnalyticsData { summaries: Record<...> }`
 * inline. They were structurally identical so the TanStack-Query cache
 * unified anyway, but maintaining seven copies meant every iOS-contract
 * addition (e.g. a new `MeasurementType`) showed up only after the
 * matching sub-page was touched. Hoisting the interface here is a
 * single-place change.
 *
 * NOTE: the dashboard's `AnalyticsData` (in `src/app/page.tsx`) is a
 * wider type — it carries `bpInTargetPct*` aggregates the sub-pages
 * don't use. The dashboard keeps its own declaration; we'd lose more
 * than we gain by trying to merge them.
 */
import type { DataSummary } from "@/lib/analytics/trends";

export interface SubPageAnalyticsData {
  /** `Record<MeasurementType, DataSummary>` — sentinel value for "not loaded yet" is `undefined`. */
  summaries: Record<string, DataSummary>;
}
