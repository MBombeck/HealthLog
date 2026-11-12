"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { showErrorToast } from "@/lib/errors/error-toast";

import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw } from "@/lib/api/api-fetch";

type UnitPreference = "metric" | "imperial";

/**
 * v1.12.x — unit system (metric/imperial) as a Profile dropdown.
 *
 * The metric/imperial preference is a personal setting like language
 * and timezone, so it lives in the Profile form beside the timezone
 * picker rather than in a standalone card (it replaces the retired
 * `<UnitPreferenceCard>`). Persistence is unchanged: a change PATCHes
 * `/api/auth/me/unit-preference` immediately and invalidates
 * `queryKeys.authMe()`, the account payload every chart display transform
 * (km/h vs mph, km vs mi) reads, so they re-render on the next /me refetch.
 */
export function UnitPreferenceSelect({
  isAuthenticated,
  id = "unit-preference",
}: {
  isAuthenticated: boolean;
  id?: string;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [optimistic, setOptimistic] = useState<UnitPreference | null>(null);
  const value: UnitPreference = optimistic ?? user?.unitPreference ?? "metric";

  const mutation = useMutation({
    mutationFn: async (next: UnitPreference) => {
      const res = await apiFetchRaw("/api/auth/me/unit-preference", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unitPreference: next }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      return next;
    },
    onSuccess: () => {
      toastWrittenOutcome("success", t("settings.dashboard.units.saved"));
      queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
      setOptimistic(null);
    },
    onError: (err) => {
      setOptimistic(null);
      showErrorToast(t("settings.dashboard.units.saveError"), { cause: err });
    },
  });

  function handleSelect(next: UnitPreference) {
    if (next === value || mutation.isPending || !isAuthenticated) return;
    setOptimistic(next);
    mutation.mutate(next);
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("settings.dashboard.units.title")}</Label>
      <NativeSelect
        id={id}
        data-testid="settings-unit-preference-select"
        value={value}
        disabled={!isAuthenticated || mutation.isPending}
        onChange={(e) => handleSelect(e.target.value as UnitPreference)}
      >
        <option value="metric">{t("settings.dashboard.units.metric")}</option>
        <option value="imperial">
          {t("settings.dashboard.units.imperial")}
        </option>
      </NativeSelect>
      <p className="text-muted-foreground text-xs">
        {t("settings.dashboard.units.description")}
      </p>
    </div>
  );
}
