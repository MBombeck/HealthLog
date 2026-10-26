/**
 * The user-facing reminder ticks: the medication overdue check, the daily
 * mood reminder, the cycle reminder, the checkup (measurement) reminder, and
 * the eventful reminder-satisfy queue.
 *
 * The three daily reminders tick every 15 minutes and short-circuit unless
 * the user's local time is the reminder's hour, so one UTC cron serves every
 * zone; each keeps its own once-a-day anchor (a dispatch ledger, the
 * `push_attempts` row, the reminder's `nextDueAt`). Every tick is
 * single-flight so two ticks never race that anchor.
 *
 * Every queue here keeps pg-boss's default retries: a job-level failure means
 * the pass itself could not run, a transient. The satisfy queue sets its own
 * `retryLimit` at send time (`reminder-satisfy.ts`).
 */
import {
  REMINDER_SATISFY_CONCURRENCY,
  REMINDER_SATISFY_QUEUE,
} from "@/lib/jobs/reminder-satisfy";

import { defineJob, type JobDefinition, type JobGroup } from "./define-job";

const MEDICATION_REMINDER_CHECK_QUEUE = "medication-reminder-check";
const MEDICATION_REMINDER_CHECK_CRON = "*/15 * * * *";
const MOOD_REMINDER_QUEUE = "mood-reminder-check";
const MOOD_REMINDER_CRON = "*/15 * * * *";
const CYCLE_REMINDER_QUEUE = "cycle-reminder-check";
const CYCLE_REMINDER_CRON = "*/15 * * * *";
const MEASUREMENT_REMINDER_QUEUE = "measurement-reminder-check";
const MEASUREMENT_REMINDER_CRON = "*/15 * * * *";

const checks = () => import("@/lib/jobs/reminder/mood-cycle-checks");

const jobs: readonly JobDefinition[] = [
  defineJob({
    queue: MEDICATION_REMINDER_CHECK_QUEUE,
    cron: MEDICATION_REMINDER_CHECK_CRON,
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/reminder/medication-reminder-check"))
        .handleReminderCheck,
  }),
  defineJob({
    queue: MOOD_REMINDER_QUEUE,
    cron: MOOD_REMINDER_CRON,
    work: { localConcurrency: 1 },
    load: async () => (await checks()).handleMoodReminderCheck,
  }),
  defineJob({
    queue: CYCLE_REMINDER_QUEUE,
    cron: CYCLE_REMINDER_CRON,
    work: { localConcurrency: 1 },
    load: async () => (await checks()).handleCycleReminderCheck,
  }),
  defineJob({
    queue: MEASUREMENT_REMINDER_QUEUE,
    cron: MEASUREMENT_REMINDER_CRON,
    work: { localConcurrency: 1 },
    load: async () => (await checks()).handleMeasurementReminderCheck,
  }),
  // No cron: enqueued by the ingest paths when a measurement or lab lands;
  // the 15-minute checkup tick is the safety net.
  defineJob({
    queue: REMINDER_SATISFY_QUEUE,
    work: { localConcurrency: REMINDER_SATISFY_CONCURRENCY },
    load: async () => (await checks()).handleReminderSatisfy,
  }),
];

export const REMINDERS_GROUP: JobGroup = { name: "reminders", jobs };
