"use client";

import { HeartPulse } from "lucide-react";

import { Card } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { ScoreHistoryChart } from "@/components/insights/derived/score-history";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import {
  POLAR_RECHARGE_SCALE_MAX,
  polarRechargeStatus,
  type DeviceRecovery,
} from "./device-score-rows";

/**
 * The device's own recovery on "Device scores": WHOOP Recovery, Oura
 * Readiness or Polar Nightly Recharge, under the device's name, with the
 * latest value on the device's own scale and its whole course in the chart
 * every metric page carries (7 / 30 / 90 / All, days as doors), read for
 * that source alone so the proxy never fills a day the device missed.
 *
 * Neutral on purpose: a vendor's number gets no HealthLog band and no
 * colour verdict. The device colours its own number in its own app; the
 * readiness HealthLog works out stays on the Insights overview.
 */
export function DeviceRecoveryBlock({
  recovery,
}: {
  recovery: DeviceRecovery;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { source, labelKey, latest } = recovery;

  const shown =
    source === "POLAR"
      ? t("insights.deviceScores.valueOfScale", {
          value: polarRechargeStatus(latest.value),
          max: POLAR_RECHARGE_SCALE_MAX,
        })
      : source === "WHOOP"
        ? fmt.percent(Math.round(latest.value) / 100)
        : String(Math.round(latest.value));

  return (
    <section
      data-slot="device-recovery-block"
      data-source={source}
      className="space-y-3"
    >
      <Card className="gap-4 px-4 md:px-6">
        <TileHeader icon={HeartPulse} title={t(labelKey)} titleAs="h2" />
        <div className="flex items-baseline gap-3">
          <span
            data-slot="device-recovery-value"
            className="text-foreground text-3xl font-semibold tracking-tight tabular-nums"
          >
            {shown}
          </span>
          <span className="text-muted-foreground text-xs">
            {fmt.dateShortSmart(latest.measuredAt)}
          </span>
        </div>
      </Card>
      <ScoreHistoryChart
        type="RECOVERY_SCORE"
        hue="recovery"
        chartKey="scoreRecovery"
        sourceEq={source}
      />
    </section>
  );
}
