"use client";

import { Activity, Flame } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { SectionHeading } from "@/components/ui/section-heading";
import { useDerivedMetric } from "@/components/insights/derived/use-derived-metric";
import {
  RingTile,
  baselineOf,
  historyOf,
} from "@/components/insights/derived/wellness-scores";
// Type-only — the compute payload never drags the server graph into the bundle.
import type { WellnessScoreValue } from "@/lib/insights/derived/wellness-scores";
import { cn } from "@/lib/utils";
import { metricHref } from "@/lib/links/hrefs";

/**
 * "Estimates from HealthLog" on the Device scores page: stress and strain,
 * which HealthLog works out from heart data and no device reports.
 *
 * They left the score rings at the head of Insights in 1.50 and live here,
 * named as estimates and kept apart from what the wearable itself reports.
 * Each ring keeps its server band (both read the other way round: a heavy
 * stress is high, never "good"), its course and its anatomy page.
 *
 * A strain served from the device's own day strain is not an estimate: it
 * is the device's number and already has its block above, so it is left out
 * here. Renders nothing when neither estimate has a value.
 */
export function EstimatesSection() {
  const { t } = useTranslations();
  const stress = useDerivedMetric<WellnessScoreValue>("STRESS_SCORE");
  const strain = useDerivedMetric<WellnessScoreValue>("STRAIN_SCORE");

  const bandWord = (band: WellnessScoreValue["band"]) =>
    // A load reads as a load: a heavy stress is "high", never "low".
    t(`insights.scores.loadBand.${band}`);

  const tiles: React.ReactNode[] = [];
  const stressRead = stress.data;
  if (stressRead?.status === "ok" && stressRead.value) {
    const v = stressRead.value;
    tiles.push(
      <RingTile
        key="STRESS_SCORE"
        score={v.score}
        band={v.band}
        label={t("insights.deviceScores.stress")}
        bandWord={bandWord(v.band)}
        ariaLabel={`${t("insights.deviceScores.stress")}: ${v.score}, ${bandWord(v.band)}`}
        href={metricHref("stress-score") ?? ""}
        metricSlot="STRESS_SCORE"
        hue="stress"
        icon={Activity}
        history={historyOf(stressRead)}
        index={tiles.length}
        animate={false}
        baseline={baselineOf(v.series)}
        titleAs="h3"
      />,
    );
  }
  const strainRead = strain.data;
  if (
    strainRead?.status === "ok" &&
    strainRead.value &&
    !strainRead.value.device
  ) {
    const v = strainRead.value;
    tiles.push(
      <RingTile
        key="STRAIN_SCORE"
        score={v.score}
        band={v.band}
        label={t("insights.deviceScores.strain")}
        bandWord={bandWord(v.band)}
        ariaLabel={`${t("insights.deviceScores.strain")}: ${v.score}, ${bandWord(v.band)}`}
        href={metricHref("strain-score") ?? ""}
        metricSlot="STRAIN_SCORE"
        hue="strain"
        icon={Flame}
        history={historyOf(strainRead)}
        index={tiles.length}
        animate={false}
        baseline={baselineOf(v.series)}
        titleAs="h3"
      />,
    );
  }

  if (tiles.length === 0) return null;

  return (
    <section data-slot="estimates-section" className="space-y-3">
      <SectionHeading
        icon={Activity}
        title={t("insights.deviceScores.estimatesTitle")}
        subtitle={t("insights.deviceScores.estimatesSubtitle")}
      />
      <div
        className={cn(
          "grid grid-cols-1 gap-3",
          tiles.length > 1 && "md:grid-cols-2",
        )}
      >
        {tiles}
      </div>
    </section>
  );
}
