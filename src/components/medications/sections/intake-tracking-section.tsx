"use client";

/**
 * v1.39.1 (#1033) — the per-medication "track intake" switch.
 *
 * One switch row, the same shape as the reminder switch beside it: the whole
 * row is the hit target, the helper line says what the current state means.
 * Flipping writes `PUT /api/medications/[id]` with `{ trackIntake }`; the
 * server keeps the schedule either way and archives the moment of the switch,
 * so the stretch with tracking off never reads as missed doses.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Switch } from "@/components/ui/switch";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";
import { apiPut } from "@/lib/api/api-fetch";

const SWITCH_ID = "medication-detail-track-intake-switch";
const ROW_TITLE_ID = "medication-detail-track-intake-label";
const HELPER_ID = "medication-detail-track-intake-helper";

export function IntakeTrackingBody({
  medicationId,
  trackIntake,
}: {
  medicationId: string;
  trackIntake: boolean;
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
      toast.success(
        next
          ? t("medications.trackIntake.enabledToast")
          : t("medications.trackIntake.disabledToast"),
      );
    } catch {
      setLocalTracked(previous);
      toast.error(t("medications.trackIntake.toggleFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <label
      htmlFor={SWITCH_ID}
      className="flex items-center justify-between gap-3"
      data-slot="medication-track-intake-row"
    >
      <span className="space-y-1">
        <span
          id={ROW_TITLE_ID}
          className="text-foreground block text-sm font-medium"
        >
          {t("medications.trackIntake.label")}
        </span>
        <span id={HELPER_ID} className="text-muted-foreground block text-xs">
          {localTracked
            ? t("medications.trackIntake.helperOn")
            : t("medications.trackIntake.helperOff")}
        </span>
      </span>
      <Switch
        id={SWITCH_ID}
        checked={localTracked}
        disabled={submitting}
        onCheckedChange={(checked) => void flip(checked)}
        aria-labelledby={ROW_TITLE_ID}
        aria-describedby={HELPER_ID}
        data-slot="medication-track-intake-switch"
      />
    </label>
  );
}
