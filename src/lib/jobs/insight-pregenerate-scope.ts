/**
 * One nightly pregenerate candidate's scope: its feature cache, and the
 * reason its AI work stopped recorded for the person (#1404). The briefing is
 * the job's own kind; the status notes the same pass warms are recorded under
 * theirs (`trackAiJob` sorts by capability).
 */
import { trackAiJob } from "@/lib/ai/job-failure/report";
import { withFeatureCacheScope } from "@/lib/insights/feature-cache";

export function warmScope<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return withFeatureCacheScope(() =>
    trackAiJob({ userId, job: "briefing" }, fn),
  );
}
