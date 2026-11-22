import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * `<SettingsCardActions>` — the action row of a card.
 *
 * The audit found four positions (bottom-right, bottom-left, the header's
 * status slot, inline mid-card) and five variants carrying the SAME role —
 * "the primary action of this card" — sometimes two of them in one file. The
 * two sections that already read right (`score-section.tsx`,
 * `coach-prefs-section.tsx`) agreed on one shape, and this is it.
 *
 * The contract (design standards §12):
 *   - The row is the LAST thing in the card. Status lines and results sit
 *     above it; a result set big enough to need a frame becomes its own card.
 *   - Primary action last (rightmost), `variant` default, `size="sm"`. One
 *     per card. A save button carries its word and no icon.
 *   - Secondary action `outline`, before the primary in the same row.
 *   - Destructive card-wide action: same row, `variant="destructive"` —
 *     never an `outline` hand-tinted with `text-destructive`.
 *
 * The row owns its buttons' height and width, so a call site passes neither:
 * 44 px on a phone and under a finger, 36 px on a wider screen with a mouse,
 * and as wide as the label at every viewport. The row used to own only its
 * own flex line, and the buttons drifted: most spelled `min-h-11 sm:min-h-9`,
 * some `min-h-11`, some nothing, and the cards added in 1.49 hung
 * `w-full sm:w-auto` on theirs, so three cards in one column had three
 * different save buttons. The selectors below outrank a class on the button
 * itself, and `healthlog/card-action-row` refuses the class in the first
 * place.
 *
 * `align="start"` is the one documented exception: a card whose only actions
 * are deep links out of it (privacy, about, export) has no primary action, so
 * its links read with the text on the left rather than against it.
 *
 * `leading` is a control that belongs to the row but is not one of its
 * actions (the "Details" disclosure of an integration card). It stands on
 * the left, the actions stay on the right.
 */
// An icon button (a card's overflow menu) keeps its square.
const ACTION_BUTTONS =
  "[&_[data-slot=button]:not([data-size^=icon])]:h-8 [&_[data-slot=button]:not([data-size^=icon])]:min-h-11 [&_[data-slot=button]:not([data-size^=icon])]:w-auto sm:pointer-fine:[&_[data-slot=button]:not([data-size^=icon])]:min-h-9";

export function SettingsCardActions({
  align = "end",
  leading,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  align?: "start" | "end";
  leading?: React.ReactNode;
}) {
  if (leading) {
    return (
      <div
        data-slot="settings-card-actions"
        className={cn(
          "flex flex-wrap items-center justify-between gap-2",
          className,
        )}
        {...props}
      >
        {leading}
        <div
          className={cn(
            "ml-auto flex flex-wrap items-center justify-end gap-2",
            ACTION_BUTTONS,
          )}
        >
          {children}
        </div>
      </div>
    );
  }
  return (
    <div
      data-slot="settings-card-actions"
      className={cn(
        "flex flex-wrap items-center gap-2",
        align === "end" ? "justify-end" : "justify-start",
        ACTION_BUTTONS,
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
