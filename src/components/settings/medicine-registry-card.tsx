"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { NativeSelect } from "@/components/ui/native-select";
import { useAuth } from "@/hooks/use-auth";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import type { MedicineRegistryChoice } from "@/lib/medications/leaflet-registries";
import { useMedicineRegistryOptions } from "@/components/settings/use-medicine-registry-options";
import { invalidateMedicationReads, queryKeys } from "@/lib/query-keys";

/**
 * Settings → Modules → Medications: which official medicine registry "Find leaflet"
 * searches (#1430). One value per person, independent of the interface
 * language: someone reading the app in English in Warsaw picks Poland. "None"
 * hides the search. Saves on change through
 * `PATCH /api/auth/me/medicine-registry`, then re-reads `/api/auth/me` and the
 * medication reads, whose `leafletSearch` follows the setting.
 *
 * The options come from `useMedicineRegistryOptions`, shared with the setup.
 */
/**
 * The registry choice and its save, shared by the card here and the leaflet
 * section on a medication, so both write through one mutation and re-read the
 * same queries.
 */
function useMedicineRegistryChoice(isAuthenticated: boolean) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [optimistic, setOptimistic] = useState<MedicineRegistryChoice | null>(
    null,
  );
  const value: MedicineRegistryChoice =
    optimistic ?? user?.medicineRegistry ?? "NONE";

  const options = useMedicineRegistryOptions();

  const mutation = useMutation({
    mutationFn: async (next: MedicineRegistryChoice) => {
      const res = await apiFetchRaw("/api/auth/me/medicine-registry", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ medicineRegistry: next }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      return next;
    },
    onSuccess: async () => {
      toastWrittenOutcome(
        "success",
        t("settings.sections.medications.registry.saved"),
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
      // Every medication read carries `leafletSearch`, built from the setting.
      await invalidateMedicationReads(queryClient);
      setOptimistic(null);
    },
    onError: (err) => {
      setOptimistic(null);
      showErrorToast(t("settings.sections.medications.registry.saveError"), {
        cause: err,
      });
    },
  });

  function select(next: MedicineRegistryChoice) {
    if (next === value || mutation.isPending || !isAuthenticated) return;
    setOptimistic(next);
    mutation.mutate(next);
  }

  return { value, options, select, pending: mutation.isPending };
}

/** The registry select, with its label; the privacy line is the caller's. */
export function MedicineRegistrySelect({
  isAuthenticated,
  id,
  labelKey = "settings.sections.medications.registry.label",
}: {
  isAuthenticated: boolean;
  id: string;
  labelKey?: string;
}) {
  const { t } = useTranslations();
  const { value, options, select, pending } =
    useMedicineRegistryChoice(isAuthenticated);
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium">
        {t(labelKey)}
      </label>
      <NativeSelect
        id={id}
        data-slot="medicine-registry-select"
        value={value}
        disabled={!isAuthenticated || pending}
        onChange={(e) => select(e.target.value as MedicineRegistryChoice)}
      >
        <option value="NONE">
          {t("settings.sections.medications.registry.none")}
        </option>
        {options.map((option) => (
          <option key={option.code} value={option.code}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

export function MedicineRegistryCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  return (
    <SettingsCard
      as="section"
      id="medicine-registry"
      className="scroll-mt-28"
      aria-labelledby="settings-medicine-registry-title"
    >
      <SettingsCardHeader
        icon={BookOpen}
        title={t("settings.sections.medications.registry.title")}
        titleId="settings-medicine-registry-title"
        description={t("settings.sections.medications.registry.description")}
      />
      <div className="space-y-2">
        <MedicineRegistrySelect
          isAuthenticated={isAuthenticated}
          id="medicine-registry-select"
        />
        <p className="text-muted-foreground text-xs">
          {t("settings.sections.medications.registry.privacy")}
        </p>
      </div>
    </SettingsCard>
  );
}
