"use client";

import { useMemo, useState } from "react";
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
import {
  MEDICINE_REGISTRIES,
  registryAuthority,
  type MedicineRegistryChoice,
} from "@/lib/medications/leaflet-registries";
import { queryKeys } from "@/lib/query-keys";

/**
 * Settings → Medications: which official medicine registry "Find leaflet"
 * searches (#1430). One value per person, independent of the interface
 * language: someone reading the app in English in Warsaw picks Poland. "None"
 * hides the search. Saves on change through
 * `PATCH /api/auth/me/medicine-registry`, then re-reads `/api/auth/me` and the
 * medication reads, whose `leafletSearch` follows the setting.
 *
 * Country names come from the browser's own region names in the interface
 * language (`Intl.DisplayNames`), so every locale reads them natively; the
 * registry's name beside each is a proper name and stays as it is.
 */
export function MedicineRegistryCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t, locale } = useTranslations();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [optimistic, setOptimistic] = useState<MedicineRegistryChoice | null>(
    null,
  );
  const value: MedicineRegistryChoice =
    optimistic ?? user?.medicineRegistry ?? "NONE";

  const options = useMemo(() => {
    let regionName: (code: string) => string = (code) => code;
    try {
      const names = new Intl.DisplayNames([locale], { type: "region" });
      regionName = (code) => names.of(code) ?? code;
    } catch {
      // An engine without region names shows the codes, which still read.
    }
    return MEDICINE_REGISTRIES.map((code) => ({
      code,
      label: `${regionName(code)} (${registryAuthority(code)})`,
    })).sort((a, b) => a.label.localeCompare(b.label, locale));
  }, [locale]);

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
      await queryClient.invalidateQueries({
        queryKey: queryKeys.medications(),
      });
      setOptimistic(null);
    },
    onError: (err) => {
      setOptimistic(null);
      showErrorToast(t("settings.sections.medications.registry.saveError"), {
        cause: err,
      });
    },
  });

  function handleSelect(next: MedicineRegistryChoice) {
    if (next === value || mutation.isPending || !isAuthenticated) return;
    setOptimistic(next);
    mutation.mutate(next);
  }

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
        <label
          htmlFor="medicine-registry-select"
          className="text-sm font-medium"
        >
          {t("settings.sections.medications.registry.label")}
        </label>
        <NativeSelect
          id="medicine-registry-select"
          data-slot="medicine-registry-select"
          value={value}
          disabled={!isAuthenticated || mutation.isPending}
          onChange={(e) =>
            handleSelect(e.target.value as MedicineRegistryChoice)
          }
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
        <p className="text-muted-foreground text-xs">
          {t("settings.sections.medications.registry.privacy")}
        </p>
      </div>
    </SettingsCard>
  );
}
