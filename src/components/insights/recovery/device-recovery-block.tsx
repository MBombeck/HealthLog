"use client";

import dynamic from "next/dynamic";
import { HeartPulse } from "lucide-react";

import { Card } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { RING_GRADIENT } from "@/components/insights/derived/ring-hues";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import {
  DEVICE_COURSE_DAYS,
  POLAR_RECHARGE_SCALE_MAX,
  polarRechargeStatus,
  type DeviceRecovery,
} from "./device-score-rows";

// The course loads through the shared chart-runtime boundary, like the score
// tiles' history line, so this block carries no recharts in its own chunk.
const DeltaSparkline = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.DeltaSparkline,
    })),
  { ssr: false, loading: () => null },
);

/**
 * The device's own recovery on "Device scores": WHOOP Recovery, Oura
 * Readiness or Polar Nightly Recharge, under the device's name, with the
 * latest value on the device's own scale and its two-week course.
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
  const { source, labelKey, latest, course } = recovery;

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
        {course.length >= 2 ? (
          <div data-slot="device-recovery-course" className="space-y-1">
            <div className="h-16 w-full" aria-hidden="true">
              <DeltaSparkline
                data={course.map((v, i) => ({ i, v }))}
                strokeVar={RING_GRADIENT.recovery[1]}
              />
            </div>
            <p className="text-muted-foreground text-xs">
              {t("insights.scores.historyWindow", {
                days: DEVICE_COURSE_DAYS,
              })}
            </p>
          </div>
        ) : null}
      </Card>
    </section>
  );
}
