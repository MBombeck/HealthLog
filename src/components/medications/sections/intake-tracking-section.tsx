"use client";

/**
 * v1.39.1 (#1033) — the per-medication "track intake" switch.
 *
 * One switch row, the same shape as the reminder switch beside it: a
 * SwitchRow, the helper line says what the current state means.
 * Flipping writes `PUT /api/medications/[id]` with `{ trackIntake }`; the
 * server keeps the schedule either way and archives the moment of the switch,
 * so the stretch with tracking off never reads as missed doses.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { showErrorToast } from "@/lib/errors/error-toast";

import { SwitchRow } from "@/components/ui/switch-row";
import { useTranslations } from "@/lib/i18n/context";
import {
  invalidateKeys,
  medicationDependentKeys,
  refetchInactiveDailyReads,
} from "@/lib/query-keys";
import { apiPut } from "@/lib/api/api-fetch";

const SWITCH_ID = "medication-detail-track-intake-switch";

export function IntakeTrackingBody({
  medicationId,
  trackIntake,
  courseEnded = false,
  compact = false,
}: {
  /** One line: the name and the switch, no helper. */
  compact?: boolean;
  medicationId: string;
  trackIntake: boolean;
  /**
   * #1215 — the course has ended (by hand, or imported with a past end
   * date). The course window already keeps every dose from falling due, so
   * the switch keeps its value, but the helper must not promise due doses.
   */
  courseEnded?: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [localTracked, setLocalTracked] = useState(trackIntake);
  const [submitting, setSubmitting] = useState(false);

  async function flip(next: boolean) {
    if (submitting) return;
    setSubmitting(true);
    const previous = localTracked;
    setLocalTracked(next);
    try {
      await apiPut(`/api/medications/${medicationId}`, { trackIntake: next });
      await invalidateKeys(queryClient, medicationDependentKeys);
      // The doses card and the Today digest read this medication's due
      // state; they are usually unmounted here, so refetch them now.
      await refetchInactiveDailyReads(queryClient);
      toast.success(
        next
          ? t("medications.trackIntake.enabledToast")
          : t("medications.trackIntake.disabledToast"),
      );
    } catch (failure) {
      setLocalTracked(previous);
      showErrorToast(t("medications.trackIntake.toggleFailed"), {
        cause: failure,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SwitchRow
      label={t("medications.trackIntake.label")}
      description={
        compact
          ? undefined
          : !localTracked
            ? t("medications.trackIntake.helperOff")
            : courseEnded
              ? t("medications.trackIntake.helperEnded")
              : t("medications.trackIntake.helperOn")
      }
      id={SWITCH_ID}
      checked={localTracked}
      disabled={submitting}
      onCheckedChange={(checked) => void flip(checked)}
      data-slot="medication-track-intake-switch"
    />
  );
}
