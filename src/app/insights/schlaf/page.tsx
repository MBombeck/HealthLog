"use client";

import Link from "next/link";
import { Moon } from "lucide-react";

import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import { useTranslations } from "@/lib/i18n/context";
import { Button } from "@/components/ui/button";
import { CoachLaunchButton } from "@/components/insights/coach-launch-button";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { SleepOverview } from "@/components/insights/sleep-overview";
import { SubPageShell } from "@/components/insights/sub-page-shell";

/**
 * v1.4.25 W4c — `/insights/schlaf`.
 *
 * The Sleep sub-page surfaces the per-stage breakdown + duration trend
 * the v1.4.23 schema gained but never rendered. All charts live inside
 * `<SleepOverview>` so the page-level scaffold stays trivial; data
 * fetches and empty-state handling are encapsulated in the component.
 *
 * v1.4.27 F17 — when `summaries.SLEEP_DURATION.count === 0` (no
 * Apple-Health / Withings sleep rows yet), the page short-circuits
 * to an empty-state CTA pointing at `/settings/data-sources` so the
 * user can connect a sleep source.
 *
 * v1.4.28 R3d (BK-F-H1 + BK-F-M1) — analytics fetch + empty-state
 * render consume the shared hook + primitive.
 */
export default function InsightsSchlafPage() {
  const { t } = useTranslations();

  const { isEmpty } = useInsightsAnalytics("SLEEP_DURATION");

  if (isEmpty) {
    return (
      <SubPageShell
        title={t("insights.sleep.title")}
        description={t("insights.sleep.description")}
      >
        <MetricEmptyState
          icon={<Moon className="size-6" />}
          title={t("insights.emptyState.sleep.title")}
          description={t("insights.emptyState.sleep.description")}
          cta={
            <Button size="sm" asChild>
              <Link href="/settings/data-sources">
                {t("insights.emptyState.sleep.cta")}
              </Link>
            </Button>
          }
          coachPrefill="I don't have any sleep data yet — why does sleep tracking matter, and what should I know before I connect a source?"
        />
      </SubPageShell>
    );
  }

  return (
    <SubPageShell
      title={t("insights.sleep.title")}
      description={t("insights.sleep.description")}
    >
      <SleepOverview />

      {/*
        v1.4.28 (BK-UI-StatusSchlaf) — the six sibling sub-pages all
        mount `<InsightStatusCard>` underneath the chart so the user
        sees a written per-section assessment. Sleep has no
        `/api/insights/sleep-status` route yet (the v1.4.23 schema
        landed the data but the assessment-generation pass was deferred
        to the v1.5 iOS sprint where the Apple-Health sleep snapshot
        will inform the prompt). No per-section assessment yet; the
        structural slot waits for v1.5 where the route + hook key will
        wire in.
      */}

      <CoachLaunchButton />
    </SubPageShell>
  );
}
