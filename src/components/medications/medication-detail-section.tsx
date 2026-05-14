"use client";

import { type ReactNode } from "react";

/**
 * v1.4.25 W21 Fix-N — section wrapper for the three medication-detail
 * panels (Titration, Scheduling, SideEffects). The four wave-4b
 * sections previously hand-rolled the same chrome — border + header
 * row + dotted divider + body padding — and drifted on padding (px-3
 * vs px-3 py-2.5 vs px-3 py-2), border opacity (border-border/60 vs
 * /70), and aria wiring (aria-labelledby was inconsistent).
 *
 * This wrapper locks the contract:
 *   - `border-border/60 rounded-md border` chrome
 *   - `px-3 py-2.5` header row with `text-foreground/85 text-sm font-medium` title
 *   - `border-border/60 border-t px-3 py-3 text-xs` body band
 *   - `aria-labelledby` wired to a stable per-section id derived from `titleId`
 *
 * Consumers pass:
 *   - `titleId` — the DOM id on the heading element. Components owning
 *     a heading id already (e.g. "titration-heading") pass it through;
 *     new surfaces should follow the `<slot>-heading` convention.
 *   - `title` — the rendered heading text (already i18n-translated by
 *     the caller).
 *   - `headerExtras` — optional right-side header content (e.g. drug
 *     INN badge, edit CTA, "Add" button).
 *   - `dataSlot` — optional `data-slot` attribute on the outer section
 *     so cross-section selectors (Playwright, snapshot tests) stay
 *     stable.
 *   - `bodyPaddingY` — escape hatch for sections that need a different
 *     vertical padding (the side-effects body runs at py-2.5 because
 *     it owns an inline timeline with its own gap rhythm).
 */
export interface MedicationDetailSectionProps {
  titleId: string;
  title: ReactNode;
  headerExtras?: ReactNode;
  children: ReactNode;
  dataSlot?: string;
  bodyPaddingY?: "py-2.5" | "py-3";
}

export function MedicationDetailSection({
  titleId,
  title,
  headerExtras,
  children,
  dataSlot,
  bodyPaddingY = "py-3",
}: MedicationDetailSectionProps) {
  return (
    <section
      className="border-border/60 rounded-md border"
      aria-labelledby={titleId}
      {...(dataSlot ? { "data-slot": dataSlot } : {})}
    >
      <header className="flex items-center justify-between gap-2 px-3 py-2.5">
        <h2
          id={titleId}
          className="text-foreground/85 text-sm font-medium"
        >
          {title}
        </h2>
        {headerExtras}
      </header>
      <div
        className={`border-border/60 border-t px-3 text-xs ${bodyPaddingY}`}
      >
        {children}
      </div>
    </section>
  );
}
