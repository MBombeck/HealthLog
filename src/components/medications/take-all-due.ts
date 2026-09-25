/**
 * v1.16.11 (#316) — "take all due at once": the due-set derivation plus
 * the confirm-time orchestration behind the medications-page header
 * button. A user with several medications due in the current window
 * confirms them in ONE action instead of per-card taps.
 *
 * Due-set derivation reuses the EXACT pipeline a single card runs —
 * `reduceCurrentWindowStatus` (band model + server display-due gate +
 * taken-early downgrade) and `resolveDisplayedSlotInstant` (the canonical
 * slot the card's own "Genommen" button would record) — so the set the
 * dialog lists is, by construction, the set of cards currently showing a
 * take-now / overdue pill. No new endpoint: every input rides on the
 * `GET /api/medications` list payload the page already holds.
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
 * the derivation above cannot put a resolved dose in the set: an event with
 * a `takenAt` closes its window status, and `takenEarlyDaysAgo` drops the
 * day-scale case ahead of it. Every entry it sends is `skipped: false` on a
 * slot still in play, which is the same request the card's own button makes.
 */

import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiPost } from "@/lib/api/api-fetch";
import { intakeToastOptions } from "@/components/medications/use-medication-intake";
import { invalidateMedicationReads } from "@/lib/query-keys";
import {
  reduceCurrentWindowStatus,
  type ScheduleWindowInput,
} from "@/lib/medications/window-status";
import { resolveDisplayedSlotInstant } from "@/components/medications/card-parts/displayed-slot-instant";
import type { DoseStatus } from "@/lib/analytics/compliance";

type Translator = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/** Schedule shape the derivation needs — the list payload is a superset. */
export interface DueDerivationSchedule extends ScheduleWindowInput {
  dose: string | null;
}

/** Medication shape the derivation needs — the list payload is a superset. */
export interface DueDerivationMedication {
  id: string;
  name: string;
  dose: string;
  active: boolean;
  pausedAt: string | null;
  lastTakenAt: string | null;
  todayEventCount?: number | null;
  /** Server display-due verdict from `GET /api/medications`. */
  nextDueAt?: string | null;
  nextDueOverdue?: boolean;
  /** v1.16.11 (#316) — as-needed (PRN): never due, never in the set. */
  asNeeded?: boolean;
  /** v1.39.1 (#1033) — false: kept as a record, never due, never in the set. */
  trackIntake?: boolean;
  schedules: DueDerivationSchedule[];
}

/** One medication the confirm dialog lists and the take loop records. */
export interface DueMedication {
  id: string;
  name: string;
  /** Matched schedule dose, falling back to the medication-level dose. */
  dose: string;
  /** HH:mm bounds of the matched dose band, for the dialog's window line. */
  window: { start: string; end: string } | null;
  /**
   * Canonical slot instant the take records (threaded as `scheduledFor`,
   * exactly like the card's own button). Null preserves the PRN /
   * unscheduled now-snap path.
   */
  scheduledFor: Date | null;
}

const DEFAULT_THRESHOLDS = { lateMinutes: 120, missedMinutes: 240 };

/**
 * Derive the medications that are due RIGHT NOW — active, unpaused, with
 * a non-null current-window status (in_window / late / very_late) that is
 * not the day-scale taken-early downgrade. Input order is preserved so
 * the dialog lists medications in the same order the page renders them.
 *
 * The due set ADDITIONALLY includes escalated medications: an active,
 * unpaused, non-as-needed medication whose batched compliance
 * `currentDose.status` (`doseStatusById`, the same
 * `useMedicationComplianceSummaryAll` rows the page and the table hold)
 * is `overdue` / `missed`. A dose whose band + catch-up tail have closed
 * renders the red escalation value with an ACTIVE take button on its
 * card, so it must be takeable from the batch too — the window-only
 * derivation silently dropped it. The recorded slot for such an entry is
 * exactly what the card's own take button records: the SAME
 * `resolveDisplayedSlotInstant` call over the same (closed) window
 * status, which resolves to the server's `nextDueAt` instant (or null,
 * preserving the unscheduled now-snap path). Entries dedupe by
 * construction — the window branch and the escalation branch are
 * mutually exclusive per medication.
 */
