"use client";

import { useTranslations } from "@/lib/i18n/context";
import { BackLink } from "@/components/ui/back-link";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { ScoreTrendChartDynamic } from "@/components/insights/derived/score-history";

/**
 * v1.42 — `/insights/health-score`, the health score over time.
 *
 * The score itself, with its pillars, lives in the Insights overview's hero
 * band; this page is where it can be followed day by day. Each point is the
 * score as it was shown that day (its stored day row), and opens that day.
 * Reached from the score panel's history link and from the score tile in the
 * day view.
 */
export default function HealthScoreHistoryPage() {
  const { t } = useTranslations();
  const title = t("insights.healthScore.label");

  return (
    <SubPageShell
      title={t("insights.scoreHistory.healthTitle")}
      description={t("insights.scoreHistory.healthDescription")}
      backLink={
        <BackLink
          href="/insights"
          label={t("insights.subPage.scoresBack")}
          dataSlot="health-score-back"
        />
      }
    >
      <ScoreTrendChartDynamic
        score="HEALTH_SCORE"
        chartKey="scoreHealth"
        color="var(--chart-1)"
        label={title}
      />
    </SubPageShell>
  );
}
