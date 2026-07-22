"use client";

import { Droplet, Loader2 } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";
import { GlucoseClinicalPanel } from "@/components/insights/glucose/glucose-clinical-panel";
import { useAuth } from "@/hooks/use-auth";
import { useModulePageGuard } from "@/hooks/use-module-page-guard";
import { useTranslations } from "@/lib/i18n/context";
import { resolveGlucoseUnit } from "@/lib/glucose";

/**
 * v1.7.0 — `/insights/blood-glucose`.
 *
 * BLOOD_GLUCOSE sub-page. Reuses the generic HealthKitMetricPage scaffold;
 * the chart daily-aggregates through the rollup read path. Empty-state
 * carries no manual-entry CTA — the series arrives from Apple Health or
 * Withings sync.
 *
 * v1.16.16 — glucose unit-at-source. The chart + stat strip honour the
 * user's `glucoseUnit` preference: stored canonical mg/dL is converted to
 * mmol/L (÷18.0182, 1-decimal) for mmol/L-preference users via the chart's
 * `valueScale` (which the page also folds into the stat-strip summary), so
 * the detail page reads in the SAME unit as the series DTO, CSV, and FHIR
 * exports. mg/dL-preference users are unaffected (scale = 1, integer
 * precision).
 */
const MGDL_PER_MMOL = 18.0182;

export default function InsightsBlutzuckerPage() {
  const { user } = useAuth();
  const { t } = useTranslations();
  const { ready } = useModulePageGuard("glucose");
  const glucoseUnit = resolveGlucoseUnit(user?.glucoseUnit ?? null);
  const isMmol = glucoseUnit === "mmol/L";

  // v1.18.0 B1 — bounce a direct URL hit on a disabled-glucose account.
  if (!ready) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  return (
    <HealthKitMetricPage
      measurementType="BLOOD_GLUCOSE"
      statusMetric="BLOOD_GLUCOSE"
      insightMetric="BLOOD_GLUCOSE"
      chartKey="bloodGlucose"
      i18nPrefix="insights.bloodGlucose"
      explainerMetric="bloodGlucose"
      color="var(--chart-3)"
      unit={glucoseUnit}
      yAxisUnit={glucoseUnit}
      // mmol/L = mg/dL ÷ 18.0182; the chart's valueScale multiplies, so pass
      // the reciprocal. mg/dL keeps identity scale (1).
      valueScale={isMmol ? 1 / MGDL_PER_MMOL : 1}
      // Integer mg/dL readings; one decimal for the mmol/L SI scale.
      statFractionDigits={isMmol ? 1 : 0}
      statMedianLabel={t("insights.bloodGlucose.medianLabel")}
      emptyStateIcon={<Droplet className="size-6" />}
      emptyStateCtaType={null}
      captureType="BLOOD_GLUCOSE"
      targetSummarySlug="blood-glucose"
      afterChart={<GlucoseClinicalPanel />}
      coachPrefill="I haven't logged any blood glucose yet — what does this metric tell me about my health, and how do I improve it?"
    />
  );
}
