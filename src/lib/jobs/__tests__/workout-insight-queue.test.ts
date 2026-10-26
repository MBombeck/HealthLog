/**
 * Dead-queue guard for the `workout-insight-generate` queue.
 *
 * This queue fails open in the worst possible way. Nothing warms it, no cron
 * touches it, and no read path triggers it — the ONLY thing that ever puts work
 * on it is the arrival spine's dispatch. So if the registry does not declare
 * the queue, pg-boss never provisions it, every `boss.send` resolves
 * successfully, every job vanishes, and the only symptom is that no workout
 * ever gets a paragraph. That is indistinguishable from the feature's own
 * honest empty state, which is exactly why it needs a structural guard rather
 * than a behavioural one.
 *
 * Reads the worker registry for the queue facts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { handleWorkoutInsightGenerate } from "@/lib/jobs/workout-insight-generate";
import {
  WORKOUT_INSIGHT_GENERATE_CONCURRENCY,
  WORKOUT_INSIGHT_GENERATE_QUEUE,
} from "@/lib/jobs/workout-insight-generate-shared";
import {
  groupOf,
  jobOf,
  loadedHandler,
} from "@/lib/jobs/registry/__tests__/registry-helpers";

describe("workout-insight-generate queue wiring", () => {
  it("provisions the queue in the status group", () => {
    expect(groupOf(WORKOUT_INSIGHT_GENERATE_QUEUE).name).toBe("status");
  });

  it("binds the handler that drains it", async () => {
    expect(await loadedHandler(WORKOUT_INSIGHT_GENERATE_QUEUE)).toBe(
      handleWorkoutInsightGenerate,
    );
  });

  it("runs the provider path serially", () => {
    // This IS the provider path the spine deliberately does not walk. Widening
    // the concurrency would let one sync's worth of workouts fan out into
    // parallel completions.
    expect(jobOf(WORKOUT_INSIGHT_GENERATE_QUEUE).work).toEqual({
      localConcurrency: WORKOUT_INSIGHT_GENERATE_CONCURRENCY,
    });
  });

  it("has no cron schedule — it is dispatched by arrival only", () => {
    // A cron here would be a standing invitation to regenerate, which is the
    // saturation surface the design refuses.
    const job = jobOf(WORKOUT_INSIGHT_GENERATE_QUEUE);
    expect(job.cron).toBeUndefined();
    expect(job.scheduleOptions).toBeUndefined();
  });

  it("is reached from the spine only through the generator-free module", () => {
    // The spine's zero-spend claim is a module-graph property. If the worker
    // dispatch imported the generator, the provider clients would become
    // reachable from `data-arrival.ts` and the isolation guard would go red.
    const worker = readFileSync(
      join(__dirname, "..", "data-arrival.ts"),
      "utf8",
    );
    expect(worker).toMatch(
      /from "@\/lib\/jobs\/workout-insight-generate-shared"/,
    );
    expect(worker).not.toMatch(/from "@\/lib\/jobs\/workout-insight-generate"/);
  });
});
