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
 * v1.8.0 — per-category "What is X?" explainer.
 *
 * A question-mark glyph that sits next to a metric sub-page heading and,
 * on tap / Enter / Space, surfaces one to two layperson sentences that
 * define the metric. The copy is static — there is no network call — so
 * the explainer paints instantly and works offline. Each metric resolves
 * its title + body off a stable i18n key pair:
 *
 *   insights.subPage.explainer.<metric>Title
 *   insights.subPage.explainer.<metric>Body
 *
 * The surface choice mirrors `<HealthScoreDeltaExplainer>`: a popover on
 * `md+`, a bottom-sheet on phone-class viewports. Both branches share the
 * same body copy so the read is identical regardless of viewport.
 *
 * a11y: the trigger is a real `<button>` (Enter / Space activate it
 * natively) carrying a descriptive `aria-label`, `aria-expanded`, and
 * `aria-controls` pointing at the body. The optical glyph stays 14 px so
 * it reads at the heading's height, but the hit surface lifts to the
 * 44 px WCAG 2.5.5 floor via `min-h-11 min-w-11`; negative margins
 * collapse the surrounding row back to its natural stride so the chip
 * stays visually small while the reach is full-size.
 */

interface MetricExplainerProps {
  /**
   * The metric key. Drives the title + body lookup under
   * `insights.subPage.explainer.<metric>{Title,Body}`.
   */
  metric: string;
  /** Optional className forwarded to the trigger button. */
  className?: string;
}

export function MetricExplainer({ metric, className }: MetricExplainerProps) {
  const { t } = useTranslations();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const bodyId = useId();

  const title = t(`insights.subPage.explainer.${metric}Title`);
  const body = t(`insights.subPage.explainer.${metric}Body`);
  const triggerLabel = t("insights.subPage.explainer.trigger", { title });

  const trigger = (
    <button
      type="button"
      data-slot="metric-explainer-trigger"
      aria-label={triggerLabel}
      aria-expanded={open}
      aria-controls={bodyId}
      className={cn(
        "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50",
        "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full",
        "-my-3 -mx-2",
        "transition-colors focus-visible:ring-2 focus-visible:outline-none",
        className,
      )}
      onClick={() => setOpen(true)}
    >
      <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );

  if (isMobile) {
    return (
      <>
        {trigger}
        <ResponsiveSheet open={open} onOpenChange={setOpen} title={title}>
          <p
            id={bodyId}
            data-slot="metric-explainer-body"
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
        data-slot="metric-explainer-popover"
        align="start"
        sideOffset={6}
        className="max-w-xs space-y-1.5"
      >
        <p
          data-slot="metric-explainer-title"
          className="text-foreground text-xs font-semibold"
        >
          {title}
        </p>
        <p
          id={bodyId}
          data-slot="metric-explainer-body"
          className="text-muted-foreground text-xs leading-snug"
        >
          {body}
        </p>
      </PopoverContent>
    </Popover>
  );
}
