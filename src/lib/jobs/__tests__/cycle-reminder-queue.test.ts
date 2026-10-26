/**
 * Cycle-reminder queue registration guard.
 *
 * Reads the worker registry: the cycle-reminder queue is declared in the
 * reminders group (an unregistered queue is never provisioned and the
 * schedule silently no-ops), scheduled on its 15-minute cron, and bound to
 * the handler that delegates to `runCycleReminderTick`. No pg-boss / Prisma
 * boot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { handleCycleReminderCheck } from "@/lib/jobs/reminder/mood-cycle-checks";
import {
  groupOf,
  jobOf,
  loadedHandler,
} from "@/lib/jobs/registry/__tests__/registry-helpers";

const CYCLE_REMINDER_QUEUE = "cycle-reminder-check";

const handlerSource = readFileSync(
  join(__dirname, "..", "reminder", "mood-cycle-checks.ts"),
  "utf8",
);

describe("cycle-reminder registration", () => {
  it("imports the cycle-reminder tick runner", () => {
    expect(handlerSource).toMatch(
      /from\s*["']@\/lib\/jobs\/cycle-reminder["']/,
    );
    expect(handlerSource).toMatch(/\brunCycleReminderTick\b/);
  });

  it("declares the cycle-reminder queue in the reminders group", () => {
    expect(groupOf(CYCLE_REMINDER_QUEUE).name).toBe("reminders");
  });

  it("schedules the cycle-reminder cron, single-flight", () => {
    const job = jobOf(CYCLE_REMINDER_QUEUE);
    expect(job.cron).toBe("*/15 * * * *");
    expect(job.scheduleOptions).toBeUndefined();
    expect(job.work).toEqual({ localConcurrency: 1 });
  });

  it("binds the handler that runs the cycle-reminder tick", async () => {
    expect(await loadedHandler(CYCLE_REMINDER_QUEUE)).toBe(
      handleCycleReminderCheck,
    );
    expect(handlerSource).toMatch(
      /handleCycleReminderCheck[\s\S]{0,400}runCycleReminderTick/,
    );
  });
});
