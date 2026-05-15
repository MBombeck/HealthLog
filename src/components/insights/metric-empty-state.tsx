"use client";

import type { ReactNode } from "react";

import { CoachLaunchButton } from "@/components/insights/coach-launch-button";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * v1.4.28 R3d (BK-F-M1 + BK-MED-4) — shared empty-state primitive for
 * the insights sub-pages.
 *
 * Pre-fix, every sub-page repeated the same five-line incantation:
 *
 *   <EmptyState icon={…} title={…} description={…} ctaSize="lg" action={…} />
 *   <CoachLaunchButton prefill={…} />
 *
 * The action slot was always a `<Button asChild><Link href="…">…</Link></Button>`
 * pointing into `/measurements?add=<TYPE>` (or `/mood` / `/medications`
 * for the event-driven metrics). Some sub-pages forgot to mount the
 * `<CoachLaunchButton>` underneath; BK-MED-4 wanted every sub-page to
 * expose a Coach launch on the empty state because the conversational
 * affordance is exactly the right onboarding nudge when the user hasn't
 * logged data yet.
 *
 * This primitive consolidates both responsibilities. Consumers pass:
 *
 *   - the `icon` + `title` + `description` strings (already localised),
 *   - the primary CTA node (typically a `<Button asChild>` link),
 *   - the optional Coach `prefill` so a tap on "Ask the Coach" seeds
 *     the next turn with the metric-specific context.
 *
 * The Coach launch always renders (BK-MED-4). Pass `coachPrefill={null}`
 * to use the default prompt; pass a string to seed a metric-specific
 * onboarding question.
 */
export interface MetricEmptyStateProps {
  /** Icon node (typically a `lucide-react` glyph). */
  icon: ReactNode;
  /** Empty-state headline (already localised). */
  title: string;
  /** One-line scaffold beneath the headline (already localised). */
  description: string;
  /** Primary CTA — usually a `<Button asChild><Link/></Button>`. */
  cta: ReactNode;
  /**
   * Optional Coach prefill. `null` falls back to the shared default
   * prompt the `<CoachLaunchButton>` ships. Pass a metric-specific
   * sentence ("I haven't recorded any blood pressure yet — …") to
   * seed the first Coach turn with onboarding context.
   */
  coachPrefill?: string | null;
}

export function MetricEmptyState({
  icon,
  title,
  description,
  cta,
  coachPrefill,
}: MetricEmptyStateProps) {
  return (
    <>
      <EmptyState
        icon={icon}
        title={title}
        description={description}
        ctaSize="lg"
        action={cta}
      />
      <CoachLaunchButton prefill={coachPrefill ?? undefined} />
    </>
  );
}
