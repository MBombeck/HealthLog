"use client";

import { useActiveRecordName } from "@/hooks/use-record-capabilities";
import { useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors/error-toast";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { invalidateMedicationReads } from "@/lib/query-keys";
import { apiDelete, apiPost } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import type { TakeSlot } from "@/lib/medications/dose-state/pill";
import { takeFields } from "@/lib/medications/dose-state/take-rule";
import {
  intakeRemovedMessage,
  intakeRestoredMessage,
  type IntakeDose,
} from "@/components/medications/intake-dose-label";

/**
 * Every intake write in this hook clears the Today hero + dashboard through
 * the one blessed `invalidateMedicationReads` (in `@/lib/query-keys`): it
 * pairs the `medicationDependentKeys` bundle invalidation with a forced
 * inactive refetch of the digest + snapshot, so a taken / skipped / undone
 * dose repaints the moment it lands rather than on the 120 s poll. The helper
 * used to live inline here (v1.29.1); v1.32.19 lifted it into the factory as
 * the single canonical entry point every intake surface routes through.
 */

type Translator = (
  key: string,
  params?: Record<string, string | number>,
) => string;

interface MedicationIntakeIdentity {
  id: string;
  name: string;
}

/**
 * What rides alongside a successful intake toast — and the one place that
 * decides it.
 *
 * Three surfaces record a dose: the medication cards through
 * {@link runRecordIntake}, the log-intake dialog through {@link runLogIntake},
 * and the dose-history ledger, which builds its own POST because it also has
 * an optimistic cache patch to make. All three showed the same success toast
 * and all three had to reach the same two conclusions:
 *
 *   - inside somebody else's record, name the record. "Saved" alone is the one
 *     confirmation a person acting for somebody else does not need.
 *   - and drop Undo there. A delegate may record a dose and may not remove
 *     one, so an Undo they can see is an Undo the server refuses.
 *
 * Two of the three learned that; the ledger did not, which is a delegate
 * meeting a dead Undo on every dose they mark. Three copies of one ternary is
 * how that happens, so there is one now.
 */
export function intakeToastOptions(input: {
  /** The record the dose landed in, or null in the caller's own. */
  recordName: string | null | undefined;
  /** The created event, when the POST returned one. */
  eventId: string | undefined;
  t: Translator;
  /** Reverse the write. Omitted where the caller offers no undo at all. */
  onUndo?: (eventId: string) => void;
}):
  | { description: string }
  | { action: { label: string; onClick: () => void } }
  | undefined {
  const { recordName, eventId, t, onUndo } = input;
  if (recordName) {
    return {
      description: t("recordSharing.toast.savedTo", { name: recordName }),
    };
  }
  if (eventId && onUndo) {
    return {
      action: {
        label: t("medications.dose.action.undo"),
        onClick: () => onUndo(eventId),
      },
    };
  }
  return undefined;
}

/**
 * The one confirmation of a recorded dose, on every surface: "{name}: taken,
 * 08:12" or "{name}: skipped". With `countedFor` it names the dose the take
 * was counted for ("taken, 11:59, for the 07:00 PM dose"), and with
 * `extra` it says the take was filed as an extra dose: a control that named
 * a slot never confirms a take the server did not count for it.
 */
export function intakeToastMessage(input: {
  t: Translator;
  name: string;
  skipped: boolean;
  takenAt: Date;
  formatTime: (at: Date) => string;
  countedFor?: Date | null;
  extra?: boolean;
}): string {
  if (input.skipped) {
    return input.t("medications.intakeToastSkipped", { name: input.name });
  }
  const time = input.formatTime(input.takenAt);
  if (input.extra) {
    return input.t("medications.intakeToastExtra", { name: input.name, time });
  }
  if (input.countedFor) {
    return input.t("medications.intakeToastTakenFor", {
      name: input.name,
      time,
      slot: input.formatTime(input.countedFor),
    });
  }
  return input.t("medications.intakeToastTaken", { name: input.name, time });
}

/** Within a minute, the slot the server filed a take under is the named one. */
const SAME_SLOT_MS = 60_000;

/**
 * The POST body of a card take or skip. A skip names its slot; a take binds
 * by the one take rule the card computed (`cardTakeSlot`): `scheduledFor`
 * through the band, `forceSlotInstant` for a pinned take, `extraDose` for
 * an extra dose.
 */
export function cardIntakeBody(
  skipped: boolean,
  slot: TakeSlot | null | undefined,
): Record<string, unknown> {
  if (!slot) return { skipped };
  return skipped
    ? { skipped, scheduledFor: slot.at.toISOString() }
    : { skipped, ...takeFields(slot.binding, slot.at) };
}

/**
 * v1.12.2 — the take / skip + Undo intake orchestration shared by the
 * generic {@link MedicationCard} and the {@link Glp1MedicationCard}.
 *
 * Both cards used to inline their own `recordIntake`, and the two copies
 * drifted: the generic card gained the v1.11.3 failure-toast (C1) and the
 * Undo action (C2) while the GLP-1 card silently swallowed a failed POST
 * and offered no Undo — same "Taken" button, two behaviours. Lifting the
 * logic here makes the two cards behave identically by construction.
 *
 * The hook owns: the in-flight loading key, the intake POST, the failure
 * toast, the success toast carrying an Undo action, the soft-delete undo
 * route, and the dependent-key invalidation. Each card keeps its own
 * post-success hook (`onRecorded`) for card-specific follow-ups — today
 * the optional injection-site prompt.
 */
interface UseMedicationIntakeParams {
  medication: MedicationIntakeIdentity;
  /**
   * Card-specific follow-up after a successful record. Receives the
   * created event's id (when the POST body carried one) and whether the
   * dose was skipped. Used by the cards to open the injection-site prompt
   * on a taken dose. The intake itself is already recorded + invalidated
   * by the time this fires.
   */
  onRecorded?: (eventId: string | undefined, skipped: boolean) => void;
}

interface UseMedicationIntakeResult {
  /** "take" | "skip" while the matching request is in flight, else null. */
  intakeLoading: string | null;
  /**
   * Record a take (skipped=false) or skip (skipped=true). The optional
   * `scheduledFor` is the slot instant of the dose the card is displaying;
   * when supplied the server marks THAT slot instead of snapping "now" to
   * the nearest one (v1.12.3). Omit it (or pass null) for an unscheduled /
   * PRN dose to keep the legacy now-snap path.
   */
  recordIntake: (skipped: boolean, slot?: TakeSlot | null) => Promise<void>;
  /** Reverse a just-recorded intake via the soft-delete route. */
  undoIntake: (
    eventId: string,
    dose: IntakeDose,
    expectedSyncVersion?: number,
  ) => Promise<void>;
}

/**
 * Pure orchestration for a single intake record, with every dependency
 * injected so it is unit-testable without a React render (the repo has no
 * `renderHook`; the convention is SSR markup + direct invocation). The
 * hook below is a thin wrapper that binds the real `fetch` / `toast` /
 * translator / query client.
 */
export async function runRecordIntake(deps: {
  medication: MedicationIntakeIdentity;
  skipped: boolean;
  /**
   * The dose the card is showing and how a take binds to it
   * (`cardTakeSlot`). Threaded onto the POST so the server marks THAT dose
   * instead of snapping "now" to the nearest slot. `null` / undefined keeps
   * the legacy now-snap (unscheduled / PRN doses).
   */
  slot?: TakeSlot | null;
  t: Translator;
  queryClient: QueryClient;
  setIntakeLoading: (value: string | null) => void;
  undoIntake: (
    eventId: string,
    dose: IntakeDose,
    expectedSyncVersion?: number,
  ) => void | Promise<void>;
  onRecorded?: (eventId: string | undefined, skipped: boolean) => void;
  /**
   * v1.36.x — the record this dose was written into, when it is not the
   * caller's own. Two consequences: the toast names it, and the Undo action
   * goes. A delegate may record a dose and may not remove one, so an Undo
   * they can see is an Undo the server refuses.
   */
  recordName?: string | null;
  /** The reader's clock for the toast ("Ramipril: taken, 08:12"). */
  formatTime: (at: Date) => string;
}): Promise<void> {
  const {
    medication,
    skipped,
    slot,
    t,
    queryClient,
    setIntakeLoading,
    undoIntake,
    onRecorded,
    recordName,
    formatTime,
  } = deps;

  setIntakeLoading(skipped ? "skip" : "take");
  try {
    // The route's Zod schema accepts an ISO `scheduledFor`; the server
    // snaps it to the canonical slot. Only send it when the card
    // identified the displayed dose's slot — otherwise omit so the
    // PRN / unscheduled now-snap path is preserved.
    //
    // v1.11.3 — a failed POST used to clear the spinner silently, so the
    // user believed the dose was logged when it was not. apiPost throws on
    // non-OK, so the catch below surfaces the failure and the success
    // confirmation never shows in that case.
    //
    // The POST returns the created event (`apiSuccess(event, 201)`); its id
    // drives both the Undo affordance and the card's post-success hook
    // (the optional injection-site prompt).
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
      `/api/medications/${medication.id}/intake`,
      cardIntakeBody(skipped, slot),
    );
    const eventId: string | undefined = created?.id;
    // The slot already held a take (another device, a pill box): nothing was
    // recorded, so there is nothing of this tap's own to undo.
    if (created?.alreadyTaken) {
      toast.info(
        t("medications.intakeAlreadyTaken", { name: medication.name }),
      );
      await invalidateMedicationReads(queryClient);
      return;
    }
    const seenVersion = created?.syncVersion;
    // v1.11.3 — the success toast carries an Undo action so a misclicked
    // take / skip no longer needs a history dive to correct.
    // Name what the server actually counted the take for: the slot the
    // card named, or an extra dose when it was filed outside the plan.
    const filedAt = created?.scheduledFor
      ? Date.parse(created.scheduledFor)
      : NaN;
    const counted =
      slot != null &&
      slot.binding !== "extra" &&
      Math.abs(filedAt - slot.at.getTime()) <= SAME_SLOT_MS;
    const takenAt = created?.takenAt ? new Date(created.takenAt) : new Date();
    // The dose the Undo names: the slot the server filed it under, else the
    // one the card named.
    const dose: IntakeDose = {
      slotAt: created?.scheduledFor ?? slot?.at ?? null,
      takenAt: skipped ? null : takenAt,
      skipped,
    };
    toast.success(
      intakeToastMessage({
        t,
        name: medication.name,
        skipped,
        takenAt,
        formatTime,
        countedFor: counted ? slot.at : null,
        extra: slot != null && !counted,
      }),
      intakeToastOptions({
        recordName,
        eventId,
        t,
        onUndo: (id) => void undoIntake(id, dose, seenVersion),
      }),
    );
    await invalidateMedicationReads(queryClient);
    onRecorded?.(eventId, skipped);
  } catch (failure) {
    showErrorToast(
      t("medications.intakeToastFailed", { name: medication.name }),
      { cause: failure },
    );
  } finally {
    setIntakeLoading(null);
  }
}

