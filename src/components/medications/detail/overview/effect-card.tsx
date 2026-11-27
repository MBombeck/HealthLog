"use client";

/**
 * The overview's effect card: the server's result sentence for the primary
 * target, its before and after means, a small chart, and the pair "Change
 * measurement" / "Details".
 */

import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Minus,
  TrendingUp,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { MedicationEfficacyDTO } from "@/lib/medications/efficacy/build-efficacy";

import { ActionPair, OverviewCard, PAIR_BUTTON } from "./anatomy";
import { EfficacySparkline } from "./efficacy-sparkline";

export function EffectCard({
  query,
  mayRetarget,
  onRetarget,
  onDetails,
}: {
  query: {
    data: MedicationEfficacyDTO | undefined;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
  };
  mayRetarget: boolean;
  onRetarget: () => void;
  onDetails?: () => void;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const dto = query.data;
  const target =
    dto?.targets.find((candidate) => candidate.primary) ?? dto?.targets[0];
  const ba = target?.beforeAfter;
  const direction = target?.result?.direction ?? null;
  const DeltaIcon =
    direction === "lower"
      ? ArrowDown
      : direction === "higher"
        ? ArrowUp
        : Minus;
  const series = target?.series ?? [];

  return (
    <OverviewCard
      icon={TrendingUp}
      title={t("medications.efficacy.title")}
      chip={target?.label}
      sentence={
        query.isLoading
          ? null
          : (target?.result?.text ?? t("medications.efficacy.noSeries"))
      }
      slot="medication-overview-effect"
      actions={
        <ActionPair
          secondary={
            mayRetarget ? (
              <Button
                variant="outline"
                className={PAIR_BUTTON}
                onClick={onRetarget}
                data-slot="medication-overview-effect-retarget"
              >
                {t("medications.detail.overview.changeMetric")}
              </Button>
            ) : undefined
          }
          primary={
            onDetails ? (
              <Button
                className={PAIR_BUTTON}
                onClick={onDetails}
                data-slot="medication-overview-effect-details"
              >
                {t("medications.detail.overview.details")}
              </Button>
            ) : (
              <span aria-hidden="true" />
            )
          }
        />
      }
    >
      {query.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : query.isError ? (
        <QueryErrorRow
          inset
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      ) : (
        <>
          {ba?.present && ba.before && ba.after && ba.delta && (
            <p
              className="flex items-baseline gap-2"
              data-slot="medication-overview-effect-values"
            >
              <span className="text-foreground text-3xl font-semibold tabular-nums">
                {fmt.number(ba.before.mean)}
              </span>
              <ArrowRight
                aria-label={t("medications.detail.overview.since")}
                className="text-muted-foreground size-4 self-center"
              />
              <span className="text-foreground text-3xl font-semibold tabular-nums">
                {fmt.number(ba.after.mean)}
              </span>
              {target?.unit && (
                <span className="text-muted-foreground text-sm">
                  {target.unit}
                </span>
              )}
              <span className="text-foreground ml-auto inline-flex items-center gap-0.5 text-sm tabular-nums">
                <DeltaIcon aria-hidden="true" className="size-4" />
                {fmt.number(Math.abs(ba.delta.mean))}
              </span>
            </p>
          )}
          {series.length > 1 && target && (
            <div className="space-y-1">
              <EfficacySparkline
                series={series}
                startAt={dto?.markers.start ?? null}
                beforeMean={ba?.before?.mean ?? null}
                afterMean={ba?.after?.mean ?? null}
                label={target.label}
              />
              <div
                aria-hidden="true"
                className="text-muted-foreground flex justify-between gap-2 text-xs tabular-nums"
              >
                <span>{fmt.dateShortSmart(series[0].t)}</span>
                {dto?.markers.start &&
                  Date.parse(dto.markers.start) >= Date.parse(series[0].t) && (
                    <span>
                      {t("medications.efficacy.startMarker")}{" "}
                      {fmt.dateShortSmartCalendar(dto.markers.start)}
                    </span>
                  )}
                <span>{fmt.dateShortSmart(series[series.length - 1].t)}</span>
              </div>
            </div>
          )}
        </>
      )}
    </OverviewCard>
  );
}
