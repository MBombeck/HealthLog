"use client";

import { useActiveRecordName } from "@/hooks/use-record-capabilities";
import { useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors/error-toast";

import { useTranslations } from "@/lib/i18n/context";
import { invalidateMedicationReads } from "@/lib/query-keys";
import { apiDelete, apiPost } from "@/lib/api/api-fetch";

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
        label: t("medications.intakeUndo"),
        onClick: () => onUndo(eventId),
      },
    };
  }
  return undefined;
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
  recordIntake: (skipped: boolean, scheduledFor?: Date | null) => Promise<void>;
  /** Reverse a just-recorded intake via the soft-delete route. */
  undoIntake: (eventId: string) => Promise<void>;
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
   * v1.12.3 — slot instant of the dose the card is showing. Threaded onto
   * the POST so the server marks the displayed dose deterministically
   * instead of snapping "now" to the nearest slot (a morning tap on a
   * 07:00 / 19:00 med no longer mis-records the 07:00 dose). `null` /
   * undefined keeps the legacy now-snap (unscheduled / PRN doses).
   */
  scheduledFor?: Date | null;
  t: Translator;
  queryClient: QueryClient;
  setIntakeLoading: (value: string | null) => void;
  undoIntake: (eventId: string) => void | Promise<void>;
  onRecorded?: (eventId: string | undefined, skipped: boolean) => void;
  /**
   * v1.36.x — the record this dose was written into, when it is not the
   * caller's own. Two consequences: the toast names it, and the Undo action
   * goes. A delegate may record a dose and may not remove one, so an Undo
   * they can see is an Undo the server refuses.
   */
  recordName?: string | null;
}): Promise<void> {
  const {
    medication,
    skipped,
    scheduledFor,
    t,
    queryClient,
    setIntakeLoading,
    undoIntake,
    onRecorded,
    recordName,
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
    const created = await apiPost<{ id?: string } | undefined>(
      `/api/medications/${medication.id}/intake`,
      scheduledFor
        ? { skipped, scheduledFor: scheduledFor.toISOString() }
        : { skipped },
    );
    const eventId: string | undefined = created?.id;
    // v1.11.3 — the success toast carries an Undo action so a misclicked
    // take / skip no longer needs a history dive to correct.
    toast.success(
      t(
        skipped
          ? "medications.intakeToastSkipped"
          : "medications.intakeToastTaken",
        { name: medication.name },
      ),
      intakeToastOptions({
        recordName,
        eventId,
        t,
        onUndo: (id) => void undoIntake(id),
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
  undoIntake?: (eventId: string) => void | Promise<void>;
  /** See {@link runRecordIntake}: names the record, and drops Undo. */
  recordName?: string | null;
}): Promise<boolean> {
  const {
    medication,
    skipped,
    takenAt,
    scheduledFor,
    doseTaken,
    t,
    queryClient,
    undoIntake,
    recordName,
  } = deps;
  try {
    const body: Record<string, unknown> = { skipped };
    if (!skipped) body.takenAt = takenAt;
    if (scheduledFor) body.scheduledFor = scheduledFor;
    if (!skipped && doseTaken) body.doseTaken = doseTaken;
    // v1.30.1 — the route returns the created event
    // (`apiSuccess(event, 201)`, same as the card's `runRecordIntake`);
    // its id drives the Undo action below.
    const created = await apiPost<{ id?: string } | undefined>(
      `/api/medications/${medication.id}/intake`,
      body,
    );
    const eventId = created?.id;
    // Started, not awaited: the dialog closes on this answer. A scheduled
    // dose lands on its slot, so a stale card tapped meanwhile only repeats
    // it.
    void invalidateMedicationReads(queryClient);
    const message = t(
      skipped
        ? "medications.intakeToastSkipped"
        : "medications.intakeToastTaken",
      { name: medication.name },
    );
    // v1.30.1 — only pass a second `toast.success` argument when there's
    // a real Undo action to attach; keeps the no-undo call signature
    // identical to the pre-fix behaviour (existing unit tests assert the
    // single-argument call).
    const options = intakeToastOptions({
      recordName,
      eventId,
      t,
      onUndo: undoIntake ? (id) => void undoIntake(id) : undefined,
    });
    if (options) {
      toast.success(message, options);
    } else {
      toast.success(message);
    }
    return true;
  } catch (failure) {
    showErrorToast(
      t("medications.intakeToastFailed", { name: medication.name }),
      { cause: failure },
    );
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
  t: Translator;
  queryClient: QueryClient;
}): Promise<void> {
  const { medication, eventId, t, queryClient } = deps;
  try {
    await apiDelete(`/api/medications/${medication.id}/intake/${eventId}`);
    await invalidateMedicationReads(queryClient);
    toast.success(t("medications.intakeUndone"));
  } catch (failure) {
    showErrorToast(t("medications.intakeUndoFailed"), { cause: failure });
  }
}

export function useMedicationIntake({
  medication,
  onRecorded,
}: UseMedicationIntakeParams): UseMedicationIntakeResult {
  const queryClient = useQueryClient();
  const { t } = useTranslations();
  const recordName = useActiveRecordName();
  const [intakeLoading, setIntakeLoading] = useState<string | null>(null);

  const undoIntake = (eventId: string) =>
    runUndoIntake({ medication, eventId, t, queryClient });

  const recordIntake = (skipped: boolean, scheduledFor?: Date | null) =>
    runRecordIntake({
      medication,
      skipped,
      scheduledFor,
      t,
      queryClient,
      setIntakeLoading,
      undoIntake,
      onRecorded,
      recordName,
    });

  return { intakeLoading, recordIntake, undoIntake };
}
