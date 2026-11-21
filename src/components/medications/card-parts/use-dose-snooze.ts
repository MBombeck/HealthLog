"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiGet, apiPost } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { useSnoozeMinutes } from "@/lib/queries/use-snooze-minutes";
import { invalidateMedicationReads, queryKeys } from "@/lib/query-keys";
import { useActiveRecordName } from "@/hooks/use-record-capabilities";

/** The fields of a today row (`GET /api/medications/intake?scope=today`) read here. */
export interface TodayDoseRow {
  id: string;
  medicationId: string;
  status: "pending" | "taken" | "skipped" | "missed" | "snoozed";
  snoozedUntil: string | null;
  state: "upcoming" | "due" | "overdue" | "taken" | "skipped" | "missed" | null;
}

/**
 * The snooze of a medication card: "Remind me later (30 min)" while a dose of
 * the medication is due or overdue, and the snoozed state once it is held.
 * The row comes from the today list the app reads too, the length from the
 * person's one snooze setting, and the write is the app's own
 * (`POST /api/medications/intake`, status `snoozed`, no instant: the server
 * defers by that same setting).
 */
export function pickSnoozeRows(
  rows: readonly TodayDoseRow[] | undefined,
  medicationId: string,
): { open: TodayDoseRow | null; snoozed: TodayDoseRow | null } {
  const mine = (rows ?? []).filter((r) => r.medicationId === medicationId);
  const snoozed =
    mine.find((r) => r.status === "snoozed" && r.snoozedUntil) ?? null;
  const open =
    mine.find(
      (r) =>
        r.status !== "snoozed" && (r.state === "due" || r.state === "overdue"),
    ) ?? null;
  return { open, snoozed };
}

export function useDoseSnooze({
  medicationId,
  medicationName,
  enabled,
}: {
  medicationId: string;
  medicationName: string;
  /**
   * False where a snooze means nothing (no reminders, recorded
   * automatically, a delegate's view, an inactive medication).
   */
  enabled: boolean;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const minutes = useSnoozeMinutes(enabled);
  const [busy, setBusy] = useState(false);
  const { data: rows } = useQuery({
    queryKey: queryKeys.medicationIntakeToday(),
    queryFn: () =>
      apiGet<TodayDoseRow[]>("/api/medications/intake?scope=today"),
    enabled,
    staleTime: 60_000,
  });
  const { open, snoozed } = pickSnoozeRows(enabled ? rows : [], medicationId);

  async function snooze() {
    if (!open || busy) return;
    setBusy(true);
    try {
      await apiPost("/api/medications/intake", {
        intakeId: open.id,
        status: "snoozed",
      });
      toast.success(
        t("medications.dose.snoozedToast", {
          name: medicationName,
          time: fmt.time(new Date(Date.now() + minutes * 60_000)),
        }),
      );
      await invalidateMedicationReads(queryClient);
    } catch (failure) {
      showErrorToast(
        t("medications.dose.snoozeFailed", { name: medicationName }),
        { cause: failure },
      );
    } finally {
      setBusy(false);
    }
  }

  return {
    minutes,
    /** ISO instant the reminder is held until, or null. */
    snoozedUntil: snoozed?.snoozedUntil ?? null,
    canSnooze: open !== null && snoozed === null,
    busy,
    snooze,
  };
}

/**
 * A medication card's snooze: offered only where a reminder exists to push
 * back, in the person's own record (a delegate may not snooze).
 */
export function useCardDoseSnooze(medication: {
  id: string;
  name: string;
  active: boolean;
  notificationsEnabled: boolean;
  autoMarkTaken?: boolean;
  trackIntake?: boolean;
  intakeActionable?: boolean;
  asNeeded?: boolean;
}) {
  const recordName = useActiveRecordName();
  return useDoseSnooze({
    medicationId: medication.id,
    medicationName: medication.name,
    enabled:
      medication.active &&
      medication.notificationsEnabled &&
      medication.autoMarkTaken !== true &&
      medication.trackIntake !== false &&
      medication.intakeActionable !== false &&
      medication.asNeeded !== true &&
      !recordName,
  });
}
