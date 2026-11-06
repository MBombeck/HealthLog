"use client";

import { useFormatters, useTranslations } from "@/lib/i18n/context";

import { FLOW_HUE } from "./phase-tokens";
import type { ProjectedCycle, ProjectionState } from "./types";

/**
 * #1350 — the periods after the next one, each as the window its start may
 * fall in. The list and its bands are the server's (`/api/cycle/calendar`
 * `projection`, the same list the calendar feed serves); this only renders
 * them. The band widens from one row to the next, and the server stops the
 * list where a date would be a guess.
 *
 * The next period itself is the row above this one in the predictions card,
 * so cycle 1 is skipped here. A late period is stated, in the muted tone: a
 * late period is a fact about the calendar, not a warning.
 */
export function UpcomingCycles({
  projection,
  state,
}: {
  projection: readonly ProjectedCycle[];
  state: ProjectionState | null;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  if (state === "LATE") {
    return (
      <p
        className="text-muted-foreground text-sm"
        data-slot="cycle-projection-late"
      >
        {t("cycle.projection.state.LATE")}
      </p>
    );
  }

  const later = projection.filter((c) => c.k >= 2);
  if (later.length === 0) return null;

  return (
    <div className="space-y-2" data-slot="cycle-projection">
      <p className="text-muted-foreground text-xs font-medium">
        {t("cycle.projection.title")}
      </p>
      <ul className="divide-border divide-y">
        {later.map((c) => (
          <li key={c.k} className="flex items-center gap-2 py-2 text-sm">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 rounded-full opacity-60"
              style={{ backgroundColor: FLOW_HUE }}
            />
            <span className="text-muted-foreground">
              {t("cycle.projection.around", {
                date: fmt.dateShortSmartCalendar(c.start),
              })}
            </span>
            <span className="text-foreground ml-auto font-medium tabular-nums">
              {t("cycle.predictions.nextPeriodWindow", {
                low: fmt.dateShortSmartCalendar(c.bandStart),
                high: fmt.dateShortSmartCalendar(c.bandEnd),
              })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
