"use client";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTranslations } from "@/lib/i18n/context";
import { ScorePill } from "@/components/ui/score-pill";

/**
 * v1.8.5 — `<TargetStatusPill>` extracted from `target-card.tsx`.
 *
 * The verbal status pill ("Optimal", "Slightly elevated", localized)
 * is now a shared primitive so both the Targets card and the Insights
 * per-category reference panel render the identical pill from the same
 * server-emitted `classification.category`. Single-sourcing the
 * category → label → colour mapping here means the two surfaces can
 * never disagree on what a band reads or which tone it paints.
 *
 * Behaviour is byte-identical to the previous inline version in
 * `target-card.tsx`: a coloured pill (green in-band / amber caution /
 * red out) with a tooltip carrying the target range + guideline source.
 */

interface TargetClassification {
  category: string;
  color: string;
}

interface TargetRange {
  min: number;
  max: number;
}

/**
 * Server classification category → i18n key under `targets.status.*`.
 * The category is canonical (emitted by `/api/insights/targets`); this
 * map only resolves it to the localized label.
 */
const STATUS_CATEGORY_KEY: Record<string, string> = {
  Underweight: "underweight",
  Normal: "normal",
  Overweight: "overweight",
  "Obesity Grade I": "obesityGrade1",
  "Obesity Grade II": "obesityGrade2",
  "Obesity Grade III": "obesityGrade3",
  Optimal: "optimal",
  "High-normal": "highNormal",
  "Hypertension Grade 1": "hypertensionGrade1",
  "Hypertension Grade 2": "hypertensionGrade2",
  "Hypertension Grade 3": "hypertensionGrade3",
  "Below typical range": "belowTypicalRange",
  Elevated: "elevated",
  "Above typical range": "aboveTypicalRange",
  "Significantly low": "significantlyLow",
  "Slightly low": "slightlyLow",
  "On target": "onTarget",
  "Slightly elevated": "slightlyElevated",
  "Significantly elevated": "significantlyElevated",
  "Far too short": "farTooShort",
  "Too short": "tooShort",
  "Slightly long": "slightlyLong",
  "Far too long": "farTooLong",
  "Below essential": "belowEssential",
  Essential: "essential",
  Athletic: "athletic",
  Fitness: "fitness",
  Acceptable: "acceptable",
  Obese: "obese",
  "Very low": "veryLow",
  "Low active": "lowActive",
  "Moderately active": "moderatelyActive",
  Active: "active",
  "Very active": "veryActive",
  Good: "good",
  Moderate: "moderate",
  Low: "low",
  High: "high",
  "Very good": "veryGood",
  "Very stable": "veryStable",
  Stable: "stable",
  Fluctuating: "fluctuating",
};

/** Resolve a server-emitted classification.category to its translated label. */
export function translateStatus(
  category: string,
  t: (key: string, vars?: Record<string, string>) => string,
): string {
  const key = STATUS_CATEGORY_KEY[category];
  if (!key) return category;
  return t(`targets.status.${key}`);
}

/**
 * Map an in-band classification category to one of three semantic
 * groups. Used to drive the status-pill style without re-classifying
 * the value from scratch; the server's category is canonical.
 *
 * "in" = inside the green band ("On target", "Normal", "Optimal", …).
 * "near" = inside the orange band ("Slightly elevated", "Overweight",
 *   …) or a step inside an obesity / hypertension grade-1 band.
 * "out" = outside all bands ("Hypertension Grade 3", "Obesity Grade
 *   III", "Tachycardia" away from the target band, …).
 *
 * When the category is unmapped we fall back to "near" — the safe
 * middle, which paints the pill in the neutral amber tone rather than
 * lighting up a false-positive green/red.
 */
