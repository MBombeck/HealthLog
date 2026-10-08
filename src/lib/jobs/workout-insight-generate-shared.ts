/**
 * Generator-free enqueue contract for the per-workout Activity Insight.
 *
 * The split matters structurally, not stylistically. The data-arrival spine's
 * central cost claim — that the worker cannot spend a token — is enforced by a
 * module-graph test that BFS-walks the static imports of
 * `@/lib/jobs/data-arrival`. The spine dispatches THIS surface, so if the
 * dispatch pulled in the generator, the generator's provider clients would
 * become reachable from the spine and that guard would go red, correctly.
 *
 * So the spine imports only this module: a queue name, a payload, and a
 * `boss.send`. The worker that resolves a provider lives in
 * `workout-insight-generate.ts` and is imported solely by the worker registrar.
 */
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";
import { logCaught } from "@/lib/logging/signal";

export const WORKOUT_INSIGHT_GENERATE_QUEUE = "workout-insight-generate";

/** Serial — this is a provider path, kept off the request pool entirely. */
export const WORKOUT_INSIGHT_GENERATE_CONCURRENCY = 1;

export interface WorkoutInsightGeneratePayload {
  userId: string;
  workoutId: string;
}

/**
 * Enqueue one workout's paragraph generation.
 *
 * The singleton key is the workout id, so a device that posts the same session
 * three times during a sync retry produces one job. That is a best-effort
 * collapse and is treated as such: the worker does not rely on it. The unique
 * `WorkoutInsight.workoutId` row and the input-hash gate each independently
 * refuse a second generation, so a lost singleton race costs one cheap read,
 * never a second provider call.
 *
 * A missing producer or failed send returns `{ enqueued: false }`. The arrival
 * worker treats that as a transient fan-out failure so pg-boss retries the
 * source event; callers outside that worker may still choose an honest no-card
 * fallback.
 */
export async function enqueueWorkoutInsight(
  payload: WorkoutInsightGeneratePayload,
): Promise<{ enqueued: boolean }> {
  const boss = getGlobalBoss();
  if (!boss) return { enqueued: false };
  try {
    await boss.send(WORKOUT_INSIGHT_GENERATE_QUEUE, payload, {
      singletonKey: `workout-insight:${payload.workoutId}`,
      // The LLM-bound queues' shared policy: a provider hiccup or a pool
      // exhaustion earns three backed-off retries. Every BUSINESS refusal in
      // the worker returns a status instead of throwing, so a retry here only
      // ever re-runs a genuinely transient fault.
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
    });
    return { enqueued: true };
  } catch (err) {
    annotate({
      action: { name: "workouts.insight.enqueue_failed" },
      meta: { workoutId: payload.workoutId },
    });
    logCaught("workouts.insight.enqueue_failed", err);
    return { enqueued: false };
  }
}
