"use client";

import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { resolveIntlLocale } from "@/lib/format-locale";
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
import { RING_GRADIENT, type RingHue } from "./ring-hues";
import type { ScoreBand } from "./band-tokens";
import type { CoachLaunchScope } from "@/lib/insights/coach-launch-context";
import { METRIC_PROVENANCE } from "./standards";
import { ScoreHistoryChart, ScoreTrendChartDynamic } from "./score-history";
import type { ChartOverlayKey } from "@/lib/dashboard/chart-overlay-prefs";

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
 * v1.15.12 — each anatomy metric maps to the same ring hue its dashboard
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

/** The slot each score page remembers its history chart's range tab under. */
const METRIC_CHART_KEY: Record<AnatomyMetricId, ChartOverlayKey> = {
  SLEEP_SCORE: "scoreSleep",
  READINESS: "scoreReadiness",
  RECOVERY_SCORE: "scoreRecovery",
  STRESS_SCORE: "scoreStress",
  STRAIN_SCORE: "scoreStrain",
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
  const { t, locale } = useTranslations();
  const fmt = useFormatters();

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
  // Strain served from the device's own day strain (no computed proxy in the
  // window): the card says so, and the course below charts that same series.
  const deviceStrain =
    metric === "STRAIN_SCORE" && data?.status === "ok" && data.value
      ? ((data.value as WellnessScoreValue).device ?? null)
      : null;
  if (deviceStrain) {
    anchorLine = t("insights.derived.composite.STRAIN_SCORE.deviceSource");
  } else if (metric === "STRAIN_SCORE" && data?.status === "ok" && data.value) {
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
  // Served from the device, the proxy's method does not describe the number
  // on the card; the device line does, on its own.
  const method = methodNode(
    metric,
    deviceStrain ? null : t(meta.methodKey),
    anchorLine,
    t,
  );

  if (query.isError) {
    // A failed read is not "insufficient data": the score may well exist.
    // Say it failed and offer a retry instead of an empty anatomy.
    return (
      <div className={className}>
        <QueryErrorRow
          error={query.error}
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
  // A stale readiness: see `readinessHead`.
  let staleLabel: string | undefined;
  let contributorsHeading: string | undefined;

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
          missingLabel:
            s.gap === "few_nights"
              ? t("insights.derived.composite.SLEEP_SCORE.gap.fewNights", {
                  count: v.rhythmNights ?? 0,
                  needed: v.rhythmMinNights,
                })
              : s.gap === "no_main_sleep"
                ? t("insights.derived.composite.SLEEP_SCORE.gap.noMainSleep")
                : undefined,
        }))
        .sort(rankByImpact);
    } else if (metric === "READINESS") {
      const v = data.value as ReadinessValue;
      ({ score, caption, staleLabel, contributorsHeading } = readinessHead(
        v,
        title,
        t,
        fmt.dateShortSmartCalendar,
      ));
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
      caption = persistedCaption(metric, v, t, resolveIntlLocale(locale));
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

  // v1.15.12 — the per-score AI assessment ("why is this score what it is")
  // already rides the single `/api/insights/derived` route as `data.assessment`
  // (shipped to iOS in v1.13.2); the web simply discarded it. Render it BELOW
  // the anatomy card, reusing the same `<InsightStatusCard>` the metric
  // sub-pages mount so it reads identically. The route always populates a
  // non-empty assessment when the score `status === "ok"` (the deterministic
  // template at minimum, warmer AI prose when a provider is configured), so a
  // present `assessment` implies a real text — `hasProvider` is held true and
  // the card always renders its prose rather than the no-provider fallback.
  const assessment = data.assessment;

  // v1.42 — the score's course under its card, with the range tabs. A stored
  // nightly score charts its readings; readiness and the sleep score chart
  // the score-history route's daily history. Only beside a score: an account
  // without one gets the insufficient card, not an empty chart.
  const history =
    data.status !== "ok" ? null : metric === "RECOVERY_SCORE" ||
      metric === "STRESS_SCORE" ||
      metric === "STRAIN_SCORE" ? (
      <ScoreHistoryChart
        type={deviceStrain ? "DAY_STRAIN" : metric}
        hue={METRIC_HUE[metric]}
        chartKey={METRIC_CHART_KEY[metric]}
      />
    ) : (
      <ScoreTrendChartDynamic
        score={metric}
        chartKey={METRIC_CHART_KEY[metric]}
        color={RING_GRADIENT[METRIC_HUE[metric]][1]}
        label={title}
      />
    );

  return (
    <div className="space-y-3">
      <ScoreAnatomyView
        title={title}
        score={score}
        band={staleLabel ? undefined : serverBand(data)}
        hue={METRIC_HUE[metric]}
        caption={caption}
        contributors={contributors}
        coverage={data.coverage}
        confidence={data.confidence}
        provenance={data.provenance}
        method={method}
        standard={standard}
        insufficient={insufficient}
        staleLabel={staleLabel}
        contributorsHeading={contributorsHeading}
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
      return t("insights.deviceScores.stress");
    case "STRAIN_SCORE":
      return t("insights.deviceScores.strain");
  }
}

