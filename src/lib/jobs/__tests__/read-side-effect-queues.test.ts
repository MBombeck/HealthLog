/**
 * Dead-queue guard for the two queues that took the writes off the read paths.
 *
 * Moving a write off a GET only works if the new owner actually runs. A queue
 * the worker registry does not declare is never provisioned, a schedule
 * without a bound handler drains into nothing, and either failure is silent:
 * the cron fires, the job vanishes, and the only symptom is a forecast that
 * stops moving or an unlock date that is never pinned. Both look exactly like
 * "nothing to do".
 *
 * Reads the registry declarations, matching the sibling `*-queue.test.ts`
 * guards.
 */
import { describe, expect, it } from "vitest";

import { handleAchievementUnlockSweep } from "@/lib/jobs/achievement-unlock-sweep";
import {
  ACHIEVEMENT_UNLOCK_SWEEP_CRON,
  ACHIEVEMENT_UNLOCK_SWEEP_QUEUE,
} from "@/lib/jobs/achievement-unlock-sweep-queue";
import {
  CYCLE_PREDICTION_REFRESH_CRON,
  CYCLE_PREDICTION_REFRESH_QUEUE,
  handleCyclePredictionRefresh,
} from "@/lib/jobs/cycle-prediction-refresh";
import {
  groupOf,
  jobOf,
  loadedHandler,
} from "@/lib/jobs/registry/__tests__/registry-helpers";
import { SUBSYSTEM_SURFACE } from "@/lib/jobs/subsystem-surface";

const QUEUES = [
  {
    label: "cycle-prediction-refresh",
    queue: CYCLE_PREDICTION_REFRESH_QUEUE,
    cron: CYCLE_PREDICTION_REFRESH_CRON,
    handler: handleCyclePredictionRefresh,
    name: "cycle-prediction-refresh",
  },
  {
    label: "achievement-unlock-sweep",
    queue: ACHIEVEMENT_UNLOCK_SWEEP_QUEUE,
    cron: ACHIEVEMENT_UNLOCK_SWEEP_CRON,
    handler: handleAchievementUnlockSweep,
    name: "achievement-unlock-sweep",
  },
];

describe("queues that own a write moved off a GET", () => {
  for (const queue of QUEUES) {
    describe(queue.label, () => {
      it("is declared in the maintenance group", () => {
        expect(queue.queue).toBe(queue.name);
        expect(groupOf(queue.queue).name).toBe("maintenance");
      });

      it("carries a cron schedule", () => {
        expect(jobOf(queue.queue).cron).toBe(queue.cron);
      });

      it("binds the handler that drains it", async () => {
        expect(await loadedHandler(queue.queue)).toBe(queue.handler);
      });

      it("declares a failure audience", () => {
        expect(Object.keys(SUBSYSTEM_SURFACE)).toContain(queue.name);
      });
    });
  }
});
