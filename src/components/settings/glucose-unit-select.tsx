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
import { resolveGlucoseUnit, type GlucoseUnit } from "@/lib/glucose";

/**
 * Blood-glucose display unit as a Profile dropdown.
 *
 * The preference column and its thirty-odd readers shipped in v1.2 with no
 * control to set them, so every account stayed on the mg/dL default and the
 * mmol/L half of the app was unreachable. This is the control.
 *
 * It sits beside the metric/imperial dropdown because it is the same kind of
 * setting — how a number is shown, not what is stored — but it is a separate
 * choice: metric countries are split on which unit they read glucose in, so
 * folding it into metric/imperial would get one of them wrong. The option
 * labels are the unit symbols themselves, which read the same in every
 * locale.
 *
 * Persistence mirrors the unit-system select: a change PATCHes
 * `/api/auth/me/glucose-unit` immediately and invalidates `queryKeys.authMe()`,
 * so the dashboard tiles and the glucose insight page re-render on the next
 * /me refetch, and `queryKeys.insightsTargets()`, whose payload states the
 * target ranges in the unit it was built with.
 */
export function GlucoseUnitSelect({
  isAuthenticated,
  id = "glucose-unit",
}: {
  isAuthenticated: boolean;
  id?: string;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [optimistic, setOptimistic] = useState<GlucoseUnit | null>(null);
  const value: GlucoseUnit =
    optimistic ?? resolveGlucoseUnit(user?.glucoseUnit);

  const mutation = useMutation({
    mutationFn: async (next: GlucoseUnit) => {
      const res = await apiFetchRaw("/api/auth/me/glucose-unit", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ glucoseUnit: next }),
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
      toastWrittenOutcome("success", t("settings.dashboard.glucoseUnit.saved"));
      queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
      queryClient.invalidateQueries({ queryKey: queryKeys.insightsTargets() });
      setOptimistic(null);
    },
    onError: (err) => {
      setOptimistic(null);
      showErrorToast(t("settings.dashboard.glucoseUnit.saveError"), {
        cause: err,
      });
    },
  });

  function handleSelect(next: GlucoseUnit) {
    if (next === value || mutation.isPending || !isAuthenticated) return;
    setOptimistic(next);
    mutation.mutate(next);
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("settings.dashboard.glucoseUnit.title")}</Label>
      <NativeSelect
        id={id}
        data-testid="settings-glucose-unit-select"
        value={value}
        disabled={!isAuthenticated || mutation.isPending}
        onChange={(e) => handleSelect(e.target.value as GlucoseUnit)}
      >
        {/* Unit symbols, not translated copy — they read the same
            everywhere, and a locale that "translated" one would be
            naming a different measurement. */}
        <option value="mg/dL">mg/dL</option>
        <option value="mmol/L">mmol/L</option>
      </NativeSelect>
      <p className="text-muted-foreground text-xs">
        {t("settings.dashboard.glucoseUnit.description")}
      </p>
    </div>
  );
}