export function statusGroupForCategory(
  category: string,
): "in" | "near" | "out" {
  const greenCategories = new Set([
    "Normal",
    "Optimal",
    "On target",
    "Good",
    "Very good",
    "Very stable",
    "Stable",
    "Athletic",
    "Fitness",
    "Acceptable",
    "Active",
    "Very active",
    "Moderately active",
    "Essential",
  ]);
  // Note: "Below typical range" / "Above typical range" (resting pulse,
  // v1.29.6) are deliberately absent from both sets — they fall through to
  // the default "near" (amber) group below, same as "Elevated" already
  // does. The prior "Bradycardia" / "Tachycardia" categories painted this
  // pill destructive-red, a diagnosis-shaped verdict that contradicted the
  // calmer, neutral framing the interpretation layer uses for the identical
  // signal (see `insight-interpretation.ts` → `RESTING_HEART_RATE`).
  const redCategories = new Set([
    "Obesity Grade III",
    "Hypertension Grade 3",
    "Significantly elevated",
    "Significantly low",
    "Far too short",
    "Far too long",
    "Low",
    "High",
    "Fluctuating",
    "Below essential",
    "Very low",
  ]);
  if (greenCategories.has(category)) return "in";
  if (redCategories.has(category)) return "out";
  return "near";
}

// Coloured text on a 10% same-hue tint, in the `ScorePill` anatomy. The
// tone classes stay this pill's own, on purpose: the tint and
// text share one theme-aware token per tone (`--status-pill-{in,near,
// out}` in globals.css) so the pill clears WCAG AA (4.5:1) on both the
// Targets card (`bg-card`) and the W5 insights reference panel
// (`bg-muted/30`) in both dark and light themes — the raw Dracula
// green/orange/red failed AA for the "out" tone on the muted panel in
// dark mode and for every tone on a white card in light mode.
//
// Use the Tailwind v4 parenthesised CSS-variable shorthand
// (bg-VAR-PAREN-FORM-/N) instead of the legacy bracketed VAR-form. The
// bracketed form combined with an opacity modifier emits an escaped
// class selector that Turbopack's CSS parser rejects with
// "Unexpected token Delim('.')" because the scanner picks the literal
// string out of source files (including this comment) and emits a CSS
// rule for it. The parenthesised shorthand produces a clean selector
// that parses cleanly. See the Tailwind v4 upgrade guide for the
// migration from bracket-form to paren-form for CSS-variable values.
export const STATUS_PILL_STYLES: Record<"in" | "near" | "out", string> = {
  in: "bg-(--status-pill-in)/10 text-(--status-pill-in)",
  near: "bg-(--status-pill-near)/10 text-(--status-pill-near)",
  out: "bg-(--status-pill-out)/10 text-(--status-pill-out)",
};

export interface TargetStatusPillProps {
  classification: TargetClassification;
  range: TargetRange | null;
  unit: string;
  source: string;
}

/**
 * Verbal status pill; a tap shows the target range + the guideline source.
 * The pill colour is derived from the classification category's semantic
 * group; unmapped categories paint amber.
 */
export function TargetStatusPill({
  classification,
  range,
  unit,
  source,
}: TargetStatusPillProps) {
  const { t } = useTranslations();

  const statusGroup = statusGroupForCategory(classification.category);
  const statusPillStyle = STATUS_PILL_STYLES[statusGroup];
  const statusLabel = translateStatus(classification.category, t);

  return (
    <Popover>
      <PopoverTrigger className="focus-visible:ring-ring/50 inline-flex rounded-full focus-visible:ring-2 focus-visible:outline-none">
        <ScorePill
          data-slot="target-status-pill"
          data-status={statusGroup}
          className={statusPillStyle}
        >
          {statusLabel}
        </ScorePill>
      </PopoverTrigger>
      <PopoverContent align="end">
        {range && (
          <p className="text-xs">
            {t("targets.targetRangeValue", {
              min: String(range.min),
              max: String(range.max),
              unit,
            })}
          </p>
        )}
        <p className="text-xs">{t("targets.sourceLabel", { source })}</p>
      </PopoverContent>
    </Popover>
  );
}
