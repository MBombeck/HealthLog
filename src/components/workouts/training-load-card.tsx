"use client";

import { Gauge } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { TrainingLoad } from "@/lib/insights/training-load";
import { shiftDateKey } from "@/lib/tz/format";

/**
 * v1.44 — fitness, fatigue and form from the stored training impulse, the
 * server's figures as given. Renders nothing until the model has 28 days and
 * three training days to stand on. The series ends on the day the strain run
 * scores; when the last rated day lies more than a day before that, the card
 * names it, so figures held through weeks without data never pass as fresh.
 */
export function TrainingLoadCard({
  trainingLoad,
}: {
  trainingLoad: TrainingLoad | undefined;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  if (!trainingLoad || trainingLoad.status !== "ok") return null;

  const seriesEnd = trainingLoad.series.at(-1)?.day;
  const stale =
    seriesEnd !== undefined && trainingLoad.asOf < shiftDateKey(seriesEnd, -1);

  const stats = [
    { key: "fitness", value: trainingLoad.ctl },
    { key: "fatigue", value: trainingLoad.atl },
    { key: "form", value: trainingLoad.tsb },
  ] as const;

  return (
    <Card data-slot="training-load">
      <CardHeader>
        <TileHeader icon={Gauge} title={t("insights.workouts.load.title")} />
      </CardHeader>
      <CardContent className="space-y-2">
        <dl className="grid grid-cols-3 gap-3">
          {stats.map((stat) => (
            <div key={stat.key} data-slot={`training-load-${stat.key}`}>
              <dt className="text-muted-foreground text-xs">
                {t(`insights.workouts.load.${stat.key}`)}
              </dt>
              <dd className="text-foreground text-lg font-semibold tabular-nums">
                {stat.key === "form" && stat.value > 0 ? "+" : ""}
                {fmt.number(stat.value, 0)}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-sm">{t("insights.workouts.load.explainer")}</p>
        {stale ? (
          <p
            className="text-muted-foreground text-xs"
            data-slot="training-load-as-of"
          >
            {t("insights.workouts.load.asOf", {
              date: fmt.dateShortSmartCalendar(trainingLoad.asOf),
            })}
          </p>
        ) : null}
        {trainingLoad.recentRatedDays < trainingLoad.recentDays ? (
          <p
            className="text-muted-foreground text-xs"
            data-slot="training-load-coverage"
          >
            {t("insights.workouts.load.coverage", {
              rated: trainingLoad.recentRatedDays,
              days: trainingLoad.recentDays,
            })}
          </p>
        ) : null}
        {trainingLoad.warmingUp ? (
          <p className="text-muted-foreground text-xs">
            {t("insights.workouts.load.warmingUp", {
              days: trainingLoad.daysCovered,
            })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
