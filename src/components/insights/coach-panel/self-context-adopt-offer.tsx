"use client";

/**
 * v1.16.4 — quiet "fold this answer back into your self-context" offer.
 *
 * When the user answers a pending clarifying-question chip (the chip
 * inserted the question into the composer; the sent message is the
 * answer), this strip appears above the composer and offers to adopt
 * the answer into the matching Selbstauskunft field via
 * `POST /api/coach/about-me/adopt`. One tap adopts (the server picks
 * the field, dedupes, appends encrypted); the ✕ declines. After an
 * adoption (or a server-side dedupe) a short confirmation lingers for a
 * few seconds, then the strip removes itself — no modal, no toast, no
 * vertical cost once settled.
 */
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookmarkPlus, Check, Loader2, X } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { apiPost } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

export interface SelfContextAdoptOfferProps {
  /** The clarifying question the user just answered. */
  question: string;
  /** The composer message that answered it. */
  answer: string;
  /** Remove the strip (declined, or confirmation elapsed). */
  onDismiss: () => void;
  /**
   * v1.16.5 — reports the offer's outcome once, so the guided
   * clarifying-questions flow can count adoptions for its closing
   * summary. Fired on server settle (adopted / duplicate), on a failed
   * request, and on an explicit decline — never on the auto-fold
   * timeout (the outcome was already reported by then).
   */
  onSettled?: (
    outcome: "adopted" | "duplicate" | "declined" | "failed",
  ) => void;
}

export function SelfContextAdoptOffer({
  question,
  answer,
  onDismiss,
  onSettled,
}: SelfContextAdoptOfferProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [settled, setSettled] = useState<"adopted" | "duplicate" | null>(null);

  const adopt = useMutation({
    mutationFn: async () => {
      return apiPost<{ adopted: boolean }>("/api/coach/about-me/adopt", {
        question,
        answer,
      });
    },
    onSuccess: (data) => {
      if (data.adopted) {
        // The adoption changed the stored self-context — refresh the
        // Settings → AI about-me read so it shows the new entry.
        void queryClient.invalidateQueries({
          queryKey: queryKeys.coachAboutMe(),
        });
      }
      setSettled(data.adopted ? "adopted" : "duplicate");
      onSettled?.(data.adopted ? "adopted" : "duplicate");
    },
    onError: () => {
      onSettled?.("failed");
    },
  });

  // Let the confirmation linger briefly, then fold the strip away.
  useEffect(() => {
    if (!settled) return;
    const handle = window.setTimeout(onDismiss, 4000);
    return () => window.clearTimeout(handle);
  }, [settled, onDismiss]);

  return (
    <div
      data-slot="coach-self-context-adopt"
      className={cn(
        "border-primary/30 bg-primary/10 mb-2 flex items-center gap-2 rounded-lg border px-3 py-2",
      )}
    >
      {settled ? (
        <p
          role="status"
          className="text-muted-foreground flex items-center gap-1.5 text-xs"
        >
          <Check
            className="text-success size-3.5 shrink-0"
            aria-hidden="true"
          />
          {t(
            settled === "adopted"
              ? "insights.coach.selfContextAdopt.done"
              : "insights.coach.selfContextAdopt.duplicate",
          )}
        </p>
      ) : (
        <>
          <BookmarkPlus
            className="text-primary size-3.5 shrink-0"
            aria-hidden="true"
          />
          <p className="text-muted-foreground min-w-0 flex-1 text-xs">
            {t("insights.coach.selfContextAdopt.offer")}
          </p>
          <button
            type="button"
            data-slot="coach-self-context-adopt-confirm"
            disabled={adopt.isPending}
            onClick={() => adopt.mutate()}
            className={cn(
              "text-primary inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium",
              "hover:bg-primary/15 focus-visible:ring-input-focus focus-visible:ring-2 focus-visible:outline-none",
              "disabled:opacity-60",
            )}
          >
            {adopt.isPending ? (
              <Loader2
                className="size-3 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {t("insights.coach.selfContextAdopt.confirm")}
          </button>
          <button
            type="button"
            aria-label={t("insights.coach.selfContextAdopt.dismiss")}
            data-slot="coach-self-context-adopt-dismiss"
            onClick={() => {
              onSettled?.("declined");
              onDismiss();
            }}
            className={cn(
              "text-muted-foreground hover:text-foreground flex min-h-8 items-center rounded-full px-1.5",
              "hover:bg-primary/15 focus-visible:ring-input-focus focus-visible:ring-2 focus-visible:outline-none",
            )}
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </>
      )}
      {adopt.isError ? (
        <p role="alert" className="text-destructive text-xs">
          {t("insights.coach.selfContextAdopt.failed")}
        </p>
      ) : null}
    </div>
  );
}
