"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { SwitchRow } from "@/components/ui/switch-row";
import { useAuth } from "@/hooks/use-auth";
import { apiPatch } from "@/lib/api/api-fetch";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

/**
 * Settings > Account > Display: whether the sidebar and the More sheet show
 * their counts (#1113), the doses due on Medications and the check-ups due on
 * Checkups. On by default. Saves on change through
 * `PATCH /api/auth/me/show-nav-counts`, then re-reads `/api/auth/me`, which
 * `useNavCounts` reads the choice from; while it is off the counts are not
 * asked for at all.
 */
export function NavCountsSwitch({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const checked = optimistic ?? user?.showNavCounts !== false;

  const mutation = useMutation({
    mutationFn: (showNavCounts: boolean) =>
      apiPatch<{ showNavCounts: boolean }>("/api/auth/me/show-nav-counts", {
        showNavCounts,
      }),
    onSuccess: async () => {
      toastWrittenOutcome("success", t("settings.saved"));
      await queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
      setOptimistic(null);
    },
    onError: (err) => {
      setOptimistic(null);
      showErrorToast(t("settings.savingError"), { cause: err });
    },
  });

  return (
    <SwitchRow
      id="nav-counts-switch"
      data-testid="settings-nav-counts-switch"
      label={t("settings.displayCard.navCountsLabel")}
      description={t("settings.displayCard.navCountsDescription")}
      checked={checked}
      disabled={!isAuthenticated || mutation.isPending}
      onCheckedChange={(next) => {
        if (next === checked || mutation.isPending || !isAuthenticated) return;
        setOptimistic(next);
        mutation.mutate(next);
      }}
    />
  );
}
