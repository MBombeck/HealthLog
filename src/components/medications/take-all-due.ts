/**
 * v1.16.11 (#316) — "take all due at once": the due-set derivation plus
 * the confirm-time orchestration behind the medications-page header
 * button. A user with several medications due in the current window
 * confirms them in ONE action instead of per-card taps.
 *
 * Due-set derivation reads the SAME server-resolved open dose a single card
 * reads (`complianceDisplay.currentDose`, through `dose-state/pill.ts`), and
 * records the slot the card's own take button would record
 * (`cardDisplayedSlot`), so the set the dialog lists is, by construction,
 * the set of cards currently showing a due / overdue / missed state. No new
 * endpoint: the list payload and the batched compliance rows the page
 * already holds carry every input.
 *
 * Recording loops the per-medication `POST /api/medications/{id}/intake`
 * (the same call `runRecordIntake` makes for one card) rather than the
 * `POST /api/medications/intake/bulk` endpoint, deliberately:
 *
 *   - The bulk route is the iOS SyncMode surface: its taken path requires
 *     an explicit `takenAt` and attributes by band membership
 *     (`resolveSlotForWriteByBand`) or a `forceSlotInstant` user pin. The
 *     interactive card semantics instead send the DISPLAYED slot as
 *     `scheduledFor` and let the server stamp `takenAt = now` — for an
 *     overdue slot whose catch-up tail extends past the band, the two
 *     attributions can diverge. Looping the single route keeps slot
 *     attribution, inventory consumption (`consumedTransition` gate) and
 *     the canonical-slot upsert idempotency byte-identical to N
 *     individual taps.
 *   - Per-medication failure isolation falls out naturally: each POST
 *     succeeds or fails alone, the summary toast reports both counts, and
 *     the failed medications simply stay due (the invalidation refetch
 *     re-derives them into the set).
 *
 * The due set is small (a handful of medications, never the 500-entry
 * sync scale), so N sequential round trips are negligible.
 *
 * v1.36.x — a delegate may drive this, and the loop cannot half-apply on
 * them. The two refusals v1.36.1 added for a delegate — snoozing, and
 * changing an event the owner already resolved — live on
 * `POST /api/medications/intake`, the account-wide slot route, which this
 * loop does not call. The route it does call has no snooze arm at all, and
 * the derivation above cannot put a resolved dose in the set: the server's
 * open dose is never a slot that already holds a take or a skip. Every entry it sends is `skipped: false` on a
 * slot still in play, which is the same request the card's own button makes.
 */

import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors/error-toast";

import { apiDelete, apiPost } from "@/lib/api/api-fetch";
import { intakeToastOptions } from "@/components/medications/use-medication-intake";
import { intakeRemovedMessage } from "@/components/medications/intake-dose-label";
import { invalidateMedicationReads } from "@/lib/query-keys";
import {
  cardDisplayedSlot,
  cardWindowPill,
  liveDoseState,
  type ResolvedDoseWire,
} from "@/lib/medications/dose-state/pill";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { wallClockInTz } from "@/lib/tz/wall-clock";

type Translator = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/** Schedule shape the derivation needs — the list payload is a superset. */
export interface DueDerivationSchedule {
  windowStart: string;
  timesOfDay?: string[];
  dose: string | null;
}

/** Medication shape the derivation needs — the list payload is a superset. */
export interface DueDerivationMedication {
  id: string;
  name: string;
  dose: string;
  /** #1371 — the person's own note; null or absent = none. */
  note?: string | null;
  active: boolean;
  pausedAt: string | null;
  /** Server display-due slot from `GET /api/medications`. */
  nextDueAt?: string | null;
  /** v1.16.11 (#316) — as-needed (PRN): never due, never in the set. */
  asNeeded?: boolean;
  /** v1.39.1 (#1033) — false: kept as a record, never due, never in the set. */
  trackIntake?: boolean;
  /** v1.39.4 (#1040) — false: no dose actions today (e.g. the course ended). */
  intakeActionable?: boolean;
  schedules: DueDerivationSchedule[];
}

