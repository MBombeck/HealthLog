"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { showErrorToast } from "@/lib/errors/error-toast";

import { FieldGroup } from "@/components/ui/field-group";
import { NativeSelect } from "@/components/ui/native-select";
import { useAuth } from "@/hooks/use-auth";
import type { DateFormatPreference } from "@/lib/format-locale";
import { DATE_FORMAT_OPTIONS, storeDateFormat } from "@/lib/date-format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw } from "@/lib/api/api-fetch";

/**
 * Date-order (DD.MM / MM/DD / ISO) preference as a Profile dropdown.
 *
 * Sits directly below the hour-format select because it is the same kind of
 * personal display preference; the active locale otherwise pins the date
 * order with no way out. AUTO follows the locale convention, DMY/MDY/YMD pin
 * the field order regardless of locale.
 *
 * Persistence mirrors `<TimeFormatSelect>`: a change PATCHes the profile
 * endpoint immediately and invalidates `queryKeys.authMe()`. The localStorage
 * mirror is written synchronously so every `useFormatters()` consumer and the
 * `<DateField>` primitive repaint without waiting for the refetch.
 */
export function DateFormatSelect({
  isAuthenticated,
  id = "date-format",
}: {
  isAuthenticated: boolean;
  id?: string;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [optimistic, setOptimistic] = useState<DateFormatPreference | null>(
    null,
  );
  const value: DateFormatPreference = optimistic ?? user?.dateFormat ?? "AUTO";

  const mutation = useMutation({
    mutationFn: async (next: DateFormatPreference) => {
      const res = await apiFetchRaw("/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateFormat: next }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      return next;
    },
    onSuccess: (next) => {
      // Repaint every formatter consumer right away; the /me refetch below
      // re-asserts the same value once it settles.
      storeDateFormat(next);
      toastWrittenOutcome("success", t("settings.dateFormat.saved"));
      queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
      setOptimistic(null);
    },
    onError: (err) => {
      setOptimistic(null);
      showErrorToast(t("settings.dateFormat.saveError"), { cause: err });
    },
  });

  function handleSelect(next: DateFormatPreference) {
    if (next === value || mutation.isPending || !isAuthenticated) return;
    setOptimistic(next);
    mutation.mutate(next);
  }

  return (
    <FieldGroup htmlFor={id} label={t("settings.dateFormat.title")}>
      <NativeSelect
        id={id}
        data-testid="settings-date-format-select"
        value={value}
        disabled={!isAuthenticated || mutation.isPending}
        onChange={(e) => handleSelect(e.target.value as DateFormatPreference)}
      >
        {DATE_FORMAT_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {t(opt.labelKey)}
          </option>
        ))}
      </NativeSelect>
    </FieldGroup>
  );
}
