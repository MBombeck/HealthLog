"use client";

import { Footprints } from "lucide-react";
import {
  useTranslations,
  useFormatters,
  useDisplayTimezone,
} from "@/lib/i18n/context";
import { formatUpdatedLabel } from "@/lib/i18n/relative-time";
import {
  MEASUREMENT_SOURCE_SETTINGS_LABEL_KEYS,
  type MeasurementSourceValue,
} from "@/lib/i18n/source-labels";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import { MEASUREMENT_TYPE_ICONS } from "@/components/measurements/measurement-list-meta";
import { metricName } from "@/lib/measurements/type-label-keys";
import { LearnMoreLink } from "@/components/ui/learn-more-link";
import {
  SAME_TIME_BASELINE_MIN_HISTORY_DAYS,
  SAME_TIME_DAILY_TOTAL_MIN_HISTORY_DAYS,
} from "@/lib/insights/derived/registry";
import type { InsightsLayout } from "@/lib/insights-layout";
// Type-only — the compute payload never drags the server graph into the bundle.
import type { SameTimeBaselineValue } from "@/lib/insights/derived/same-time-baseline";
import { SparklineDeltaTile } from "./sparkline-delta-tile";
import { SAME_TIME_DAILY_TOTAL_PROVENANCE } from "./standards";
import {
  BuildingTile,
  MetricProvenance,
  tileVisible,
  type TileProps,
} from "./tile-parts";
import { SECTION_CUMULATIVE } from "./use-dashboard-derived";
import { type DerivedBatchRead } from "./use-derived-metric";
import { UsualDayTrack } from "./usual-day-track";

/**
 * The "Today so far" section of the vitals dashboard: one tile per
 * cumulative metric, the section's visibility gate and its subtitle. The
 * tile and its gates read the same server-resolved value
 * (`SAME_TIME_BASELINE`), so they live together.
 */

/** Same-time-baseline `MeasurementType` → layout tile id (routed slug). */
export const CUMULATIVE_TILE_LAYOUT_ID: Record<string, string> = {
  ACTIVITY_STEPS: "steps",
  ACTIVE_ENERGY_BURNED: "active-energy",
  WALKING_RUNNING_DISTANCE: "walking-distance",
  FLIGHTS_CLIMBED: "flights-climbed",
};

/**
 * The still-learning reasons of the same-time baseline, each with the floor
 * the copy counts towards: fourteen days with hours for the hourly form, seven
 * days with a total for the day-total form. Any other reason hides the tile.
 */
const LEARNING_TARGET: Record<string, number> = {
  learning_usual_day: SAME_TIME_BASELINE_MIN_HISTORY_DAYS,
  learning_usual_total: SAME_TIME_DAILY_TOTAL_MIN_HISTORY_DAYS,
};

/**
 * The same-time baseline tile for one cumulative metric.
 *
 * Every other tile in this grid frames a latest reading against a band. A
 * cumulative metric has no latest reading, so this one frames today's running
 * total against the person's own typical total at the same local hour, and the
 * sparkline carries both trajectories on one pair of axes rather than one.
 *
 * The states are the states the rest of the grid already has, with one
 * addition that matters more here than anywhere else: a baseline built from
 * three days is not a baseline, so below the floor the tile says it is still
 * learning and shows how far along it is. It never renders a number it does
 * not have the history for.
 *
 * One tile, two forms, chosen by the server (`value.mode`). When the
 * day belongs to a source that reports one total per day (Garmin, Withings, a
 * Gadgetbridge import) there is no hour to compare at, and the tile shows
 * today's running total against the usual full day with the time the total
 * last arrived, in the same anatomy.
 */