/**
 * v1.14.0 — pure orchestration for a manual, possibly BACKDATED intake
 * logged against an existing medication from the medications-page "Add"
 * choice (the "log an intake" branch). Mirrors {@link runRecordIntake}'s
 * dependency-injected shape so it is unit-testable without a React render.
 *
 * Backdating: the dialog carries a user-picked `takenAt` (local time
 * converted to ISO) which the per-medication intake route accepts with no
 * future/past restriction. When the user also names a schedule slot the
 * dialog supplies `scheduledFor` (the slot instant on the chosen day), so
 * the write routes through the server's canonical slot upsert — the same
 * snap/upsert path a normal "Taken" tap uses — preserving the
 * one-row-per-dose-slot medical invariant. With no slot the route follows
 * its unscheduled/PRN insert path.
 */
export async function runLogIntake(deps: {
  medication: MedicationIntakeIdentity;
  /** True logs a skipped slot; false records a taken dose. */
  skipped: boolean;
  /** ISO instant the dose was actually taken; ignored when skipped. */
  takenAt: string;
  /**
   * ISO slot instant on the chosen day when the user pinned a schedule
   * slot. Omit/undefined to route through the unscheduled/PRN path.
   */
  scheduledFor?: string;
  /**
   * The slot instant a take near, but outside, a slot's on-time window is
   * pinned to ("counts for the 08:00 dose, as late"). The server refuses an
   * instant that is no slot of the medication.
   */
  forceSlotInstant?: string;
  /** A take recorded as an extra dose outside the plan (`extraDose`). */
  extraDose?: true;
  /**
   * v1.16.4 — per-intake dose override. Sent only on a taken write; the
   * caller passes it only when the user's dose edit deviates from the
   * configured medication / schedule dose.
   */
  doseTaken?: string;
  t: Translator;
  queryClient: QueryClient;
  /**
   * v1.30.1 — reverse the just-logged intake. Optional so existing
   * unit tests that don't care about Undo can omit it; the toast simply
   * carries no action when it's absent.
   */
  undoIntake?: (eventId: string, dose: IntakeDose) => void | Promise<void>;
  /** See {@link runRecordIntake}: names the record, and drops Undo. */
  recordName?: string | null;
  /** The reader's clock for the toast. */
  formatTime: (at: Date) => string;
  /**
   * The POST, when the caller sends it its own way (the capture sheet's
   * idempotent post, which survives a retried tap).
   */
  post?: (url: string, body: Record<string, unknown>) => Promise<unknown>;
  /**
   * A form's own error line: when given, a failed write is reported here
   * (the sheet's inline alert) instead of a toast.
   */
  onFailure?: (message: string) => void;
}): Promise<boolean> {
  const {
    medication,
    skipped,
    takenAt,
    scheduledFor,
    forceSlotInstant,
    extraDose,
    doseTaken,
    t,
    queryClient,
    undoIntake,
    recordName,
    formatTime,
    post = (url, body) => apiPost(url, body),
    onFailure,
  } = deps;
  try {
    const body: Record<string, unknown> = { skipped };
    if (!skipped) body.takenAt = takenAt;
    if (scheduledFor) body.scheduledFor = scheduledFor;
    if (!skipped && forceSlotInstant) body.forceSlotInstant = forceSlotInstant;
    if (!skipped && extraDose) body.extraDose = true;
    if (!skipped && doseTaken) body.doseTaken = doseTaken;
    // v1.30.1 — the route returns the created event
    // (`apiSuccess(event, 201)`, same as the card's `runRecordIntake`);
    // its id drives the Undo action below.
    const created = (await post(
      `/api/medications/${medication.id}/intake`,
      body,
    )) as
      | { id?: string; alreadyTaken?: boolean; scheduledFor?: string | null }
      | undefined;
    const eventId = created?.id;
    // Started, not awaited: the dialog closes on this answer. A scheduled
    // dose lands on its slot, so a stale card tapped meanwhile only repeats
    // it.
    void invalidateMedicationReads(queryClient);
    // The slot already held a take: nothing of this entry was recorded.
    if (created?.alreadyTaken) {
      toast.info(
        t("medications.intakeAlreadyTaken", { name: medication.name }),
      );
      return true;
    }
    const message = intakeToastMessage({
      t,
      name: medication.name,
      skipped,
      takenAt: new Date(takenAt),
      formatTime,
      extra: !skipped && extraDose === true,
    });
    // v1.30.1 — only pass a second `toast.success` argument when there's
    // a real Undo action to attach; keeps the no-undo call signature
    // identical to the pre-fix behaviour (existing unit tests assert the
    // single-argument call).
    const options = intakeToastOptions({
      recordName,
      eventId,
      t,
      onUndo: undoIntake
        ? (id) =>
            void undoIntake(id, {
              // The slot the server filed it under, when it answered one.
              slotAt:
                created?.scheduledFor ??
                scheduledFor ??
                forceSlotInstant ??
                null,
              takenAt: skipped ? null : takenAt,
              skipped,
            })
        : undefined,
    });
    if (options) {
      toast.success(message, options);
    } else {
      toast.success(message);
    }
    return true;
  } catch (failure) {
    if (onFailure) {
      onFailure(
        localizedApiError(failure, t, "medications.intakeForm.saveError"),
      );
    } else {
      showErrorToast(
        t("medications.intakeToastFailed", { name: medication.name }),
        { cause: failure },
      );
    }
    return false;
  }
}

