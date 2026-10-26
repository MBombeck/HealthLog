import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * The small rounded chip that states a grade beside a reading: a confidence
 * level, a score gain, a band ("Optimal", "Hypertension grade 1"), a lab
 * value below or above its range.
 *
 * One anatomy (`rounded-full px-2 py-0.5 text-xs font-medium`, a soft wash of
 * the tone, no border) and one tone vocabulary, where there used to be two
 * looks for the same meaning: the crosstab chips washed at /15 without a
 * border, the correlation and trend badges washed at /10 with a /40 border,
 * and "medium confidence" was blue on one card and amber on the next.
 *
 * The tone carries meaning, never decoration (UI standards §3):
 * `success` / `info` / `warning` / `destructive` for a verdict, `neutral`
 * for a grade that says nothing good or bad (low confidence).
 *
 * Not for a neutral label (that is `TagChip`) and not for the state of a
 * connection or an account (that is `Badge`).
 */
const scorePillVariants = cva(
  "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap [&>svg]:size-3 [&>svg]:shrink-0",
  {
    variants: {
      tone: {
        success: "bg-success/15 text-success",
        info: "bg-info/15 text-info",
        warning: "bg-warning/15 text-warning",
        destructive: "bg-destructive/15 text-destructive",
        // The secondary surface's own foreground: muted text on the secondary
        // fill measured 3.6:1 in the dark theme, under the AA floor a pill
        // label needs.
        neutral: "bg-secondary text-secondary-foreground",
      },
      numeric: {
        true: "font-semibold tabular-nums",
        false: "",
      },
    },
    defaultVariants: { tone: "neutral", numeric: false },
  },
);

export type ScorePillTone = NonNullable<
  VariantProps<typeof scorePillVariants>["tone"]
>;

/**
 * The tone of a confidence level. Two scales reach the UI — the crosstabs say
 * `medium`, the correlation and trend payloads say `moderate` — and both mean
 * the same middle step.
 */
export const CONFIDENCE_TONE = {
  low: "neutral",
  medium: "info",
  moderate: "info",
  high: "success",
} as const satisfies Record<string, ScorePillTone>;

function ScorePill({
  className,
  tone,
  numeric,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof scorePillVariants>) {
  return (
    <span
      data-slot="score-pill"
      data-tone={tone ?? "neutral"}
      className={cn(scorePillVariants({ tone, numeric }), className)}
      {...props}
    />
  );
}

export { ScorePill, scorePillVariants };
