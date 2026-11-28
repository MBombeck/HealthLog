"use client";

import { useEffect } from "react";

import { metricScopeFromExplainer } from "@/components/insights/coach-metric-scope";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { useTranslations } from "@/lib/i18n/context";

/**
 * Register a page's metric as the Coach launch context's ambient scope while
 * the page is mounted, so the global FAB opens a conversation narrowed to it
 * with a data-aware seed question. A metric with no Coach source leaves the
 * FAB on its default snapshot; `undefined` registers nothing. The cleanup
 * lifts the scope on navigation away. Shared by `SubPageShell` and the
 * domain pages Insights hosts (workouts).
 */
export function useCoachMetricScope(metric: string | undefined): void {
  const { t } = useTranslations();
  const registerScope = useCoachLaunch()?.registerScope;
  useEffect(() => {
    if (!metric || !registerScope) return;
    const resolved = metricScopeFromExplainer(metric);
    if (!resolved) return;
    return registerScope(
      {
        metric: resolved.metric,
        also: resolved.also,
        window: resolved.window,
      },
      // The question is an i18n key, resolved so the composer seed reads in
      // the user's language.
      t(resolved.question),
    );
  }, [metric, registerScope, t]);
}