/**
 * Pure soft-delete undo for a just-recorded intake, dependencies injected
 * for the same testability reason as {@link runRecordIntake}.
 */
export async function runUndoIntake(deps: {
  medication: MedicationIntakeIdentity;
  eventId: string;
  /** The dose being undone, which the toast names. */
  dose: IntakeDose;
  /** The reader's clock for the toast. */
  formatTime: (at: Date) => string;
  /** The row version the take answered with; a newer one refuses the undo. */
  expectedSyncVersion?: number;
  t: Translator;
  queryClient: QueryClient;
}): Promise<void> {
  const { medication, eventId, dose, formatTime, t, queryClient } = deps;
  const query =
    deps.expectedSyncVersion !== undefined
      ? `?expectedSyncVersion=${deps.expectedSyncVersion}`
      : "";
  try {
    await apiDelete(
      `/api/medications/${medication.id}/intake/${eventId}${query}`,
    );
    await invalidateMedicationReads(queryClient);
    toast.success(intakeRemovedMessage(dose, { t, formatTime }));
  } catch (failure) {
    showErrorToast(t("medications.intakeUndoFailed"), { cause: failure });
  }
}

/**
 * The Undo a dialog hands {@link runLogIntake}: the soft delete of the dose
 * it just recorded, whose toast names that dose.
 */
