"use client";

import { useState } from "react";
import { Info, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";

/**
 * One-time note on the correlation surface after the v1.42 engine change.
 *
 * Since v1.42 every daily pair is correlated on seasonally adjusted residuals
 * with an effective-sample-size p-value, so an account with history usually
 * sees far fewer relationships than before. Without a word about it that
 * reads as a defect. The note explains it once.
 *
 * Who sees it is decided on the server: `findingsBeforeSeasonalAdjustment`
 * on the correlations response is true only when the record kept a discovery
 * pattern from before the change, so an account created since never sees it.
 * Dismissing follows the app's one-off hint convention (`AiSetupHint`): it is
 * remembered per viewer in this browser, and a storage failure hides the note
 * for the current visit only.
 */
const STORAGE_PREFIX = "healthlog.correlation-seasonal-note.dismissed";

export function correlationSeasonalNoteStorageKey(viewerId: string): string {
  return `${STORAGE_PREFIX}.${viewerId}`;
}

function readDismissed(viewerId: string): boolean {
  try {
    return (
      window.localStorage.getItem(
        correlationSeasonalNoteStorageKey(viewerId),
      ) === "1"
    );
  } catch {
    return false;
  }
}

export function CorrelationSeasonalNote({
  findingsBeforeSeasonalAdjustment,
}: {
  /** From the correlations response; absent on an older server. */
  findingsBeforeSeasonalAdjustment: boolean | undefined;
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  // Storage is browser-only: nothing renders before hydration, so the server
  // HTML and the first client render agree.
  const mounted = useMounted();
  const [dismissedNow, setDismissedNow] = useState(false);

  const viewerId = user?.id ?? null;
  if (!mounted || viewerId === null) return null;
  if (findingsBeforeSeasonalAdjustment !== true) return null;
  if (dismissedNow || readDismissed(viewerId)) return null;

  const dismiss = () => {
    setDismissedNow(true);
    try {
      window.localStorage.setItem(
        correlationSeasonalNoteStorageKey(viewerId),
        "1",
      );
    } catch {
      // Storage unavailable (private mode): hidden for this visit only.
    }
  };

  return (
    <div
      data-slot="correlation-seasonal-note"
      role="note"
      className="flex items-start justify-between gap-3 rounded-lg border p-3"
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p className="text-foreground text-sm">
          {t("insights.pattern.seasonalNote")}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={dismiss}
        aria-label={t("insights.pattern.seasonalNoteDismiss")}
        title={t("insights.pattern.seasonalNoteDismiss")}
        data-slot="correlation-seasonal-note-dismiss"
        // 44 px on a phone like every other mobile action; the negative
        // margin keeps the row as tall as the text needs.
        className="-my-2 size-11 shrink-0 sm:size-9"
      >
        <X className="size-4" aria-hidden="true" />
      </Button>
    </div>
  );
}
