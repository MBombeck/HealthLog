/**
 * Measurement-reminder queue registration guard.
 *
 * Reads the worker registry: the Vorsorge-reminder queue is declared in the
 * reminders group (an unregistered queue is never provisioned and the
 * schedule silently no-ops), scheduled on its cron, and bound to the handler
 * that delegates to `runMeasurementReminderTick`; the eventful
 * reminder-satisfy queue sits beside it. No pg-boss / Prisma boot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  REMINDER_SATISFY_CONCURRENCY,
  REMINDER_SATISFY_QUEUE,
} from "@/lib/jobs/reminder-satisfy";
import {
  handleMeasurementReminderCheck,
  handleReminderSatisfy,
} from "@/lib/jobs/reminder/mood-cycle-checks";
import {
  groupOf,
  jobOf,
  loadedHandler,
} from "@/lib/jobs/registry/__tests__/registry-helpers";

const MEASUREMENT_REMINDER_QUEUE = "measurement-reminder-check";

const handlerSource = readFileSync(
  join(__dirname, "..", "reminder", "mood-cycle-checks.ts"),
  "utf8",
);

describe("measurement-reminder registration", () => {
  it("imports the measurement-reminder tick runner", () => {
    expect(handlerSource).toMatch(
      /from\s*["']@\/lib\/jobs\/measurement-reminder["']/,
    );
    expect(handlerSource).toMatch(/\brunMeasurementReminderTick\b/);
  });

  it("declares the queue in the reminders group", () => {
    expect(groupOf(MEASUREMENT_REMINDER_QUEUE).name).toBe("reminders");
  });

  it("schedules the measurement-reminder cron, single-flight", () => {
    const job = jobOf(MEASUREMENT_REMINDER_QUEUE);
    expect(job.cron).toBe("*/15 * * * *");
    expect(job.work).toEqual({ localConcurrency: 1 });
  });

  it("binds the handler that runs the tick", async () => {
    expect(await loadedHandler(MEASUREMENT_REMINDER_QUEUE)).toBe(
      handleMeasurementReminderCheck,
    );
    expect(handlerSource).toMatch(
      /handleMeasurementReminderCheck[\s\S]{0,400}runMeasurementReminderTick/,
    );
  });
});

describe("eventful reminder-satisfy registration", () => {
  it("declares the satisfy queue in the reminders group, with no cron", () => {
    expect(groupOf(REMINDER_SATISFY_QUEUE).name).toBe("reminders");
    const job = jobOf(REMINDER_SATISFY_QUEUE);
    expect(job.cron).toBeUndefined();
    expect(job.work).toEqual({
      localConcurrency: REMINDER_SATISFY_CONCURRENCY,
    });
  });

  it("binds the satisfy handler", async () => {
    expect(await loadedHandler(REMINDER_SATISFY_QUEUE)).toBe(
      handleReminderSatisfy,
    );
    expect(handlerSource).toMatch(
      /handleReminderSatisfy[\s\S]{0,800}runReminderSatisfyForUser/,
    );
  });
});