export function logIntakeUndo(deps: {
  medication: MedicationIntakeIdentity;
  t: Translator;
  queryClient: QueryClient;
  /** The reader's formatters (`useFormatters()`). */
  fmt: { time: (at: Date) => string };
}): (eventId: string, dose: IntakeDose) => Promise<void> {
  const { medication, t, queryClient, fmt } = deps;
  return (eventId, dose) =>
    runUndoIntake({
      medication,
      eventId,
      dose,
      formatTime: (at) => fmt.time(at),
      t,
      queryClient,
    });
}

/** What a deleted intake recorded, enough to record it again. */
export interface DeletedIntakeSnapshot {
  id: string;
  takenAt: string | null;
  skipped: boolean;
  /** The slot the row belonged to (ISO), or null for an off-schedule take. */
  scheduledFor: string | null;
  /** The slot's own wall time (`HH:mm`), when the row shows one. */
  slotTime?: string | null;
  doseTaken?: string | null;
  autoMissed?: boolean;
}

/**
 * The intake POST that records a deleted dose again: the same take time,
 * the same slot, the same dose, through the ordinary write path (slot lock,
 * already-taken check, stock). Null for a row that recorded nothing a person
 * entered (an automatic "missed" placeholder), which an undo has no reason
 * to bring back.
 */
