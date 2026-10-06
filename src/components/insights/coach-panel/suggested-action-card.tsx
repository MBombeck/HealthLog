"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Loader2, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { apiPost } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { invalidateReminderReads } from "@/hooks/use-measurement-reminders";
import type { CoachSuggestedAction } from "@/lib/ai/coach/suggest-action";

/**
 * v1.22 (F6) — the generalised one-tap "confirm → apply" Coach action card.
 *
 * Rendered under an assistant bubble when the turn carried a `suggestedAction`
 * (live from the SSE frame, or persisted on the message provenance). The card
 * shows a localized heading per action type (`titleKey`) + the model's plain-text
 * summary, and two actions:
 *
 *   - "Add" → POSTs the validated params to `POST /api/coach/suggested-actions`,
 *     which builds the entity SERVER-side, field-by-field. NEVER auto-applied.
 *   - "Not now" → dismisses the card locally (no server write).
 *
 * RENDER dedup mirrors the cadence card: once settled, the card collapses to a
 * confirmation so a stale stream + persisted twin can't double-prompt. The
 * STATIC copy is i18n; the dynamic summary/label is the user's own content
 * (plain text — no markdown, matching the XSS posture).
 */
export function SuggestedActionCard({
  action,
}: {
  action: CoachSuggestedAction;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [settled, setSettled] = useState<"applied" | "dismissed" | null>(null);

  const apply = useMutation({
    mutationFn: async () => {
      await apiPost("/api/coach/suggested-actions", action.params);
    },
    onSuccess: () => {
      // Both arms mint a reminder row the checkups list and the Today rail
      // read; the note arm additionally lands on the coach-reminders list.
      void invalidateReminderReads(queryClient);
      if (action.params.actionType === "reminder.note") {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.coachRemindersAll(),
        });
      }
      setSettled("applied");
    },
    onError: () => toast.error(t("coach.suggestedAction.failed")),
  });

  if (settled) {
    return (
      <p
        role="status"
        data-slot="coach-suggested-action-done"
        className="text-muted-foreground flex items-center gap-1.5 text-xs"
      >
        <Check className="text-success size-3.5" aria-hidden="true" />
        {t(
          settled === "applied"
            ? "coach.suggestedAction.applied"
            : "coach.suggestedAction.dismissed",
        )}
      </p>
    );
  }

  const busy = apply.isPending;
  const intervalLabel =
    action.params.actionType === "checkup.create"
      ? t(`coach.suggestedAction.interval.${action.params.interval}`)
      : null;

  return (
    <div
      data-slot="coach-suggested-action-card"
      className={cn(
        "border-border/60 bg-muted/40 flex flex-col gap-2.5 rounded-xl border",
        "px-3.5 py-3 text-sm",
      )}
    >
      <div className="flex items-start gap-2">
        <div
          aria-hidden="true"
          className="from-primary to-info mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br"
        >
          <Sparkles className="text-background size-3.5" />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground text-xs font-medium">
            {t(action.titleKey)}
          </span>
          <span className="text-foreground leading-relaxed break-words">
            {action.summary}
          </span>
          {intervalLabel && (
            <span className="text-muted-foreground text-xs">
              {intervalLabel}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-slot="coach-suggested-action-apply"
          onClick={() => apply.mutate()}
          disabled={busy}
          className={cn(
            "bg-primary/90 text-background hover:bg-primary",
            "focus-visible:ring-input-focus inline-flex min-h-11 items-center gap-1.5 sm:min-h-9",
            "rounded-md px-3 py-1.5 text-xs font-medium outline-none",
            "focus-visible:ring-2 disabled:opacity-50",
          )}
        >
          {busy ? (
            <Loader2
              className="size-3.5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <Check className="size-3.5" aria-hidden="true" />
          )}
          {t("coach.suggestedAction.apply")}
        </button>
        <button
          type="button"
          data-slot="coach-suggested-action-dismiss"
          onClick={() => setSettled("dismissed")}
          disabled={busy}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-input-focus inline-flex min-h-11 items-center rounded-md px-2.5 py-1.5 text-xs outline-none focus-visible:ring-2 disabled:opacity-50 sm:min-h-9"
        >
          {t("coach.suggestedAction.dismiss")}
        </button>
      </div>
    </div>
  );
}
