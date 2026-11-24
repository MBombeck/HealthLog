"use client";

import { useMemo, useState, type ComponentProps } from "react";
import dynamic from "next/dynamic";
import { ChevronLeft, ChevronRight, Moon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { TileHeader } from "@/components/insights/tile-header";
import { ChartErrorBoundary } from "@/components/charts/chart-error-state";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import {
  SleepSourceDiscrepancyMarker,
  sourceDisplayName,
} from "@/components/insights/sleep-source-discrepancy-marker";
import { useSleepNight } from "@/hooks/use-sleep-night";
import {
  SleepNightOverlayChips,
  SleepNightOverlayFacts,
  useNightOverlays,
} from "@/components/insights/sleep/sleep-night-overlays";
import {
  useDateFormatPreference,
  useDisplayTimezone,
  useFormatters,
  useTimeFormatPreference,
  useTranslations,
} from "@/lib/i18n/context";
import { makeFormatters } from "@/lib/format-locale";
import { formatDurationMinutes } from "@/lib/i18n/duration";
import { importWithRetry } from "@/lib/retry-import";
import {
  hasHypnogramTrack,
  hypnogramLayout,
  shiftNightKey,
  type HypnogramStage,
} from "@/lib/sleep/hypnogram-layout";

// Recharts loads through the one shared chart chunk; the skeleton holds the
// chart's place while it does.
const SleepHypnogramChartLazy = dynamic(
  () =>
    importWithRetry(() => import("@/components/charts/chart-runtime")).then(
      (mod) => ({ default: mod.SleepHypnogramChart }),
    ),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
function SleepHypnogramChart(
  props: ComponentProps<typeof SleepHypnogramChartLazy>,
) {
  return (
    <ChartErrorBoundary>
      <SleepHypnogramChartLazy {...props} />
    </ChartErrorBoundary>
  );
}

/**
 * The sleep page's night timeline (#1419): one night's stages over clock
 * time, with a step back and forward through the nights.
 *
 * It opens on the most recent night with a main sleep and reads every other
 * night by its wake day from `GET /api/sleep/night`, which already picked
 * one source per night, so two trackers' timelines never overlay. The
 * per-stage totals stay in the stacked bar below; this card adds the order
 * the stages came in, which the bar cannot show.
 *
 * A night that holds stage totals without their order gets a note instead
 * of a chart, and no awakenings count. The server decides that per night
 * from the shape of the spans (`reconstructed`: Garmin and Oura's fallback
 * stamp every total on the wake instant, WHOOP and Polar lay them out in a
 * fixed order); drawing either would invent a progression.
 *
 * The axis reads in the night's own zone when the readings carry one and in
 * the profile zone otherwise.
 *
 * Under a drawn timeline, toggles lay the night's pulse, HRV, breathing,
 * SpO2 or temperature over the stages as lines, from the series the server
 * resolved for that night (`sleep-night-overlays.tsx`).
 */
export function SleepNightCard({ enabled }: { enabled: boolean }) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const profileZone = useDisplayTimezone();
  const timeFormat = useTimeFormatPreference();
  const dateFormat = useDateFormatPreference();
  /** `undefined` is the latest night; a key is a night stepped to. */
  const [night, setNight] = useState<string | undefined>(undefined);
  // The latest night bounds the forward step. It is the same cached read
  // as the opening night, so stepping costs no second request for it.
  const latestQuery = useSleepNight(undefined, enabled);
  const query = useSleepNight(night, enabled);
  const latest = latestQuery.data?.night ?? null;
  const data = query.data;
  const shownNight = data?.night ?? night ?? null;

  const session = data?.main ?? null;
  const timeZone = session?.timeZone ?? profileZone;
  const axisFormat = useMemo(
    () => makeFormatters(locale, timeZone, timeFormat, dateFormat),
    [locale, timeZone, timeFormat, dateFormat],
  );
  const layout = useMemo(
    () => hypnogramLayout(session?.segments ?? []),
    [session?.segments],
  );
  const track = session
    ? hasHypnogramTrack(layout, session.reconstructed)
    : false;
  const asleepLabel = session
    ? formatDurationMinutes(session.asleepMinutes, t)
    : "";

  const stageLabels: Record<HypnogramStage, string> = {
    AWAKE: t("insights.sleep.stages.awake"),
    IN_BED: t("insights.sleep.stages.inBed"),
    ASLEEP: t("insights.sleep.stages.asleep"),
    REM: t("insights.sleep.stages.rem"),
    CORE: t("insights.sleep.stages.core"),
    DEEP: t("insights.sleep.stages.deep"),
  };

  const overlayState = useNightOverlays(track ? data?.overlays : null, enabled);

  const canStepForward =
    shownNight !== null && latest !== null && shownNight < latest;
  const nav = (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={shownNight === null}
        aria-label={t("insights.sleep.hypnogram.previous")}
        data-slot="sleep-hypnogram-previous"
        onClick={() => shownNight && setNight(shiftNightKey(shownNight, -1))}
      >
        <ChevronLeft />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={!canStepForward}
        aria-label={t("insights.sleep.hypnogram.next")}
        data-slot="sleep-hypnogram-next"
        onClick={() => {
          if (!shownNight || !latest) return;
          const next = shiftNightKey(shownNight, 1);
          setNight(next >= latest ? undefined : next);
        }}
      >
        <ChevronRight />
      </Button>
    </div>
  );

  return (
    <Card data-slot="sleep-hypnogram" className="gap-3">
      <CardHeader>
        <TileHeader
          icon={Moon}
          title={t("insights.sleep.hypnogram.title")}
          right={nav}
        />
        {shownNight ? (
          <p
            className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs"
            data-slot="sleep-hypnogram-meta"
          >
            <span>
              {t("insights.sleep.hypnogram.wokeOn", {
                date: fmt.dateWithWeekdaySmart(
                  new Date(`${shownNight}T12:00:00.000Z`),
                ),
              })}
            </span>
            {session ? (
              <>
                <span data-slot="sleep-hypnogram-summary">
                  {session.reconstructed
                    ? t("insights.sleep.hypnogram.asleepOnly", {
                        asleep: asleepLabel,
                      })
                    : t("insights.sleep.hypnogram.summary", {
                        asleep: asleepLabel,
                        awakenings: session.awakenings,
                      })}
                </span>
                <SleepSourceDiscrepancyMarker
                  discrepancy={session.sourceDiscrepancy}
                />
                {session.source ? (
                  <span data-slot="sleep-hypnogram-source">
                    {t("insights.sleep.hypnogram.source", {
                      source: sourceDisplayName(session.source, null, t),
                    })}
                  </span>
                ) : null}
              </>
            ) : null}
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        {query.isError ? (
          <QueryErrorRow
            inset
            error={query.error}
            onRetry={query.refetch}
            slot="sleep-hypnogram-error"
          />
        ) : data === undefined ? (
          <ChartSkeleton />
        ) : !session ? (
          <EmptyState
            variant="plain"
            size="compact"
            data-slot="sleep-hypnogram-empty"
            title={t("insights.sleep.hypnogram.empty")}
          />
        ) : track ? (
          <SleepHypnogramChart
            layout={layout}
            fromMs={Date.parse(session.start)}
            toMs={Date.parse(session.end)}
            timeZone={timeZone}
            stageLabels={stageLabels}
            formatTime={(ms) => axisFormat.time(new Date(ms))}
            ariaLabel={t("insights.sleep.hypnogram.ariaLabel", {
              asleep: asleepLabel,
              awakenings: session.awakenings,
            })}
            overlay={overlayState.chartOverlay}
          />
        ) : (
          <p
            className="text-muted-foreground py-6 text-center text-xs"
            data-slot="sleep-hypnogram-estimate-note"
          >
            {session.reconstructed
              ? t("insights.sleep.hypnogram.estimateNote")
              : t("insights.sleep.hypnogram.noStages")}
          </p>
        )}
        {track && !query.isError ? (
          <div className="mt-3 flex flex-col gap-3 empty:hidden">
            <SleepNightOverlayChips state={overlayState} />
            <SleepNightOverlayFacts state={overlayState} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