export function restoreIntakeBody(
  intake: DeletedIntakeSnapshot,
): Record<string, unknown> | null {
  if (intake.skipped) {
    return intake.scheduledFor
      ? { skipped: true, scheduledFor: intake.scheduledFor }
      : null;
  }
  if (!intake.takenAt) return null;
  return {
    skipped: false,
    takenAt: intake.takenAt,
    ...(intake.scheduledFor ? { scheduledFor: intake.scheduledFor } : {}),
    ...(intake.doseTaken ? { doseTaken: intake.doseTaken } : {}),
  };
}

/**
 * Delete one intake from the dose history, the way every other list in the
 * app deletes: at once, soft (the row stays, tombstoned), and with an Undo in
 * the toast that records the dose again. No confirmation dialog: the undo is
 * the safety net, and the old dialog claimed a permanent removal that never
 * happened.
 */
export async function runDeleteIntake(deps: {
  medicationId: string;
  intake: DeletedIntakeSnapshot;
  t: Translator;
  /** The reader's clocks, which the toasts name the dose with. */
  formatTime: (at: Date) => string;
  wallTime: (hhmm: string) => string;
  /** Refresh the reads after the delete and after an undo. */
  reconcile: () => Promise<void>;
}): Promise<void> {
  const { medicationId, intake, t, reconcile } = deps;
  const format = { t, formatTime: deps.formatTime, wallTime: deps.wallTime };
  const dose: IntakeDose = {
    slotAt: intake.scheduledFor,
    slotTime: intake.slotTime,
    takenAt: intake.takenAt,
    skipped: intake.skipped,
  };
  try {
    await apiDelete(`/api/medications/${medicationId}/intake/${intake.id}`);
  } catch (failure) {
    showErrorToast(t("medications.detail.intake.deleteRow.failed"), {
      cause: failure,
    });
    return;
  }
  await reconcile();
  const body = restoreIntakeBody(intake);
  toast.success(
    intakeRemovedMessage(dose, format),
    body
      ? {
          action: {
            label: t("medications.dose.action.undo"),
            onClick: () => {
              void (async () => {
                try {
                  await apiPost(
                    `/api/medications/${medicationId}/intake`,
                    body,
                  );
                  toast.success(intakeRestoredMessage(dose, format));
                } catch (failure) {
                  showErrorToast(t("medications.intakeUndoFailed"), {
                    cause: failure,
                  });
                }
                await reconcile();
              })();
            },
          },
        }
      : undefined,
  );
}

export function useMedicationIntake({
  medication,
  onRecorded,
}: UseMedicationIntakeParams): UseMedicationIntakeResult {
  const queryClient = useQueryClient();
  const { t } = useTranslations();
  const fmt = useFormatters();
  const recordName = useActiveRecordName();
  const [intakeLoading, setIntakeLoading] = useState<string | null>(null);

  const undoIntake = (
    eventId: string,
    dose: IntakeDose,
    expectedSyncVersion?: number,
  ) =>
    runUndoIntake({
      medication,
      eventId,
      dose,
      formatTime: (at) => fmt.time(at),
      expectedSyncVersion,
      t,
      queryClient,
    });

  const recordIntake = (skipped: boolean, slot?: TakeSlot | null) =>
    runRecordIntake({
      medication,
      skipped,
      slot,
      t,
      queryClient,
      setIntakeLoading,
      undoIntake,
      onRecorded,
      recordName,
      formatTime: (at) => fmt.time(at),
    });

  return { intakeLoading, recordIntake, undoIntake };
}
