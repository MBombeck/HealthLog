/**
 * What follows a batch of lab readings landing, for the FHIR import paths:
 * the health score is recomputed, a "blood panel due" reminder is resolved
 * now rather than at the next cron, and the labs arm of the data-arrival
 * spine is told once, with the newest draw and the true inserted count (the
 * same three effects the scan commit runs). Nothing here throws.
 */
import { emitDataArrival } from "@/lib/arrivals/emit-shared";
import { invalidateUserHealthScore } from "@/lib/cache/invalidate";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import { fireAndForget } from "@/lib/logging/fire-and-forget";

export function afterLabReadingsWritten(input: {
  userId: string;
  inserted: number;
  newestTakenAt: Date | null;
  /** Transport token, for annotations only. */
  source: string;
}): void {
  if (input.inserted <= 0) return;
  invalidateUserHealthScore(input.userId);
  fireAndForget(() => enqueueReminderSatisfy(input.userId), {
    action: "reminder.satisfy.enqueue",
  });
  if (input.newestTakenAt) {
    void emitDataArrival({
      userId: input.userId,
      kind: "labs_panel",
      newestSampleAt: input.newestTakenAt,
      insertedCount: input.inserted,
      source: input.source,
    }).catch(() => {});
  }
}
