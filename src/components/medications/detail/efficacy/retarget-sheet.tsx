"use client";

/**
 * "Messwert ändern": the sheet that repoints a medication's effect view at
 * another of the person's measurements or lab markers, or back to the one
 * its class suggests. Opened from the effect card on the overview and from
 * the effect tab; one sheet, one write (`PUT .../efficacy/target`).
 *
 * The route declares `"guardian"` (#1408): the owner and a managed profile's
 * guardian reach it, an adult's delegate does not. `useMayRetarget` says
 * whether to offer it at all.
 */

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field-group";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  holdsGuardianSurfaces,
  useRecordCapabilities,
} from "@/hooks/use-record-capabilities";
import { apiPut } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import type { MedicationEfficacyDTO } from "@/lib/medications/efficacy/build-efficacy";
import { queryKeys } from "@/lib/query-keys";

/** Whether this viewer may repoint the effect view, and has anything to pick. */
export function useMayRetarget(
  options: MedicationEfficacyDTO["overrideOptions"] | undefined,
): boolean {
  const mayRetarget = holdsGuardianSurfaces(useRecordCapabilities());
  return (
    mayRetarget &&
    !!options &&
    options.metrics.length + options.biomarkers.length > 0
  );
}

export function RetargetSheet({
  medicationId,
  options,
  isOverride,
  open,
  onOpenChange,
}: {
  medicationId: string;
  options: MedicationEfficacyDTO["overrideOptions"];
  isOverride: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [value, setValue] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const items = useMemo(
    () => [
      ...options.metrics.map((m) => ({
        value: `metric:${m.key}`,
        label: m.label,
      })),
      ...options.biomarkers.map((b) => ({
        value: `lab:${b.id}`,
        label: b.label,
      })),
    ],
    [options],
  );

  const apply = async (clear: boolean) => {
    const body: {
      clear?: boolean;
      measurementType?: string;
      biomarkerId?: string;
    } = {};
    if (clear) body.clear = true;
    else if (value.startsWith("metric:")) {
      body.measurementType = value.slice("metric:".length);
    } else if (value.startsWith("lab:")) {
      body.biomarkerId = value.slice("lab:".length);
    } else return;
    setBusy(true);
    try {
      await apiPut(`/api/medications/${medicationId}/efficacy/target`, body);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.medicationEfficacy(medicationId),
      });
      setValue("");
      onOpenChange(false);
    } catch (failure) {
      showErrorToast(t("medications.efficacy.retarget.error"), {
        cause: failure,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("medications.detail.overview.changeMetric")}
      footer={
        <div className="grid w-full grid-cols-2 gap-2">
          {isOverride ? (
            <Button
              variant="outline"
              className="min-h-11 w-full sm:min-h-9"
              disabled={busy}
              onClick={() => void apply(true)}
              data-slot="medication-wirkung-retarget-reset"
            >
              {t("medications.efficacy.retarget.reset")}
            </Button>
          ) : (
            <span />
          )}
          <Button
            className="min-h-11 w-full sm:min-h-9"
            disabled={busy || value === ""}
            aria-busy={busy || undefined}
            onClick={() => void apply(false)}
            data-slot="medication-wirkung-retarget-apply"
          >
            {t("medications.efficacy.retarget.apply")}
          </Button>
        </div>
      }
    >
      <div data-slot="medication-wirkung-retarget">
        <FieldGroup
          label={t("medications.detail.overview.metricField")}
          htmlFor="medication-wirkung-retarget-select"
        >
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger
              id="medication-wirkung-retarget-select"
              className="min-h-11 w-full sm:min-h-9"
            >
              <SelectValue
                placeholder={t("medications.efficacy.retarget.placeholder")}
              />
            </SelectTrigger>
            <SelectContent>
              {items.map((it) => (
                <SelectItem key={it.value} value={it.value}>
                  {it.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldGroup>
      </div>
    </ResponsiveSheet>
  );
}
