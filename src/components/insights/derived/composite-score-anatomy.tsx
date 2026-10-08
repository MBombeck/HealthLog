"use client";

import { Sparkles } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { useDerivedMetric } from "./use-derived-metric";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { InsightStatusCard } from "@/components/insights/insight-status-card";
import type {
  ReadinessValue,
  SleepScoreValue,
  WellnessScoreValue,
} from "@/lib/insights/derived";
import {
  ScoreAnatomyView,
  type AnatomyContributor,
} from "./score-anatomy-view";
import type { RingHue } from "./ring-hues";
import type { CoachLaunchScope } from "@/lib/insights/coach-launch-context";
import { METRIC_PROVENANCE } from "./standards";
import { ScoreHistoryCard, ScoreHistoryChart } from "./score-history";

/**
 * v1.10.0 — the data-bound wrapper that fetches a composite/persisted derived
 * score and renders the reusable `ScoreAnatomyView`. It owns the per-metric
 * presentation map (title, contributor labels, the cited standard, the
 * plain-language method) so the anatomy view itself stays
 * metric-agnostic.
 *
 * Supports the two decomposable W3 composites (`SLEEP_SCORE`, `READINESS` —
 * each maps its sub-scores onto ranked `AnatomyContributor` rows) AND the
 * three persisted nightly scores (`RECOVERY_SCORE`, `STRESS_SCORE`,
 * `STRAIN_SCORE`). The persisted scores carry no sub-decomposition, so they
 * render the ring + coverage + the provenance surface (method + cited
 * standard) with no contributor rows — the acceptance-criterion fix that gives
 * every wellness ring a provenance surface instead of a read-only dead-end.
 *
 * The standard + method keys come from the single `METRIC_PROVENANCE`
 * source map so the citation a metric exposes never drifts across surfaces.
 *
 * Client-only: `import type` for the value shapes (no server graph leaks);
 * the fetch rides the same `/api/insights/derived` route + 8 s client
 * ceiling as the rest of the surface.
 */

export type AnatomyMetricId =
  | "SLEEP_SCORE"
  | "READINESS"
  | "RECOVERY_SCORE"
  | "STRESS_SCORE"
  | "STRAIN_SCORE";

export interface CompositeScoreAnatomyProps {
  metric: AnatomyMetricId;
  className?: string;
}

/**
 * v1.15.12 F1 — each anatomy metric maps to the same ring hue its dashboard
 * tile wears, so the detail card carries the matching tint + the ring arc
 * leans the same colour (continuity from the tile tap). Mirrors the per-metric
 * `hue` the wellness strip passes its `RingTile`s.
 */
/**
 * v1.31.0 — the Coach scope each derived-score sheet hands off to.
 *
 * Every list below mirrors the score engine's real contributor domains:
 * Sleep Score reads only sleep-stage rows; Readiness blends RHR, HRV, sleep,
 * respiratory rate, and mood; Stress is derived only from HRV; and Strain uses
 * workout HR series plus active energy and the separately loaded resting HR.
 *
 * Recovery is source-dependent. A COMPUTED row is the Readiness blend
 * verbatim, while a canonical native WHOOP / Oura / Polar row is the vendor's
 * already-computed score and exposes no reconstructable input domain through
 * the launch DTO. Its static scope is therefore the conservative union of the
 * actual reconstructable contributors: the five Readiness domains, with no
 * guessed native-only sources.
 */
const METRIC_COACH_SCOPE: Record<AnatomyMetricId, CoachLaunchScope> = {
  SLEEP_SCORE: { metric: "sleep" },
  READINESS: {
    metric: "hrv",
    also: ["resting_hr", "sleep", "respiratory_rate", "mood"],
    window: "last7days",
  },
  RECOVERY_SCORE: {
    metric: "hrv",
    also: ["resting_hr", "sleep", "respiratory_rate", "mood"],
    window: "last7days",
  },
  STRESS_SCORE: { metric: "hrv", window: "last7days" },
  STRAIN_SCORE: {
    metric: "workouts",
    also: ["active_energy", "resting_hr"],
    window: "last7days",
  },
};

