"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BellPlus, Check, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { apiPost } from "@/lib/api/api-fetch";
import { invalidateReminderReads } from "@/hooks/use-measurement-reminders";
import type { CoachSuggestion } from "@/lib/ai/coach/types";

/**
 * v1.18.1 (Workstream C) — the one-tap cadence-suggestion action card.
 *
 * Rendered under an assistant bubble when the turn carried a `suggestion`
 * (live from the SSE frame, or persisted on the message provenance). Three
 * actions, all routed through `POST /api/coach/reminder-suggestions`:
 *
 *   - "Set reminder" → creates a `MeasurementReminder` (origin: COACH).
 *   - "Not now"      → dismissal memory (never re-suggest this cadence).
 *   - "I measure enough" → the explicit stop path (no more suggestions).
 *
 * RENDER dedup (the middle leg of the triple dedup): once the user settles
 * the card it collapses to a confirmation and never re-renders an action,
 * so a stale stream + persisted twin can't double-prompt.
 */
export function ReminderSuggestionCard({
  suggestion,
}: {
  suggestion: CoachSuggestion;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [settled, setSettled] = useState<
    "accepted" | "dismissed" | "stopped" | null
  >(null);

  const act = useMutation({
    mutationFn: async (action: "accept" | "dismiss" | "stop") => {
      await apiPost("/api/coach/reminder-suggestions", {
        cadenceId: suggestion.cadenceId,
        action,
      });
      return action;
    },
    onSuccess: (action) => {
      if (action === "accept") {
        // The accept minted a `MeasurementReminder` — refresh the checkups
        // list and the Today rail so it does not stay invisible until the
        // next poll.
        void invalidateReminderReads(queryClient);
      }
      setSettled(
        action === "accept"
          ? "accepted"
          : action === "stop"
            ? "stopped"
            : "dismissed",
      );
    },
    onError: () => {
      toast.error(t("coach.reminderSuggestion.failed"));
    },
  });

  if (settled) {
    return (
      <p
        role="status"
        data-slot="coach-reminder-suggestion-done"
        className="text-muted-foreground flex items-center gap-1.5 text-xs"
      >
        <Check className="text-success size-3.5" aria-hidden="true" />
        {t(
          settled === "accepted"
            ? "coach.reminderSuggestion.accepted"
            : settled === "stopped"
              ? "coach.reminderSuggestion.stopped"
              : "coach.reminderSuggestion.dismissed",
        )}
      </p>
    );
  }

  const busy = act.isPending;

  return (
    <div
      data-slot="coach-reminder-suggestion-card"
      className={cn(
        "border-border/60 bg-muted/40 flex flex-col gap-2.5 rounded-xl border",
        "px-3.5 py-3 text-sm",
      )}
    >
      <div className="flex items-start gap-2">
        <div
          aria-hidden="true"
          className="from-primary to-brand-pink mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br"
        >
          <BellPlus className="text-background size-3.5" />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground text-xs font-medium">
            {t("coach.reminderSuggestion.title")}
          </span>
          {/* The label is a localised cadence string (the i18n key the
              server hands back in `suggestion.label`). */}
          <span className="text-foreground leading-relaxed">
            {t(suggestion.label)}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-slot="coach-reminder-suggestion-accept"
          onClick={() => act.mutate("accept")}
          disabled={busy}
          className={cn(
            "bg-primary/90 text-background hover:bg-primary",
            "focus-visible:ring-input-focus inline-flex min-h-9 items-center gap-1.5",
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
            <BellPlus className="size-3.5" aria-hidden="true" />
          )}
          {t("coach.reminderSuggestion.accept")}
        </button>
        <button
          type="button"
          data-slot="coach-reminder-suggestion-dismiss"
          onClick={() => act.mutate("dismiss")}
          disabled={busy}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-input-focus inline-flex min-h-9 items-center rounded-md px-2.5 py-1.5 text-xs outline-none focus-visible:ring-2 disabled:opacity-50"
        >
          {t("coach.reminderSuggestion.dismiss")}
        </button>
        <button
          type="button"
          data-slot="coach-reminder-suggestion-stop"
          onClick={() => act.mutate("stop")}
          disabled={busy}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-input-focus inline-flex min-h-9 items-center rounded-md px-2.5 py-1.5 text-xs outline-none focus-visible:ring-2 disabled:opacity-50"
        >
          {t("coach.reminderSuggestion.stop")}
        </button>
      </div>
    </div>
  );
}
