"use client";

/**
 * v1.42.2 — the per-medication "record doses automatically" switch.
 *
 * The same switch row as the intake-tracking and reminder rows beside it:
 * a SwitchRow, the helper line says what the option
 * does. Flipping writes `PUT /api/medications/[id]` with `{ autoMarkTaken }`;
 * the server stamps the moment it was switched on, and only slots from then
 * on are ever recorded for the person.
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

const SWITCH_ID = "medication-detail-auto-mark-taken-switch";

export function AutoMarkTakenBody({
  medicationId,
  autoMarkTaken,
  compact = false,
}: {
  medicationId: string;
  autoMarkTaken: boolean;
  /** One line: the name and the switch, no helper. */
  compact?: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [localOn, setLocalOn] = useState(autoMarkTaken);
  const [submitting, setSubmitting] = useState(false);

  async function flip(next: boolean) {
    if (submitting) return;
    setSubmitting(true);
    const previous = localOn;
    setLocalOn(next);
    try {
      await apiPut(`/api/medications/${medicationId}`, {
        autoMarkTaken: next,
      });
      await invalidateKeys(queryClient, medicationDependentKeys);
      await refetchInactiveDailyReads(queryClient);
      toast.success(
        next
          ? t("medications.autoMarkTaken.enabledToast")
          : t("medications.autoMarkTaken.disabledToast"),
      );
    } catch (failure) {
      setLocalOn(previous);
      showErrorToast(t("medications.autoMarkTaken.toggleFailed"), {
        cause: failure,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SwitchRow
      label={t("medications.autoMarkTaken.label")}
      description={compact ? undefined : t("medications.autoMarkTaken.helper")}
      id={SWITCH_ID}
      checked={localOn}
      disabled={submitting}
      onCheckedChange={(checked) => void flip(checked)}
      data-slot="medication-auto-mark-taken-switch"
    />
  );
}