const METRIC_HUE: Record<AnatomyMetricId, RingHue> = {
  SLEEP_SCORE: "sleep",
  READINESS: "readiness",
  RECOVERY_SCORE: "recovery",
  STRESS_SCORE: "stress",
  STRAIN_SCORE: "strain",
};

export function CompositeScoreAnatomy({
  metric,
  className,
}: CompositeScoreAnatomyProps) {
  const { t } = useTranslations();

  const query = useDerivedMetric<
    SleepScoreValue | ReadinessValue | WellnessScoreValue
  >(metric);

  if (query.isLoading) {
    return (
      <div data-slot="composite-anatomy-loading" className={className}>
        <Skeleton className="h-[28rem] w-full rounded-xl" />
      </div>
    );
  }

  const data = query.data;
  const meta = METRIC_PROVENANCE[metric];
  const standard = meta.standard;
  const title = titleFor(metric, t);

  // STRAIN frames itself by the ACTUAL anchor that produced this score: once
  // the user has enough history it is judged against their own typical effort
  // (`personal`); during cold start it falls back to a general reference
  // (`population`). The base method copy stays anchor-neutral; this line makes
  // the displayed framing honest per-score. `null` (RECOVERY / STRESS, or no
  // cache row yet) renders nothing.
  let anchorLine: string | null = null;
  if (metric === "STRAIN_SCORE" && data?.status === "ok" && data.value) {
    const anchor = (data.value as WellnessScoreValue).anchor;
    if (anchor === "personal") {
      anchorLine = t("insights.derived.composite.STRAIN_SCORE.anchorPersonal");
    } else if (anchor === "population") {
      anchorLine = t(
        "insights.derived.composite.STRAIN_SCORE.anchorPopulation",
      );
    }
  }

  // v1.42 — the per-score "descriptive proxy, not clinical" line that sat
  // above the method in warning colour is gone: it repeated on every score
  // page what the method and the page explainer already say, and read as an
  // alarm. The method copy closes the card on its own.
  const method = (
    <>
      {t(meta.methodKey)}
      {anchorLine ? <span className="mt-1 block">{anchorLine}</span> : null}
    </>
  );

  if (query.isError) {
    // A failed read is not "insufficient data": the score may well exist.
    // Say it failed and offer a retry instead of an empty anatomy.
    return (
      <div className={className}>
        <QueryErrorRow
          slot="composite-anatomy-error"
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  }

  if (!data) {
    // Settled without a payload — render the insufficient state honestly.
    return (
      <ScoreAnatomyView
        title={title}
        score={null}
        hue={METRIC_HUE[metric]}
        contributors={[]}
        coverage={{
          requiredInputs: 1,
          presentInputs: 0,
          historyDays: 0,
          missing: [],
        }}
        confidence={null}
        provenance={{
          inputs: [],
          source: "none",
          windowDays: 0,
          computedAt: new Date().toISOString(),
        }}
        method={method}
        standard={standard}
        insufficient
        className={className}
      />
    );
  }

  const insufficient = data.status !== "ok";
  let score: number | null = null;
  let contributors: AnatomyContributor[] = [];
  let caption: string | undefined;

  if (data.status === "ok" && data.value) {
    if (metric === "SLEEP_SCORE") {
      const v = data.value as SleepScoreValue;
      score = v.score;
      caption = t(`insights.derived.scoreRing.band.${v.band}`);
      contributors = v.subScores
        .map((s) => ({
          key: s.key,
          label: t(`insights.derived.composite.SLEEP_SCORE.sub.${s.key}`),
          value: s.value,
          weight: s.weight,
        }))
        .sort(rankByImpact);
    } else if (metric === "READINESS") {
      const v = data.value as ReadinessValue;
      score = v.score;
      caption = t(`insights.derived.scoreRing.band.${v.band}`);
      contributors = v.components
        .map((c) => ({
          key: c.key,
          label: t(`insights.derived.composite.READINESS.component.${c.key}`),
          value: c.value,
          weight: c.weight,
        }))
        .sort(rankByImpact);
    } else {
      // Persisted nightly score — ring + provenance. RECOVERY additionally
      // carries the readiness-blend factor decomposition (v1.27.5, resolved
      // server-side by the same engine that mints the nightly score), so it
      // renders the same ranked contributor rows as the composites. The
      // factor set IS the readiness component set, so the labels reuse the
      // READINESS component keys verbatim. STRESS / STRAIN stay row-less.
      const v = data.value as WellnessScoreValue;
      score = v.score;
      caption = t(`insights.derived.scoreRing.band.${v.band}`);
      if (metric === "RECOVERY_SCORE" && v.components) {
        contributors = v.components
          .map((c) => ({
            key: c.key,
            label: t(`insights.derived.composite.READINESS.component.${c.key}`),
            value: c.value,
            weight: c.weight,
          }))
          .sort(rankByImpact);
      }
    }
  }

  // v1.15.12 B3 — the per-score AI assessment ("why is this score what it is")
  // already rides the single `/api/insights/derived` route as `data.assessment`
  // (shipped to iOS in v1.13.2); the web simply discarded it. Render it BELOW
  // the anatomy card, reusing the same `<InsightStatusCard>` the metric
  // sub-pages mount so it reads identically. The route always populates a
  // non-empty assessment when the score `status === "ok"` (the deterministic
  // template at minimum, warmer AI prose when a provider is configured), so a
  // present `assessment` implies a real text — `hasProvider` is held true and
  // the card always renders its prose rather than the no-provider fallback.
  const assessment = data.assessment;

  // v1.42 — the score's course, right under its card. A stored nightly score
  // gets the full chart; a composite draws the course its value carries.
  const series =
    data.status === "ok" && data.value
      ? (data.value as { series?: number[] }).series
      : undefined;
  // Only beside a score: an account without one gets the honest
  // insufficient card, not an empty chart under it.
  const history =
    data.status !== "ok" ? null : metric === "RECOVERY_SCORE" ||
      metric === "STRESS_SCORE" ||
      metric === "STRAIN_SCORE" ? (
      <ScoreHistoryChart type={metric} hue={METRIC_HUE[metric]} />
    ) : series && series.length >= 2 ? (
      <ScoreHistoryCard
        series={series}
        windowDays={data.provenance.windowDays}
        hue={METRIC_HUE[metric]}
      />
    ) : null;

  return (
    <div className="space-y-3">
      <ScoreAnatomyView
        title={title}
        score={score}
        hue={METRIC_HUE[metric]}
        caption={caption}
        contributors={contributors}
        coverage={data.coverage}
        confidence={data.confidence}
        provenance={data.provenance}
        method={method}
        standard={standard}
        insufficient={insufficient}
        className={className}
      />
      {history}
      {assessment ? (
        <InsightStatusCard
          title={t("insights.assessmentTitle")}
          icon={<Sparkles className="h-5 w-5" />}
          text={assessment.text}
          hasProvider
          // Composed from the numbers; the server swaps in model text only
          // while `statusText` is available, so the card shows either way.
          aiAuthored={false}
          updatedAt={assessment.updatedAt}
          // The outbound edge. Same shared opener + auto-send hand-off the
          // metric pages use, so the answer lands directly instead of only
          // seeding the composer.
          coachQuestion={t("insights.coach.assessmentPrompt", {
            metric: title,
          })}
          coachScope={METRIC_COACH_SCOPE[metric]}
          coachAutoSend
        />
      ) : null}
    </div>
  );
}

/** Localised title per metric — composites use their existing copy keys;
 *  the persisted scores reuse the wellness-strip labels. */
function titleFor(metric: AnatomyMetricId, t: (key: string) => string): string {
  switch (metric) {
    case "SLEEP_SCORE":
    case "READINESS":
      return t(`insights.derived.composite.${metric}.title`);
    case "RECOVERY_SCORE":
      return t("insights.derived.scores.recovery");
    case "STRESS_SCORE":
      return t("insights.derived.scores.stress");
    case "STRAIN_SCORE":
      return t("insights.derived.scores.strain");
  }
}

/** Rank contributors by impact: present-and-higher-weight first. */
function rankByImpact(a: AnatomyContributor, b: AnatomyContributor): number {
  const aPresent = a.value != null ? 1 : 0;
  const bPresent = b.value != null ? 1 : 0;
  if (aPresent !== bPresent) return bPresent - aPresent;
  return b.weight - a.weight;
}
