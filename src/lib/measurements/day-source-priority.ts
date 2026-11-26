import { memoizePerRequest } from "@/lib/request-cache";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";

/**
 * The user's source-priority blob for the day readers that keep each day to
 * its ladder-winning source (`readDayMeanSeries`, `readLatestDayMean`).
 * Those run once per type, and a dashboard, digest or health-status request
 * walks a dozen types: read the blob once per request rather than once per
 * type. A background pass reads it afresh, since one event spans many users
 * and a ladder changed mid-run should hold for the next read.
 */
export function loadDaySourcePriority(userId: string): Promise<unknown> {
  return memoizePerRequest(
    `source-priority:${userId}`,
    () => loadUserSourcePriority(userId),
    { freshInBackground: true },
  );
}
