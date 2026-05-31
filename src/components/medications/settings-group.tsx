"use client";

/**
 * v1.7.0 — advanced-settings group header.
 *
 * Lightweight presentational grouping for the redesigned
 * `<AdvancedSettingsSheet>`: an uppercase micro-label over a hairline
 * rule, then the group body. Reads as "one settings document, four
 * parts" rather than three bordered section cards.
 *
 * The label is a plain `<p>` (not a heading with an id) so it stays out
 * of the `aria-labelledby` graph — the sheet already owns the dialog
 * title, and the inner switch labels carry their own ids. This avoids
 * the duplicate-id axe failure the section-card heading split guards
 * against.
 */

import { type ReactNode } from "react";

export interface SettingsGroupProps {
  label: ReactNode;
  children: ReactNode;
  dataSlot?: string;
}

export function SettingsGroup({
  label,
  children,
  dataSlot,
}: SettingsGroupProps) {
  return (
    <section
      className="space-y-4"
      {...(dataSlot ? { "data-slot": dataSlot } : {})}
    >
      <p className="border-border/60 text-muted-foreground border-t pt-1 text-xs font-medium tracking-wide uppercase">
        {label}
      </p>
      {children}
    </section>
  );
}
