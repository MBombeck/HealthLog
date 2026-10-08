"use client";

import { useTranslations } from "@/lib/i18n/context";
import { MoodExplainerIcon } from "./mood-explainer-icon";
import {
  PatternDismissButton,
  PatternDismissedNotice,
  usePatternDismissalOverrides,
} from "@/components/insights/pattern-dismiss-action";

/**
 * v1.11.5 (F3) — FDR-controlled discovered mood relations.
 *
 * Surfaces the slice of the all-pairs correlation-discovery engine
 * (`/api/insights/correlations`) that involves mood — both
 * "behaviour today → next-day mood" (mood promoted to an OUTCOME channel in
 * this release) and "mood today → next-day outcome". Only pairs that survive
 * the Benjamini-Hochberg false-discovery correction the engine already
 * applies are returned, so this is the statistically-defensible complement
 * to the descriptive influence / better-days surfaces.
 *
 * v1.12.7 — the surface is now a header-less subsection rendered INSIDE the
 * merged "What stands out" card (see `mood-insights-sections.tsx`). The owning
 * card runs the correlation-discovery fetch once and passes the mood pairs in;
 * this component is a pure renderer that paints the list (or returns nothing
 * when no pair cleared the bar). The former muted explainer paragraph is gone:
 * the statistical caveat rides a single info-icon tooltip beside the
 * subsection heading, and every finding renders in the standard foreground
 * text colour. Observational only.
 */

export interface DiscoveredCorrelation {
  behaviour: string;
  outcome: string;
  n: number;
  r: number;
  pValue: number;
  qValue: number;
  interpretation: string;
  lagDays: number;
  behaviourLabel?: string;
  outcomeLabel?: string;
  patternId?: string;
  canonicalKey?: string;
  dismissed?: boolean;
}

export interface CorrelationDiscoveryResponse {
  discovered: DiscoveredCorrelation[];
  pairsTested: number;
  fdrQ: number;
  minPairs: number;
}

/** Map a discovery channel key to its localized measurement-type label. */
const CHANNEL_LABEL_KEY: Record<string, string> = {
  TIME_IN_DAYLIGHT: "measurements.typeTimeInDaylight",
  BLOOD_GLUCOSE: "measurements.typeBloodGlucose",
  BLOOD_PRESSURE_SYS: "measurements.typeBloodPressure",
  ACTIVITY_STEPS: "measurements.typeSteps",
  SLEEP_DURATION: "measurements.typeSleep",
  HEART_RATE_VARIABILITY: "measurements.typeHeartRateVariability",
  RESTING_HEART_RATE: "measurements.typeRestingHeartRate",
  WEIGHT: "measurements.typeWeight",
  // v1.25 (W-ENV) — environmental-exposure channels, so a "daylight → mood"
  // relation reads with its descriptive label instead of the raw ENV_ key.
  ENV_TEMP_MEAN: "environment.fields.tempMean",
  ENV_TEMP_MIN: "environment.fields.tempMin",
  ENV_SUNSHINE: "environment.fields.sunshine",
  ENV_DAYLIGHT: "environment.fields.daylight",
  ENV_PRECIP: "environment.fields.precip",
  ENV_PRESSURE_MEAN: "environment.fields.pressureMean",
  ENV_PRESSURE_DELTA: "environment.fields.pressureDelta",
  // v1.42 (#615) — the air-quality channels.
  ENV_PM25: "environment.fields.pm25",
  ENV_OZONE_8H: "environment.fields.ozone8h",
  ENV_POLLEN_MAX: "environment.fields.pollenMax",
};

/** Keep only the discovered pairs that involve the mood channel. */
export function moodPairsOf(
  discovered: DiscoveredCorrelation[],
): DiscoveredCorrelation[] {
  return discovered.filter(
    (pair) => pair.behaviour === "MOOD" || pair.outcome === "MOOD",
  );
}

export function MoodDiscoveredRelations({
  pairs,
  pairsTested,
}: {
  pairs: DiscoveredCorrelation[];
  pairsTested: number;
}) {
  const { t } = useTranslations();
  const dismissal = usePatternDismissalOverrides();

  if (pairs.length === 0) return null;

  return (
    // v1.12.7 — header-less subsection. The merged "What stands out" card owns
    // the single TileHeader; this block leads with a compact subsection label
    // plus the statistical-caveat explainer icon (the false-discovery footer +
    // observational disclaimer fold into the one tooltip) so the surface stops
    // spending a muted paragraph on a footnote.
    <div data-slot="mood-discovered-relations" className="space-y-1">
      {/* <sm stacks the caveat caption under the subheading — beside a
          2-line heading it wrapped to 9 lines at ~58 % of the row width on
          phone viewports. */}
      <div className="text-foreground flex flex-col gap-1 text-sm font-medium sm:flex-row sm:items-center sm:gap-1.5">
        <span>{t("insights.mood.discovery.subheading")}</span>
        <MoodExplainerIcon
          label={t("insights.mood.discovery.explainerLabel")}
          detail={`${t("insights.mood.discovery.footer", {
            tested: pairsTested,
          })} ${t("insights.mood.discovery.disclaimer")}`}
        />
      </div>
      <ul className="divide-border divide-y">
        {pairs.map((pair) => {
          const patternId = pair.patternId;
          const moodIsOutcome = pair.outcome === "MOOD";
          const channelKey = moodIsOutcome ? pair.behaviour : pair.outcome;
          const dynamicLabel = moodIsOutcome
            ? pair.behaviourLabel
            : pair.outcomeLabel;
          const factorLabel =
            dynamicLabel ?? t(CHANNEL_LABEL_KEY[channelKey] ?? channelKey);
          if (
            patternId &&
            dismissal.isDismissed(patternId, pair.dismissed === true)
          ) {
            return (
              <li key={pair.canonicalKey ?? patternId} className="py-2">
                <PatternDismissedNotice
                  compact
                  patternId={patternId}
                  onRestored={() => dismissal.setDismissed(patternId, false)}
                  onSettled={() => dismissal.clearDismissed(patternId, false)}
                />
              </li>
            );
          }
          const up = pair.r >= 0;
          const sentenceKey = moodIsOutcome
            ? up
              ? "insights.mood.discovery.moodUp"
              : "insights.mood.discovery.moodDown"
            : up
              ? "insights.mood.discovery.outcomeUp"
              : "insights.mood.discovery.outcomeDown";
          return (
            <li
              key={`${pair.behaviour}->${pair.outcome}`}
              className="flex flex-col gap-1 py-2 text-sm"
              data-slot="mood-discovered-pair"
              data-mood-role={moodIsOutcome ? "outcome" : "behaviour"}
              data-direction={up ? "up" : "down"}
            >
              {/* The {n} paired days · r · q numeric detail rides an explainer
                  caption beside the finding on ≥sm; on phone widths it stacks
                  below the sentence instead of squeezing to a 4-line sliver
                  at ~25 % of the row. The finding itself reads in the
                  standard foreground colour. */}
              <span className="text-foreground flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-1.5">
                <span>{t(sentenceKey, { factor: factorLabel })}</span>
                <MoodExplainerIcon
                  label={t("insights.mood.discovery.statLabel")}
                  detail={t("insights.mood.discovery.stat", {
                    n: pair.n,
                    r: pair.r.toFixed(2),
                    q: pair.qValue.toFixed(3),
                  })}
                />
              </span>
              {patternId ? (
                <PatternDismissButton
                  patternId={patternId}
                  onDismissed={() => dismissal.setDismissed(patternId, true)}
                  onSettled={() => dismissal.clearDismissed(patternId, true)}
                  className="self-start"
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