export function deriveDueMedications(
  medications: DueDerivationMedication[],
  options: {
    now?: Date;
    /** IANA timezone (profile timezone; Berlin is the legacy fallback). */
    tz?: string;
    thresholds?: { lateMinutes: number; missedMinutes: number };
    /**
     * Batched compliance dose status per medication id (the page's
     * `useMedicationComplianceSummaryAll` rows). Absent / unknown ids
     * keep the window-only derivation — the legacy behaviour.
     */
    doseStatusById?: ReadonlyMap<string, DoseStatus>;
  } = {},
): DueMedication[] {
  const now = options.now ?? new Date();
  const tz = options.tz ?? "Europe/Berlin";
  const { lateMinutes, missedMinutes } =
    options.thresholds ?? DEFAULT_THRESHOLDS;

  const due: DueMedication[] = [];
  for (const m of medications) {
    // Paused courses keep their schedules but must never surface here —
    // the cards suppress their pills the same way. As-needed (PRN)
    // medications are never due, structurally — even a (bogus)
    // compliance row for one must not pull it into the set.
    // A medication with intake tracking off is never due either; the list
    // already serves it with no schedules, this makes the rule explicit.
    if (!m.active || m.pausedAt || m.asNeeded || m.trackIntake === false) {
      continue;
    }

    const nextDueMs = m.nextDueAt ? new Date(m.nextDueAt).getTime() : NaN;
    const status = reduceCurrentWindowStatus({
      schedules: m.schedules,
      now,
      lateMinutes,
      missedMinutes,
      active: m.active,
      lastTakenAt: m.lastTakenAt,
      todayEventCount: m.todayEventCount ?? 0,
      tz,
      // The same server display-due gate the cards apply: a future
      // (non-overdue) next-due suppresses the overdue tiers; `undefined`
      // (older mocks) keeps the legacy band-only behaviour.
      nextDue:
        m.nextDueAt === undefined
          ? undefined
          : Number.isFinite(nextDueMs)
            ? { at: new Date(nextDueMs), overdue: m.nextDueOverdue === true }
            : null,
    });
    // `takenEarlyDaysAgo` non-null = a day-scale dose already on board
    // earlier in its period; including it would build a double-dose
    // confirm list. The card suppresses every prompt tier (incl. the red
    // escalation value) the same way.
    if (status.takenEarlyDaysAgo !== null) continue;

    // Escalation alignment with the card: a compliance-derived
    // overdue / missed dose keeps an active take button on its card even
    // after the band's catch-up tail closed (window status null).
    const complianceStatus = options.doseStatusById?.get(m.id);
    const escalated =
      complianceStatus === "overdue" || complianceStatus === "missed";
    if (!status.status && !escalated) continue;

    due.push({
      id: m.id,
      name: m.name,
      dose: status.schedule?.dose ?? m.dose,
      window: status.window
        ? { start: status.window.start, end: status.window.end }
        : null,
      scheduledFor: resolveDisplayedSlotInstant({
        currentWindowStatus: status,
        nextDueAt: m.nextDueAt ?? null,
        now,
        timeZone: tz,
      }),
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
}): Promise<{ taken: number; failed: number }> {
  const { medications, t, queryClient, recordName } = deps;
  let taken = 0;
  let failed = 0;

  for (const med of medications) {
    try {
      await apiPost(
        `/api/medications/${med.id}/intake`,
        med.scheduledFor
          ? { skipped: false, scheduledFor: med.scheduledFor.toISOString() }
          : { skipped: false },
      );
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
    const options = intakeToastOptions({ recordName, eventId: undefined, t });
    const message = t("medications.takeAllDue.successToast", { count: taken });
    if (options) {
      toast.success(message, options);
    } else {
      toast.success(message);
    }
  } else if (taken > 0) {
    toast.error(t("medications.takeAllDue.partialToast", { taken, failed }));
  } else {
    toast.error(t("medications.takeAllDue.failedToast"));
  }

  return { taken, failed };
}