export function SameTimeBaselineTile({
  type,
  read,
  isLoading,
}: TileProps & {
  type: string;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const displayTz = useDisplayTimezone();
  const unitDisplay = useUnitDisplay();
  const data = read<SameTimeBaselineValue>({
    metric: "SAME_TIME_BASELINE",
    type,
  });

  if (isLoading || !data) return null;

  const Icon = MEASUREMENT_TYPE_ICONS[type] ?? Footprints;
  const name = metricName(type, t);
  const tileId = CUMULATIVE_TILE_LAYOUT_ID[type] ?? type;

  if (data.status === "insufficient") {
    // Absent, not gated. No reading from today yet, an unsupported type, or a
    // day whose first hour has not finished yet. None of these is a state the
    // user can act on, so the tile does not render at all rather than
    // occupying the grid with an apology. Still learning is the one state
    // shown, with the floor of the form the server is learning for.
    const target = data.reason ? LEARNING_TARGET[data.reason] : undefined;
    if (target === undefined) return null;
    return (
      <BuildingTile
        slot="same-time-tile"
        metric={tileId}
        state="learning"
        icon={Icon}
        title={name}
        messageSlot="same-time-tile-learning"
        message={t("insights.derived.sameTime.learning", {
          count: data.coverage.historyDays,
          target,
        })}
        coverage={data.coverage}
      />
    );
  }

  const v = data.value!;
  const unit = unitDisplay.unitFor(type);
  const toShown = (raw: number) => unitDisplay.toDisplay(type, raw);
  // A transformed distance reads in kilometres and wants a decimal; a step,
  // flight or kilocalorie count is a whole number and a decimal on it is noise.
  const precision = unitDisplay.isTransformed(type) ? 1 : 0;

  // The source reports the day as one total: today's running total against
  // the usual full day, with when the total last arrived. No hour, no curve,
  // no arrow, because nothing behind the number knows the hour.
  if (v.mode === "daily_total") {
    const sourceKey =
      MEASUREMENT_SOURCE_SETTINGS_LABEL_KEYS[
        v.source as MeasurementSourceValue
      ];
    return (
      <div
        data-slot="same-time-tile"
        data-metric={tileId}
        data-state="ok"
        data-mode="daily_total"
      >
        <SparklineDeltaTile
          label={name}
          value={toShown(v.todayValue)}
          unit={unit}
          icon={Icon}
          visual={
            <UsualDayTrack
              today={v.todayValue}
              low={v.typicalLow}
              median={v.typicalValue}
              high={v.typicalHigh}
              reached={v.dayRangeReached}
            />
          }
          precision={precision}
          framing={t("insights.derived.sameTime.dailyFraming", {
            low: fmt.number(toShown(v.typicalLow), precision),
            high: fmt.number(toShown(v.typicalHigh), precision),
            unit,
          })}
          caption={t("insights.derived.sameTime.dailyStamp", {
            updated: formatUpdatedLabel(
              v.updatedAt,
              t,
              fmt.dateShort,
              fmt.time,
              displayTz,
            ),
            source: sourceKey ? t(sourceKey) : v.source,
          })}
          provenance={
            <MetricProvenance
              metric="SAME_TIME_BASELINE"
              meta={SAME_TIME_DAILY_TOTAL_PROVENANCE}
              provenance={data.provenance}
            />
          }
          footer={<LearnMoreLink concept={tileId} />}
        />
      </div>
    );
  }
  // The comparison is anchored to the END of `asOfHour`, which is the top of
  // the following hour on the clock. 24-hour form, built from the number the
  // server already resolved — deriving a locale-formatted instant on the
  // client from a server-side local hour is how a hydration mismatch starts.
  const byClock = `${String(v.asOfHour + 1).padStart(2, "0")}:00`;

  return (
    <div
      data-slot="same-time-tile"
      data-metric={tileId}
      data-state="ok"
      data-mode="hourly"
    >
      <SparklineDeltaTile
        label={name}
        value={toShown(v.todayValue)}
        unit={unit}
        icon={Icon}
        series={v.todayCurve.map(toShown)}
        comparisonSeries={v.typicalCurve.map(toShown)}
        comparisonLabel={t("insights.derived.sameTime.comparisonLabel")}
        delta={unitDisplay.toDisplayDelta(type, v.delta)}
        directionSentiment="up-good"
        precision={precision}
        framing={t("insights.derived.sameTime.framing", {
          time: byClock,
          typical: fmt.number(toShown(v.typicalValue), precision),
          unit,
        })}
        provenance={
          <MetricProvenance
            metric="SAME_TIME_BASELINE"
            provenance={data.provenance}
          />
        }
        footer={<LearnMoreLink concept={tileId} />}
      />
    </div>
  );
}

/**
 * Whether the batch holds at least one same-time tile worth painting. Mirrors
 * the tile's own gate exactly: only an `ok` value or the honest "still
 * learning" state counts, so the section heading never strands over a grid
 * that turned out to be empty (every daily-total source lands there).
 */
export function hasRenderableSameTime(
  read: DerivedBatchRead,
  layout: InsightsLayout | undefined,
): boolean {
  for (const type of SECTION_CUMULATIVE) {
    if (!tileVisible(layout, CUMULATIVE_TILE_LAYOUT_ID[type] ?? type)) continue;
    const data = read<SameTimeBaselineValue>({
      metric: "SAME_TIME_BASELINE",
      type,
    });
    if (!data) continue;
    if (data.status === "ok") return true;
    if (data.reason && LEARNING_TARGET[data.reason] !== undefined) return true;
  }
  return false;
}

/**
 * The section subtitle names the comparison the tiles under it make: at this
 * hour when every shown tile compares hours, against the usual full day when
 * every one compares day totals, and plainly "what is usual" when the two
 * forms sit side by side (an iPhone counting steps, a watch counting floors).
 */
export function sameTimeSubtitleKey(
  read: DerivedBatchRead,
  layout: InsightsLayout | undefined,
): string {
  const modes = new Set<string>();
  for (const type of SECTION_CUMULATIVE) {
    if (!tileVisible(layout, CUMULATIVE_TILE_LAYOUT_ID[type] ?? type)) continue;
    const data = read<SameTimeBaselineValue>({
      metric: "SAME_TIME_BASELINE",
      type,
    });
    if (data?.status === "ok" && data.value) modes.add(data.value.mode);
  }
  if (modes.size > 1) return "insights.derived.sameTime.sectionSubtitleMixed";
  if (modes.has("daily_total")) {
    return "insights.derived.sameTime.sectionSubtitleDailyTotal";
  }
  return "insights.derived.sameTime.sectionSubtitle";
}
