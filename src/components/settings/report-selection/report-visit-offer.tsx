"use client";

/**
 * "Bericht für den Termin am … erstellen" — the report knows why it is being
 * generated.
 *
 * The cheapest integration in this milestone and the one that changes the most:
 * a person opening the export panel a week before an appointment is almost
 * always opening it BECAUSE of the appointment, and the window they want ends
 * on that day. One query, one prefilled field, one dismissible offer.
 *
 * **It never auto-applies.** The window is not silently changed and then left
 * for the person to discover; the offer names its own source ("weil am … ein
 * Termin ansteht") and does nothing until pressed. A control that moves on its
 * own is the thing that makes an export panel untrustworthy.
 *
 * Nothing about the stored selection changes: this sets the custom-range end
 * date and nothing else.
 */
import { CalendarClock, X } from "lucide-react";
import { useState } from "react";

import { encounterKindText } from "@/components/encounters/encounter-labels";
import { Button } from "@/components/ui/button";
import { useEncounters } from "@/hooks/use-encounters";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { EncounterKind } from "@/generated/prisma/client";
import { detectBrowserTimezone, userDayKey } from "@/lib/tz/format";

/**
 * How far ahead a booked visit is treated as the reason for this report.
 *
 * Two weeks: far enough that somebody preparing in advance is offered it, near
 * enough that a routine check-up six months out does not colonise the panel.
 */
export const REPORT_VISIT_HORIZON_DAYS = 14;

/** The local `yyyy-MM-dd` a `DateField` takes, in the reader's own day. */
function localDay(iso: string): string {
  return userDayKey(new Date(iso), detectBrowserTimezone());
}

export function ReportVisitOffer({
  onUseVisitDate,
}: {
  /** Sets the custom window's END date. Called only on an explicit press. */
  onUseVisitDate: (endDay: string) => void;
}) {
  const { t } = useTranslations();
  const format = useFormatters();
  const [dismissed, setDismissed] = useState(false);
  const visits = useEncounters();

  // Read once, at mount. A clock read during render is impure — and here it
  // would also mean the offer could vanish mid-interaction as a visit crossed
  // the horizon between two renders.
  const [now] = useState(() => Date.now());

  if (dismissed) return null;

  const horizon = now + REPORT_VISIT_HORIZON_DAYS * 24 * 60 * 60 * 1000;
  const next = (visits.data?.upcoming ?? []).find((visit) => {
    if (visit.status !== "PLANNED") return false;
    const at = new Date(visit.occurredAt).getTime();
    return at > now && at <= horizon;
  });
  if (!next) return null;

  const what =
    next.practitioner?.name ?? encounterKindText(t, next.kind as EncounterKind);

  return (
    <div
      data-slot="report-visit-offer"
      className="border-border flex flex-wrap items-center gap-2 rounded-lg border p-3"
    >
      {/* Content, not meta: it is the offer, and it names its own source. On
          a phone the sentence takes the full row and the two buttons wrap
          below it; with a zero basis it was squeezed into a one-word column
          beside them. */}
      <p className="text-foreground flex min-w-0 flex-1 basis-full items-center gap-2 text-sm sm:basis-0">
        <CalendarClock className="size-4 shrink-0" aria-hidden />
        <span>
          {t("settings.healthRecord.visitOffer", {
            what,
            when: format.date(next.occurredAt),
          })}
        </span>
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="ml-auto min-h-11 sm:ml-0 sm:min-h-9"
        data-slot="report-visit-offer-apply"
        onClick={() => onUseVisitDate(localDay(next.occurredAt))}
      >
        {t("settings.healthRecord.visitOfferApply")}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 shrink-0 sm:size-9"
        aria-label={t("common.dismiss")}
        onClick={() => setDismissed(true)}
      >
        <X className="size-4" aria-hidden />
      </Button>
    </div>
  );
}
