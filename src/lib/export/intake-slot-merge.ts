/**
 * The slot rule of migration 0515 (`slot-merge.ts`) applied to a backup's
 * dose history: a file written before 0515 can hold two live rows for one
 * slot, which the live slot index refuses now. The restore brings the ones
 * the rule merges away back as tombstones (`medications-restore.ts`).
 */
import { partitionSlotDuplicates } from "@/lib/medications/scheduling/slot-merge";
import type { BackupPayload } from "@/lib/validations/backup";

type BackupIntakeEvent = BackupPayload["intakeEvents"][number];

/**
 * The intake events of a file the slot rule (`slot-merge.ts`) merges away:
 * every live row but one per medication and slot.
 */
export function mergedIntakeEvents(
  events: readonly BackupIntakeEvent[],
  medicationFor: (e: BackupIntakeEvent) => string | undefined,
): Set<BackupIntakeEvent> {
  const { merged } = partitionSlotDuplicates(
    events.map((event) => ({
      event,
      takenAt: event.takenAt ? new Date(event.takenAt) : null,
      skipped: event.skipped ?? false,
      createdAt: event.createdAt ? new Date(event.createdAt) : null,
      id: event.id ?? null,
    })),
    (r) =>
      `${medicationFor(r.event)}|${new Date(r.event.scheduledFor).getTime()}`,
    (r) => !r.event.deletedAt,
  );
  return new Set([...merged].map((r) => r.event));
}
