/**
 * What every write that changes what a device shows as due does once it
 * has committed: tell the owner's devices.
 *
 * Two kinds of change reach here:
 *
 * - `intakes`: an intake row changed state. A take, a skip, a snooze, an
 *   undo, a delete, an edit of the time or the slot, an import, the
 *   auto-take and auto-miss passes.
 * - `medication`: the medication itself changed what is due. A schedule
 *   edit, a pause or resume, a course end or restart, intake tracking on or
 *   off, a new, deleted or restored medication.
 *
 * Both send the silent intake sync (`MEDICATION_INTAKE_SYNC`) at once to
 * every other device of the account and, for a managed profile, to its
 * Guardians' devices (`notifications/medication-intake-sync.ts`). Both also
 * add `intakes` to the devices' `DATA_CHANGED` domains, a medication change
 * `medications` as well, which goes out by that wake's own five-minute
 * window and within the silent budget (`push-relay/data-changed.ts`). The
 * device the request came from (`X-Device-Id`) is left out of both.
 *
 * Before it tells anyone it evicts the record's medication caches: a device
 * woken by the push reads within a second, and must not be answered from a
 * cell that predates the write. Most writers evict on their own; the seam
 * does it for all of them, so a writer that only marks the cells stale (the
 * automatic passes) or forgets (a snooze, a course change) cannot hand a
 * freshly woken device the old state.
 *
 * The one seam: `src/__tests__/intake-write-sync-push-guard.test.ts` holds
 * every intake and medication writer to calling it, or to a stated reason.
 * Synchronous and non-throwing; nothing here can fail the write.
 */
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import {
  queueMedicationIntakeSync,
  type IntakeSyncRequest,
} from "@/lib/notifications/medication-intake-sync";
import {
  noteDataChanged,
  type DataDomain,
} from "@/lib/push-relay/data-changed";

export interface DoseChange extends IntakeSyncRequest {
  /** What changed: intake rows, or the medication itself. */
  scope: "intakes" | "medication";
}

export function afterDoseChange(change: DoseChange): void {
  const { scope, ...sync } = change;
  invalidateUserMedications(change.userId, { evict: true });
  queueMedicationIntakeSync(sync);
  const domains: DataDomain[] =
    scope === "medication" ? ["intakes", "medications"] : ["intakes"];
  void noteDataChanged(
    change.userId,
    domains,
    change.originDeviceToken !== undefined
      ? { originDeviceToken: change.originDeviceToken }
      : {},
  ).catch(() => undefined);
}

/**
 * A medication-level write committed: evict the record's medication caches
 * and tell the devices (`scope: "medication"`). The caller passes the
 * request's `X-Device-Id` when it has one.
 */
export function afterMedicationChange(
  userId: string,
  originDeviceToken?: string | null,
): void {
  afterDoseChange({
    userId,
    scope: "medication",
    ...(originDeviceToken !== undefined ? { originDeviceToken } : {}),
  });
}
