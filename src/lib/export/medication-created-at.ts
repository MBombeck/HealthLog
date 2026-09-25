/**
 * The creation date a restored medication gets when the file does not say.
 *
 * Portable files written before v1.39.1 carry no `createdAt` for a
 * medication, and the restore used to let the column default to the moment
 * of the restore. The dose history reads that date as the day the
 * medication began to exist: `reconstructDoseHistory` and migration 0350
 * treat every slot before it as belonging to no medication, so the misses in
 * the day before the restore (and everything earlier) disappeared from the
 * record.
 *
 * The earliest thing the file itself says happened to the medication is the
 * closest honest stand-in: its first recorded dose (scheduled, taken or
 * written), the start of its first schedule revision, its course start, its
 * first pause, dose change or side effect. Never later than the restore:
 * a course that starts next week was still created by now.
 */
import type { BackupPayload } from "@/lib/validations/backup";

type BackupMedication = BackupPayload["medications"][number];
type BackupIntakeEvent = BackupPayload["intakeEvents"][number];

/**
 * The file's own creation date when it has one; otherwise the earliest
 * evidence, capped at `now`; otherwise `undefined`, which leaves the column
 * to its default (the restore time) because the file says nothing at all.
 */
export function restoredMedicationCreatedAt(
  medication: BackupMedication,
  intakeEvents: readonly BackupIntakeEvent[],
  now: Date,
): Date | undefined {
  if (medication.createdAt) return new Date(medication.createdAt);

  const instants: Array<string | null | undefined> = [];
  for (const event of intakeEvents) {
    // Mirrors how the restore attaches an event: by id when the file names
    // one, by name otherwise.
    const belongs = event.medicationId
      ? event.medicationId === medication.id ||
        (!medication.id && event.medication === medication.name)
      : event.medication === medication.name;
    if (!belongs) continue;
    instants.push(event.scheduledFor, event.takenAt, event.createdAt);
  }
  for (const revision of medication.scheduleRevisions) {
    instants.push(revision.validFrom);
  }
  instants.push(medication.startsOn);
  for (const era of medication.pauseEras) instants.push(era.pausedAt);
  for (const change of medication.doseChanges) {
    instants.push(change.effectiveFrom);
  }
  for (const effect of medication.sideEffects) instants.push(effect.occurredAt);

  let earliest = Number.POSITIVE_INFINITY;
  for (const instant of instants) {
    if (!instant) continue;
    const ms = Date.parse(instant);
    if (Number.isFinite(ms) && ms < earliest) earliest = ms;
  }
  if (!Number.isFinite(earliest)) return undefined;
  return new Date(Math.min(earliest, now.getTime()));
}
