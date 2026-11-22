"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiPost } from "@/lib/api/api-fetch";
import { CONFIRMS_INLINE } from "@/lib/api/mutation-feedback";

/**
 * One-time, dismissible "add a passkey" prompt. Shown only when the account
 * has no passkey registered and has not dismissed the nudge before. Dismissal
 * is persisted on the user (`passkeyUpgradeNudgeDismissed`).
 */
export function PasskeyUpgradeNudge() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const dismiss = useMutation({
    // Confirms in place: the prompt goes once the status refetches.
    meta: CONFIRMS_INLINE,
    mutationFn: async () => {
      await apiPost("/api/auth/me/passkey-nudge/dismiss");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mfaStatus() });
    },
  });

  return (
    <div className="border-primary/30 bg-primary/5 flex items-start gap-3 rounded-lg border p-4">
      <Sparkles className="text-muted-foreground mt-0.5 size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {t("settings.security.passkeyNudge.title")}
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          {t("settings.security.passkeyNudge.body")}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="min-h-11 min-w-11 shrink-0 sm:h-8 sm:min-h-0 sm:w-8 sm:min-w-0"
        onClick={() => dismiss.mutate()}
        disabled={dismiss.isPending}
        aria-label={t("common.dismiss")}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
