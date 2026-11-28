"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { BackLink } from "@/components/ui/back-link";
import { Skeleton } from "@/components/ui/skeleton";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import {
  HealthScoreCard,
  HealthScoreCardSkeleton,
} from "@/components/insights/health-score-card";
import {
  CompositeScoreAnatomy,
  type AnatomyMetricId,
} from "@/components/insights/derived/composite-score-anatomy";
import { ScoreTrendChartDynamic } from "@/components/insights/derived/score-history";
import {
  DEVICE_RECOVERY_LABEL_KEYS,
  deviceSourceOf,
  useScoreRows,
} from "@/components/insights/recovery/device-score-rows";
import { useAnalyticsQuery } from "@/lib/queries/use-analytics-query";
import { useDashboardSnapshot } from "@/lib/queries/use-dashboard-snapshot";
import type { InsightsAnalyticsData } from "@/types/analytics";
import { metricHref } from "@/lib/links/hrefs";

/**
 * `/insights/scores/<metric>` — a score's own page.
 *
 * Every score page reads in one order, the app's too: the assessment, then
 * what counts (the factors with their weights, or one sentence for a score
 * without parts), then the course. Readiness and the sleep score open their
 * anatomy; stress and strain open theirs, labelled by the server's `origin`.
 * `health` carries the Health score panel (its explanation lines, the
 * pillars with their weights, the method) above its day-by-day course.
 *
 * `recovery` has no page of its own any more. The web drew the readiness
 * HealthLog stores each night as a second ring beside the live readiness,
 * the same blend under another name; a device's own recovery lives on
 * "Device scores". The slug therefore sends an account with a device's
 * recovery there and everyone else to readiness, so a saved link or a day
 * view tile never dead-ends. An unknown slug falls back to readiness.
 */

const SLUG_TO_METRIC: Record<string, AnatomyMetricId> = {
  sleep: "SLEEP_SCORE",
  readiness: "READINESS",
  stress: "STRESS_SCORE",
  strain: "STRAIN_SCORE",
};

/**
 * The explainer-body key suffix per score, feeding
 * `insights.subPage.explainer.<suffix>Body` through `SubPageShell`'s
 * `explainerMetric` prop. `SLEEP_SCORE` uses a distinct `sleepScore` suffix
 * so it never collides with the `sleep` metric's own explainer body.
 */
const EXPLAINER_METRIC: Partial<Record<AnatomyMetricId, string>> = {
  SLEEP_SCORE: "sleepScore",
  READINESS: "readiness",
  STRESS_SCORE: "stress",
  STRAIN_SCORE: "strain",
};

/**
 * Localised page title per metric. No sentence under it: the method is in the
 * score card ("How the score is made"), once.
 */
const HEADER_KEYS: Partial<Record<AnatomyMetricId, { title: string }>> = {
  SLEEP_SCORE: {
    title: "insights.derived.composite.SLEEP_SCORE.title",
  },
  READINESS: {
    title: "insights.derived.composite.READINESS.title",
  },
  STRESS_SCORE: {
    title: "insights.derived.scores.stress",
  },
  STRAIN_SCORE: {
    title: "insights.derived.scores.strain",
  },
};

export default function CompositeScorePage() {
  const params = useParams<{ metric: string }>();
  const slug = typeof params.metric === "string" ? params.metric : "";
  if (slug === "health") return <HealthScorePage />;
  if (slug === "recovery") return <RecoveryRedirect />;
  return <AnatomyPage metric={SLUG_TO_METRIC[slug] ?? "READINESS"} />;
}

function ScoresBackLink({ slot }: { slot: string }) {
  const { t } = useTranslations();
  return (
    <BackLink
      href="/insights"
      label={t("insights.subPage.scoresBack")}
      dataSlot={slot}
    />
  );
}

function AnatomyPage({ metric }: { metric: AnatomyMetricId }) {
  const { t } = useTranslations();
  const header = HEADER_KEYS[metric] ?? HEADER_KEYS.READINESS!;
  return (
    <SubPageShell
      title={t(header.title)}
      explainerMetric={EXPLAINER_METRIC[metric]}
      backLink={<ScoresBackLink slot="composite-score-back" />}
      coachLaunch
    >
      <CompositeScoreAnatomy metric={metric} />
    </SubPageShell>
  );
}

/**
 * The Health score's page: the panel as it stood on the Insights overview,
 * then its course. The panel's tension and return-to-baseline lines come
 * from the dashboard snapshot, as they did there.
 */
function HealthScorePage() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const analyticsQuery = useAnalyticsQuery();
  const analytics = analyticsQuery.data as InsightsAnalyticsData | undefined;
  const report = analytics?.healthScore ?? null;
  const snapshot = useDashboardSnapshot(isAuthenticated);
  const snapshotScore = snapshot.data?.healthScore ?? null;
  const label = t("insights.healthScore.label");

  return (
    <SubPageShell
      title={label}
      backLink={<ScoresBackLink slot="health-score-back" />}
    >
      <div data-slot="health-score-page" className="space-y-3">
        {report ? (
          <HealthScoreCard
            report={report}
            tension={snapshotScore?.tension ?? null}
            returnToBand={snapshotScore?.returnToBand ?? null}
            onRetry={() => void analyticsQuery.refetch()}
          />
        ) : analyticsQuery.isPending ? (
          <HealthScoreCardSkeleton />
        ) : null}
        <ScoreTrendChartDynamic
          score="HEALTH_SCORE"
          chartKey="scoreHealth"
          color="var(--chart-1)"
          label={label}
        />
      </div>
    </SubPageShell>
  );
}

/** Sends the retired recovery slug where the account's recovery lives. */
function RecoveryRedirect() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  const rows = useScoreRows("RECOVERY_SCORE", isAuthenticated);
  const settled = rows.isSuccess || rows.isError;
  const target =
    rows.isSuccess &&
    deviceSourceOf(rows.data, DEVICE_RECOVERY_LABEL_KEYS) !== null
      ? metricHref("recovery")
      : metricHref("readiness");

  useEffect(() => {
    if (settled && target) router.replace(target);
  }, [settled, target, router]);

  return (
    <div data-slot="recovery-score-redirect" className="space-y-3">
      <Skeleton className="h-[28rem] w-full rounded-xl" />
    </div>
  );
}
