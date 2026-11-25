/**
 * The dashboard's seven-day means without the rest of its summaries slice,
 * for the target verdicts (`/api/insights/targets`).
 */
import { readCanonicalWindow } from "@/lib/analytics/canonical-window";
import { buildSourceRankCase } from "@/lib/analytics/source-rank-sql";
import {
  summariesSliceCacheKey,
  type SummariesSlice,
} from "@/lib/analytics/summaries-slice";
import { caches, type ServerCache } from "@/lib/cache/server-cache";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { roundStable2 } from "@/lib/stats/central";

/**
 * The seven-day mean per type, exactly as the slice computes `avg7` (the same
 * canonical-source CTE, the same day weighting, the same rounding), without
 * the rest of the slice. Sleep is absent: the slice summarises it per night.
 * For a reader that needs only the dashboard's basis, such as the target
 * verdicts: no reading ever leaves the database as a row.
 *
 * The read is the slice's own window aggregate (`readCanonicalWindow`, whose
 * closed block the two share), so when a fresh slice is
 * cached (the dashboard and the insights page read it on the same load) its
 * `avg7` is taken instead of running the aggregate a second time.
 * A type is in the answer when it has readings in the aggregate's 90-day
 * window, which in the slice is a type with a 90-day median.
 */
export async function readSevenDayMeans(
  userId: string,
): Promise<Record<string, number | null>> {
  const slice = (caches.analytics as ServerCache<SummariesSlice>).get(
    summariesSliceCacheKey(userId),
  );
  if (slice) {
    const out: Record<string, number | null> = {};
    for (const [type, summary] of Object.entries(slice.summaries)) {
      if (type === "SLEEP_DURATION" || summary.median === null) continue;
      out[type] = summary.avg7;
    }
    return out;
  }
  const priorityJson = await loadUserSourcePriority(userId);
  const rankUnqualified = buildSourceRankCase(
    priorityJson,
    '"type"',
    '"source"',
  );
  const rows = await readCanonicalWindow(
    userId,
    new Date(),
    priorityJson,
    rankUnqualified,
  );
  const out: Record<string, number | null> = {};
  for (const row of rows) {
    // Stored per stage, summarised per night by the slice's night pass: a
    // mean over stage rows is not the slice's sleep figure, so it is left
    // out rather than served wrong. Callers fold the nights themselves.
    if (row.type === "SLEEP_DURATION") continue;
    out[row.type] = roundStable2(row.avg7);
  }
  return out;
}
