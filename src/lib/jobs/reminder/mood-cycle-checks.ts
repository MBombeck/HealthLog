/**
 * Mood-reminder and cycle-reminder 15-minute tick handlers.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import { type Job } from "pg-boss";
import { recordError } from "@/lib/jobs/worker-status";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import { runMoodReminderTick } from "@/lib/jobs/mood-reminder";
import { runCycleReminderTick } from "@/lib/jobs/cycle-reminder";
import {
  runMeasurementReminderTick,
  runReminderSatisfyForUser,
} from "@/lib/jobs/measurement-reminder";
import type { ReminderSatisfyPayload } from "@/lib/jobs/reminder-satisfy";
import { getWorkerPrisma } from "./shared";

export interface MoodReminderPayload {
  triggeredAt: string;
}

export interface CycleReminderPayload {
  triggeredAt: string;
}

export interface MeasurementReminderPayload {
  triggeredAt: string;
}

export async function handleMoodReminderCheck(
  jobs: Job<MoodReminderPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.mood_reminder", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const summary = await runMoodReminderTick(prisma, new Date());
      evt.setBackground({
        task_name: "job.mood_reminder",
        result: {
          candidates_scanned: summary.candidatesScanned,
          in_window: summary.inWindow,
          dispatched: summary.dispatched,
          skipped_already_logged: summary.skippedAlreadyLogged,
          skipped_already_dispatched: summary.skippedAlreadyDispatched,
          skipped_outside_window: summary.skippedOutsideWindow,
        },
      });
      // A tick that found nobody in their local reminder hour still ran the
      // sweep, so it is a success with zero counts.
      return jobDone({
        candidates_scanned: summary.candidatesScanned,
        in_window: summary.inWindow,
        dispatched: summary.dispatched,
        skipped_already_logged: summary.skippedAlreadyLogged,
        skipped_already_dispatched: summary.skippedAlreadyDispatched,
        skipped_outside_window: summary.skippedOutsideWindow,
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * v1.15 — daily cycle-reminder dispatcher (period-soon + period-start-confirm).
 *
 * Thin shim around `runCycleReminderTick` in `cycle-reminder.ts` so the
 * unit tests exercise the windowing + suppression logic without pg-boss.
 */
export async function handleCycleReminderCheck(
  jobs: Job<CycleReminderPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.cycle_reminder", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const summary = await runCycleReminderTick(prisma, new Date());
      evt.setBackground({
        task_name: "job.cycle_reminder",
        result: {
          candidates_scanned: summary.candidatesScanned,
          in_window: summary.inWindow,
          dispatched_period_soon: summary.dispatchedPeriodSoon,
          dispatched_period_confirm: summary.dispatchedPeriodConfirm,
          suppressed_client_managed: summary.suppressedClientManaged,
          suppressed_discreet: summary.suppressedDiscreet,
          skipped_already_notified: summary.skippedAlreadyNotified,
          skipped_outside_window: summary.skippedOutsideWindow,
        },
      });
      return jobDone({
        candidates_scanned: summary.candidatesScanned,
        in_window: summary.inWindow,
        dispatched_period_soon: summary.dispatchedPeriodSoon,
        dispatched_period_confirm: summary.dispatchedPeriodConfirm,
        suppressed_client_managed: summary.suppressedClientManaged,
        suppressed_discreet: summary.suppressedDiscreet,
        skipped_already_notified: summary.skippedAlreadyNotified,
        skipped_outside_window: summary.skippedOutsideWindow,
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * v1.17.1 — every-15-min Vorsorge (measurement) reminder tick. Thin shim
 * around `runMeasurementReminderTick` so the unit tests exercise the
 * due-predicate + auto-resolve + advance logic without pg-boss.
 */
export async function handleMeasurementReminderCheck(
  jobs: Job<MeasurementReminderPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.measurement_reminder", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const summary = await runMeasurementReminderTick(prisma, new Date());
      evt.setBackground({
        task_name: "job.measurement_reminder",
        result: {
          candidates_scanned: summary.candidatesScanned,
          in_window: summary.inWindow,
          dispatched: summary.dispatched,
          auto_resolved: summary.autoResolved,
          skipped_not_due: summary.skippedNotDue,
          skipped_outside_window: summary.skippedOutsideWindow,
          skipped_no_channel: summary.skippedNoChannel,
          skipped_repeat_held: summary.skippedRepeatHeld,
          failed: summary.failed,
        },
      });
      // `failed` counts per-reminder dispatch failures the tick isolated. The
      // sweep itself ran, so those ride out as a count rather than failing the
      // job and retrying the whole cohort over one user's channel.
      return jobDone({
        candidates_scanned: summary.candidatesScanned,
        in_window: summary.inWindow,
        dispatched: summary.dispatched,
        auto_resolved: summary.autoResolved,
        skipped_not_due: summary.skippedNotDue,
        skipped_outside_window: summary.skippedOutsideWindow,
        skipped_no_channel: summary.skippedNoChannel,
        failed: summary.failed,
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * v1.18.1 — eventful Vorsorge satisfaction. Enqueued by every measurement
 * / lab ingest path (manual create, batch, device syncs) so a reminder
 * auto-resolves the moment a matching reading lands rather than waiting up
 * to 15 minutes for the cron. Batches one job per user; the resolver loads
 * that user's live reminders and runs the shared satisfy primitive.
 */
export async function handleReminderSatisfy(
  jobs: Job<ReminderSatisfyPayload>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.reminder_satisfy", async (evt) => {
    const prisma = getWorkerPrisma();
    const now = new Date();
    // Distinct users in this batch — a multi-source ingest spike can enqueue
    // several jobs for one user; resolve each user once.
    const userIds = Array.from(
      new Set(
        jobs.map((j) => j.data?.userId).filter((id): id is string => !!id),
      ),
    );
    let satisfied = 0;
    let candidates = 0;
    try {
      for (const userId of userIds) {
        const summary = await runReminderSatisfyForUser(prisma, userId, now);
        satisfied += summary.satisfied;
        candidates += summary.candidatesScanned;
      }
      evt.setBackground({
        task_name: "job.reminder_satisfy",
        result: {
          users: userIds.length,
          candidates_scanned: candidates,
          satisfied,
        },
      });
      // A batch whose jobs carried no usable userId resolved nothing and is
      // still a success with zero counts.
      return jobDone({
        users: userIds.length,
        candidates_scanned: candidates,
        satisfied,
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}