/** One medication the confirm dialog lists and the take loop records. */
export interface DueMedication {
  id: string;
  name: string;
  /** Matched schedule dose, falling back to the medication-level dose. */
  dose: string;
  /** #1371 — the person's own note, listed under the name; null = none. */
  note?: string | null;
  /** HH:mm bounds of the matched dose band, for the dialog's window line. */
  window: { start: string; end: string } | null;
  /**
   * Canonical slot instant the take records (threaded as `scheduledFor`,
   * exactly like the card's own button). Null preserves the PRN /
   * unscheduled now-snap path.
   */
  scheduledFor: Date | null;
}

/** The dose of the schedule whose dose time is the slot's, if any. */
function slotDose(
  schedules: DueDerivationSchedule[],
  slot: Date | null,
  tz: string,
): string | null {
  if (!slot) return null;
  const p = wallClockInTz(slot, tz);
  const hm = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  const match = schedules.find((s) =>
    s.timesOfDay && s.timesOfDay.length > 0
      ? s.timesOfDay.includes(hm)
      : s.windowStart === hm,
  );
  return match?.dose ?? null;
}

/**
 * Derive the medications that are due RIGHT NOW: active, unpaused, tracked,
 * with a server-resolved open dose (`currentDoseById`, the page's batched
 * `useMedicationComplianceSummaryAll` rows) that is due, overdue, or missed
 * (a missed dose keeps an active take button on its card: a late take still
 * counts). Input order is preserved so the dialog lists medications in the
 * order the page renders them. A medication whose compliance row has not
 * loaded yet is not in the set, exactly as its card shows no state yet.
 */
export function deriveDueMedications(
  medications: DueDerivationMedication[],
  options: {
    now?: Date;
    /** IANA timezone (profile timezone; Berlin is the legacy fallback). */
    tz?: string;
    /** The resolved open dose per medication id (`currentDose`). */
    currentDoseById?: ReadonlyMap<string, ResolvedDoseWire>;
  } = {},
): DueMedication[] {
  const now = options.now ?? new Date();
  const tz = options.tz ?? DEFAULT_TIMEZONE;

  const due: DueMedication[] = [];
  for (const m of medications) {
    // Paused courses keep their schedules but must never surface here —
    // the cards suppress their state the same way. As-needed (PRN)
    // medications are never due, structurally — even a (bogus)
    // compliance row for one must not pull it into the set. A medication
    // with intake tracking off is never due either.
    if (
      !m.active ||
      m.pausedAt ||
      m.asNeeded ||
      m.trackIntake === false ||
      m.intakeActionable === false
    ) {
      continue;
    }
    const dose = options.currentDoseById?.get(m.id);
    const state = liveDoseState(dose, now);
    if (state !== "due" && state !== "overdue" && state !== "missed") {
      continue;
    }
    const pill = cardWindowPill(dose, now, tz);
    const scheduledFor = cardDisplayedSlot(dose, m.nextDueAt ?? null, now);
    due.push({
      id: m.id,
      name: m.name,
      dose: slotDose(m.schedules, scheduledFor, tz) ?? m.dose,
      note: m.note ?? null,
      window: pill ? { start: pill.windowStart, end: pill.windowEnd } : null,
      scheduledFor,
    });
  }
  return due;
}

/**
 * Record every due medication through the per-medication intake route,
 * sequentially, with per-medication failure isolation (see the module doc
 * for the loop-vs-bulk decision). Dependencies are injected so this is
 * unit-testable without a React render, mirroring `runRecordIntake`.
 *
 * Toast contract: all-success → one success summary; partial → an error
 * summary carrying both counts ("3 erfasst, 1 fehlgeschlagen"); all-fail
 * → a plain failure prompt. Failed medications stay due — the dependent-
 * key invalidation refetches the list and the derivation re-surfaces
 * them. The optional per-card injection-site follow-up prompt is
 * intentionally NOT part of the batch confirm (it is skippable on the
 * single path too); the site stays editable from the intake history.
 */