/**
 * The method caption that closes the card: the method itself (absent for a
 * strain served from the device, which its anchor line describes alone), the
 * strain's anchor line, and for readiness and the sleep score the note that
 * they moved onto the one band rule in 1.50 (yellow from 50, red below).
 * Past days recolour with it, so the page says so until 1.51.
 */
function methodNode(
  metric: AnatomyMetricId,
  methodText: string | null,
  anchorLine: string | null,
  t: (key: string, vars?: Record<string, string | number>) => string,
): ReactNode {
  if (methodText === null) return anchorLine;
  const bandNote =
    metric === "READINESS" || metric === "SLEEP_SCORE"
      ? t("insights.scores.bandNote", {
          fair: t("insights.derived.scoreRing.band.yellow"),
          low: t("insights.derived.scoreRing.band.red"),
        })
      : null;
  return (
    <>
      {methodText}
      {anchorLine ? <span className="mt-1 block">{anchorLine}</span> : null}
      {bandNote ? (
        <span data-slot="score-band-note" className="mt-1 block">
          {bandNote}
        </span>
      ) : null}
    </>
  );
}

/**
 * The head of the readiness card. A readiness resting on values from before
 * today is no statement about today: no number, no band, no sentence; the
 * caption says when its values are from ("Last 81 on Nov 24") and the
 * contributors stay under that day.
 */
function readinessHead(
  v: ReadinessValue,
  title: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
  formatDay: (day: string) => string,
): {
  score: number | null;
  caption: string;
  staleLabel: string | undefined;
  contributorsHeading: string | undefined;
} {
  if (v.fresh !== false) {
    return {
      score: v.score,
      caption: t(`insights.derived.scoreRing.band.${v.band}`),
      staleLabel: undefined,
      contributorsHeading: undefined,
    };
  }
  const date = formatDay(v.asOfDay);
  const caption = t("insights.scores.staleLast", {
    score: Math.round(v.score),
    date,
  });
  return {
    score: null,
    caption,
    staleLabel: `${title}. ${caption}`,
    contributorsHeading: t("insights.scores.valuesFrom", { date }),
  };
}

/**
 * The caption under a stored score's ring: the device's own reading on its
 * own scale for a strain the device served, the load words for stress and
 * strain (a heavy stress is "high", never "low"), the band word otherwise.
 */
function persistedCaption(
  metric: AnatomyMetricId,
  v: WellnessScoreValue,
  t: (key: string, vars?: Record<string, string | number>) => string,
  intlLocale: string,
): string {
  if (v.device) {
    return t("insights.derived.composite.STRAIN_SCORE.deviceCaption", {
      value: v.device.value.toLocaleString(intlLocale, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
      max: v.device.scaleMax,
    });
  }
  return metric === "STRESS_SCORE" || metric === "STRAIN_SCORE"
    ? t(`insights.scores.loadBand.${v.band}`)
    : t(`insights.derived.scoreRing.band.${v.band}`);
}

/** Rank contributors by impact: present-and-higher-weight first. */
function rankByImpact(a: AnatomyContributor, b: AnatomyContributor): number {
  const aPresent = a.value != null ? 1 : 0;
  const bPresent = b.value != null ? 1 : 0;
  if (aPresent !== bPresent) return bPresent - aPresent;
  return b.weight - a.weight;
}

/**
 * The server's band for the score, always passed to the ring: stress and
 * strain read the other way round, so a ring left to colour itself from the
 * number would paint a stress of 80 green.
 */
function serverBand(data: { status: string; value?: unknown }) {
  if (data.status !== "ok" || !data.value) return undefined;
  return (data.value as { band?: ScoreBand }).band;
}
