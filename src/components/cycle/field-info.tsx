"use client";

import { InfoPopover } from "@/components/ui/info-popover";

/**
 * v1.18.1 — the cycle log-sheet field-explainer affordance.
 *
 * A small "?" / info icon that puts a factual, descriptive-only one-liner
 * (what a clinical field means — BBT, cervical mucus, an LH surge) right at
 * the point of capture, so a first-time user never has to leave the sheet to
 * understand a term.
 *
 * This used to be a
 * self-contained hover `Tooltip`, which never opens reliably on tap; the
 * cycle sheet is a thumb-first surface, so it now wraps the click-opened
 * `InfoPopover` (the app's one (i) info-affordance since the v1.28.17
 * merge) instead, keeping the `cycle-field-info` data-slot the sheet
 * already keys off of.
 *
 * Copy stays descriptive-only — never diagnosis or medical advice — matching
 * the phase-education honesty gate.
 */
export function FieldInfo({
  label,
  detail,
  className,
}: {
  /** Accessible name for the trigger (what the icon explains). */
  label: string;
  /** The explanation shown in the popover. */
  detail: string;
  className?: string;
}) {
  return (
    <InfoPopover
      content={detail}
      label={label}
      align="start"
      triggerDataSlot="cycle-field-info"
      className={className}
    />
  );
}
