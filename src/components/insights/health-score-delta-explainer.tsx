"use client";

import { useId, useState } from "react";
import { HelpCircle } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * v1.4.28 R3c-Insights — explain the "vs last week" delta on tap.
 *
 * FB-I1: the user asked why the headline number moved. The earlier
 * delta line surfaced the digit ("-3 vs last week") without any
 * mention of which components shifted, what the comparison window
 * actually is, or what the user can do about it. The explainer is a
 * single icon-only `?` button next to the delta line that opens a
 * three-sentence read.
 *
 * Surface choice follows R1.1 §1 — popover on `md+`, bottom-sheet
 * on phone-class viewports. Both share the same body copy via the
 * `insights.healthScore.deltaExplainer.body` key; the title is
 * surfaced as the popover-content first line on desktop and as the
 * sheet header on mobile (the ResponsiveSheet primitive already
 * paints a header band on the sheet branch).
 *
 * Pure presentational. Owns its own open state — the parent doesn't
 * need to thread an extra prop through.
 */

interface HealthScoreDeltaExplainerProps {
  /**
   * The delta value the parent already painted on the line above. The
   * explainer doesn't repaint the digit; it sits next to the line
   * with the `?` glyph and lets the user request the prose.
   */
  delta: number;
  /**
   * Optional className for the trigger button so the parent can
   * align the glyph to the delta line's baseline.
   */
  className?: string;
  /**
   * Optional id the parent owns and threads to the explainer body via
   * the popover/sheet markup. The same id sits on the parent's delta
   * `<span>` as `aria-describedby` so screen readers can connect "−3
   * vs last week" to the three-sentence read on demand.
   */
  bodyId?: string;
}

export function HealthScoreDeltaExplainer({
  delta,
  className,
  bodyId,
}: HealthScoreDeltaExplainerProps) {
  const { t } = useTranslations();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  // Stable fallback id when the parent doesn't supply one. The body
  // still paints the id so future consumers can thread the same
  // describedby pattern without modifying the explainer.
  const generatedId = useId();
  const resolvedBodyId = bodyId ?? generatedId;

  const triggerLabel = t("insights.healthScore.deltaExplainer.trigger");
  const title = t("insights.healthScore.deltaExplainer.title");
  const body = t("insights.healthScore.deltaExplainer.body");

  // Direct click handler on the button on both branches. Earlier
  // mobile path wrapped the button in a `<span onClick onKeyDown>`
  // which created two interactive elements in the a11y tree and
  // intercepted clicks on the 2 px gap around the button. The button
  // already handles Enter/Space natively; the only thing the wrapper
  // owned was the open toggle, which moves onto the button itself.
  const handleOpen = () => setOpen(true);

  const trigger = (
    <button
      type="button"
      data-slot="health-score-delta-explainer-trigger"
      aria-label={triggerLabel}
      aria-expanded={open}
      aria-controls={resolvedBodyId}
      className={cn(
        // Visible glyph stays 12 px so the chip reads at the delta
        // line's height without inflating the row. The button itself
        // sits at the 44 px WCAG 2.5.5 floor via `min-h-11 min-w-11`;
        // negative `-my-3 -mx-2` collapses the surrounding row back
        // to its 16 px stride so the optical chip stays small while
        // the hit surface lifts to 44 px. Transparent padding owns
        // the extra reach.
        "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50",
        "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full",
        "-my-3 -mx-2",
        "transition-colors focus-visible:ring-2 focus-visible:outline-none",
        className,
      )}
      onClick={handleOpen}
    >
      <HelpCircle className="h-3 w-3" aria-hidden="true" />
    </button>
  );

  if (isMobile) {
    return (
      <>
        {trigger}
        <ResponsiveSheet
          open={open}
          onOpenChange={setOpen}
          title={title}
          description={t(
            "insights.healthScore.deltaExplainer.description",
            { delta: delta > 0 ? `+${delta}` : `${delta}` },
          )}
        >
          <p
            id={bodyId}
            data-slot="health-score-delta-explainer-body"
            className="text-muted-foreground text-sm leading-relaxed"
          >
            {body}
          </p>
        </ResponsiveSheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        data-slot="health-score-delta-explainer-popover"
        align="start"
        sideOffset={6}
        className="max-w-xs space-y-1.5"
      >
        <p
          data-slot="health-score-delta-explainer-title"
          className="text-foreground text-xs font-semibold"
        >
          {title}
        </p>
        <p
          id={resolvedBodyId}
          data-slot="health-score-delta-explainer-body"
          className="text-muted-foreground text-[11px] leading-snug"
        >
          {body}
        </p>
      </PopoverContent>
    </Popover>
  );
}
