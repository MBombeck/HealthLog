/**
 * The user-facing reminder ticks: the medication overdue check, the daily
 * mood reminder, the cycle reminder, the checkup (measurement) reminder, and
 * the eventful reminder-satisfy queue, the push relay's minute pass (its
 * outbox retries, breaker probe, sender-key rotation and receipt report), and
 * the two silent wakes: the DATA_CHANGED minute flush and the hourly
 * HealthKit catch-up.
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
// The four reminder checks keep their quarter-hour cadence but start apart:
// the medication check on the quarter hour, the others two, four and six
// minutes after it. Web and worker share one process by default, so nine
// jobs starting in the same second were a latency spike for whoever was
// using the app at :00, :15, :30 and :45.
const MEDICATION_REMINDER_CHECK_CRON = "*/15 * * * *";
const MOOD_REMINDER_QUEUE = "mood-reminder-check";
const MOOD_REMINDER_CRON = "2-59/15 * * * *";
const CYCLE_REMINDER_QUEUE = "cycle-reminder-check";
const CYCLE_REMINDER_CRON = "4-59/15 * * * *";
const MEASUREMENT_REMINDER_QUEUE = "measurement-reminder-check";
const MEASUREMENT_REMINDER_CRON = "6-59/15 * * * *";
// Every 15 minutes like the reminders, eight minutes past: it short-circuits
// unless the person's local hour is the push hour, so one UTC cron serves
// every zone.
const MEASUREMENT_ANOMALY_QUEUE = "measurement-anomaly-check";
const MEASUREMENT_ANOMALY_CRON = "8-59/15 * * * *";
const PUSH_RELAY_MAINTENANCE_QUEUE = "push-relay-maintenance";
const PUSH_RELAY_MAINTENANCE_CRON = "* * * * *";
// The DATA_CHANGED wakes whose five-minute window closed; every minute.
const PUSH_DATA_CHANGED_QUEUE = "push-data-changed";
const PUSH_DATA_CHANGED_CRON = "* * * * *";
// Devices whose Apple Health upload fell behind; hourly, off the hour.
const HEALTHKIT_CATCH_UP_QUEUE = "healthkit-catch-up";
const HEALTHKIT_CATCH_UP_CRON = "23 * * * *";

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
  defineJob({
    queue: MEASUREMENT_ANOMALY_QUEUE,
    cron: MEASUREMENT_ANOMALY_CRON,
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/measurement-anomaly-check"))
        .handleMeasurementAnomalyCheck,
  }),
  // Every minute; a pass with nothing to do reads two rows and returns.
  defineJob({
    queue: PUSH_RELAY_MAINTENANCE_QUEUE,
    cron: PUSH_RELAY_MAINTENANCE_CRON,
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/push-relay-maintenance"))
        .handlePushRelayMaintenance,
  }),
  // Every minute; a pass with nothing pending reads one index and returns.
  defineJob({
    queue: PUSH_DATA_CHANGED_QUEUE,
    cron: PUSH_DATA_CHANGED_CRON,
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/push-data-changed")).handlePushDataChanged,
  }),
  defineJob({
    queue: HEALTHKIT_CATCH_UP_QUEUE,
    cron: HEALTHKIT_CATCH_UP_CRON,
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/healthkit-catch-up")).handleHealthKitCatchUp,
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