export async function runTakeAllDue(deps: {
  medications: DueMedication[];
  t: Translator;
  queryClient: QueryClient;
  /**
   * v1.36.x — the record the batch lands in, when it is not the caller's own.
   * The sweep is a delegated write now, so its summary carries the same
   * receipt every single-dose confirmation does: a helper who confirms four
   * tablets is told whose four they were. It offers no Undo, so the helper's
   * other half is a no-op here.
   */
  recordName?: string | null;
  /** The reader's clock, which the Undo's toast names a dose with. */
  formatTime: (at: Date) => string;
}): Promise<{ taken: number; failed: number }> {
  const { medications, t, queryClient, recordName, formatTime } = deps;
  let taken = 0;
  let failed = 0;
  // The rows this sweep wrote, for its one Undo (a slot that already held a
  // take wrote nothing and is not undone).
  const written: WrittenTake[] = [];

  for (const med of medications) {
    try {
      const created = await apiPost<
        | {
            id?: string;
            syncVersion?: number;
            alreadyTaken?: boolean;
            takenAt?: string | null;
            scheduledFor?: string | null;
          }
        | undefined
      >(
        `/api/medications/${med.id}/intake`,
        med.scheduledFor
          ? { skipped: false, scheduledFor: med.scheduledFor.toISOString() }
          : { skipped: false },
      );
      if (created?.id && !created.alreadyTaken) {
        written.push({
          medicationId: med.id,
          id: created.id,
          syncVersion: created.syncVersion,
          slotAt: created.scheduledFor ?? med.scheduledFor ?? null,
          takenAt: created.takenAt ?? null,
        });
      }
      taken += 1;
    } catch {
      failed += 1;
    }
  }

  // One invalidation for the whole batch through the blessed helper: it
  // fans out the dependent-key bundle AND forces the inactive digest +
  // snapshot to refetch. The batch button lives on `/medications`, where the
  // Today hero and dashboard are UNMOUNTED, so a bare bundle invalidation
  // (default `refetchType: "active"`) marked them stale but never refetched —
  // the taken doses stayed "due" on the hero until the 120 s poll or a hard
  // reload (the maintainer's exact repro, v1.32.19). A zero-success run
  // changed nothing server-side — skip the refetch and keep the due set for
  // the retry.
  if (taken > 0) {
    await invalidateMedicationReads(queryClient);
  }

  if (failed === 0) {
    // One Undo for the whole sweep, like a single take's; the shared helper
    // still decides (inside somebody else's record it names the record and
    // offers no Undo, which a delegate could not use).
    const options = intakeToastOptions({
      recordName,
      eventId: written.length > 0 ? written[0].id : undefined,
      t,
      onUndo: () =>
        void undoTakeAllDue({ written, t, queryClient, formatTime }),
    });
    const message = t("medications.takeAllDue.successToast", { count: taken });
    if (options) {
      toast.success(message, options);
    } else {
      toast.success(message);
    }
  } else if (taken > 0) {
    showErrorToast(t("medications.takeAllDue.partialToast", { taken, failed }));
  } else {
    showErrorToast(t("medications.takeAllDue.failedToast"));
  }

  return { taken, failed };
}

/** A take the sweep wrote, enough to remove it and to name it. */
interface WrittenTake {
  medicationId: string;
  id: string;
  syncVersion?: number;
  slotAt: string | Date | null;
  takenAt: string | null;
}

/**
 * Reverse a sweep: remove each row it wrote, then one confirmation, which
 * names the dose when there was one and counts them otherwise.
 */
async function undoTakeAllDue(input: {
  written: WrittenTake[];
  t: Translator;
  queryClient: QueryClient;
  formatTime: (at: Date) => string;
}): Promise<void> {
  const { written, t, queryClient, formatTime } = input;
  let failed = 0;
  for (const row of written) {
    const query =
      row.syncVersion !== undefined
        ? `?expectedSyncVersion=${row.syncVersion}`
        : "";
    try {
      await apiDelete(
        `/api/medications/${row.medicationId}/intake/${row.id}${query}`,
      );
    } catch {
      failed += 1;
    }
  }
  await invalidateMedicationReads(queryClient);
  if (failed > 0) {
    showErrorToast(t("medications.intakeUndoFailed"));
  } else {
    toast.success(
      written.length === 1
        ? intakeRemovedMessage(
            {
              slotAt: written[0].slotAt,
              takenAt: written[0].takenAt ?? new Date(),
              skipped: false,
            },
            { t, formatTime },
          )
        : t("medications.dose.removedMany", { count: written.length }),
    );
  }
}
