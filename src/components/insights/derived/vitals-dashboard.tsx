"use client";

import { useMemo, type ReactNode } from "react";
import { Footprints, Gauge, HeartPulse, Scale } from "lucide-react";
import { cn } from "@/lib/utils";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { measurementUnitLabel } from "@/lib/measurements/unit-label";
import { getUnitForType } from "@/lib/measurements/unit-map";
import { useUnitDisplay } from "@/hooks/use-unit-display";
import {
  MEASUREMENT_TYPE_ICONS,
  MEASUREMENT_TYPE_LABEL_KEYS,
} from "@/components/measurements/measurement-list-meta";
import { SectionHeading } from "@/components/ui/section-heading";
import { SparklineDeltaTile } from "./sparkline-delta-tile";
import { LearnMoreLink } from "@/components/ui/learn-more-link";
import { METRIC_PROVENANCE } from "./standards";
import {
  BuildingTile,
  MetricProvenance,
  tileVisible,
  type TileProps,
} from "./tile-parts";
import {
  CUMULATIVE_TILE_LAYOUT_ID,
  SameTimeBaselineTile,
  hasRenderableSameTime,
  sameTimeSubtitleKey,
} from "./same-time-tile";
import { type DerivedBatchRead } from "./use-derived-metric";
import {
  SECTION_VITALS,
  SECTION_MOBILITY,
  SECTION_CUMULATIVE,
  type DashboardDerived,
} from "./use-dashboard-derived";
import { resolveTileLayout, type InsightsLayout } from "@/lib/insights-layout";
// Type-only — the compute payloads never drag the server graph into the bundle.
import type { VitalsBaselineValue } from "@/lib/insights/derived/baseline";
import type { FitnessAgeValue } from "@/lib/insights/derived/fitness-age";
import type { VascularAgeDeltaValue } from "@/lib/insights/derived/vascular-age";
import type { HrvBalanceValue } from "@/lib/insights/derived/hrv-balance";
import type { BmiValue } from "@/lib/insights/derived/bmi";
import type { SixMinuteWalkValue } from "@/lib/insights/derived/six-minute-walk";
import { TrendTile } from "@/components/ui/trend-tile";

/**
 * v1.10.0 — the Vitals dashboard surface (Apple-Health-Highlights grid).
 *
 * A responsive grid of `SparklineDeltaTile`s, one per available vital, each
 * framed with its personal typical range (the flagship baseline metric) plus
 * the four passthrough/derived re-frames (cardio-fitness band, vascular-age
 * delta, HRV balance, BMI). Every tile is data-availability-gated:
 *   - absent (`no_readings_in_window` / `no_height` / `no_weight`) → the tile
 *     does not render at all (no apologetic empty card).
 *   - provisional (`insufficient_history_for_band`) → the tile renders with a
 *     `CoverageMeter` that shows the honest "N of 7 days" state, never a
 *     headline number from too-little history.
 *   - ok → the full value + framing line + a provenance ⓘ affordance.
 *
 * The whole grid (every vital tile AND the wellness-score strip) reads from
 * ONE batched `/api/insights/derived/batch` request, fanned out server-side
 * under a bounded limiter with the profile loaded once. This replaces the
 * cold-mount fan-out of 14+ independent requests sharing the Prisma pool —
 * the "app hangs then recovers" symptom (v1.9.1 / v1.4.49.1).
 */

// v1.12.6 — `SECTION_VITALS`, `SECTION_MOBILITY` and the batch token list
// moved to `use-dashboard-derived.ts` so the page can own the one shared batch
// and feed it to both the wellness strip and this grid. Imported above.

interface DashboardProps {
  /**
   * The shared overview derived batch (owned by the page so the wellness
   * strip and this vitals grid read the same one request). Lifted out of
   * this component in v1.12.6 — the wellness strip now renders as its own
   * full-width section above the daily briefing.
   */
  batch: DashboardDerived;
  /**
   * v1.15.11 — the resolved insights layout, passed down from the page
   * (which already mounts `useInsightsLayoutQuery()`) so this grid honours the
   * user's per-tile order + visibility without a second fetch. Each grid tile
   * maps to a layout tile id (see `VITAL_TILE_LAYOUT_ID` /
   * `MOBILITY_TILE_LAYOUT_ID`); a tile the layout marks `visible: false` does
   * not render even if it has data, and visible tiles render in `order`. Tiles
   * still self-gate on data availability on top of that. Optional so a caller
   * that has no layout yet falls back to the default (everything shown,
   * data-gated as before).
   */
  layout?: InsightsLayout;
  className?: string;
}

/**
 * v1.15.11 — the dashboard's vitals-grid tile concepts mapped onto their
 * layout tile id (the routed sub-page slug). The four derived re-frames map to
 * the slug of the metric they re-frame; the per-vital baseline tiles map by
 * their `MeasurementType`. A tile concept absent from this map (none today)
 * would fall through `resolveTileLayout` as always-on, so the grid never drops
 * a tile it cannot place.
 *
 *   FitnessAge (VO₂max re-frame) → `cardio-fitness`
 *   VascularAge                  → `vascular-age`
 *   HrvBalance                   → `hrv`
 *   Bmi                          → `bmi`
 */
const VITAL_BASELINE_TILE_LAYOUT_ID: Record<string, string> = {
  RESTING_HEART_RATE: "resting-pulse",
  RESPIRATORY_RATE: "respiratory-rate",
  OXYGEN_SATURATION: "oxygen",
  BODY_TEMPERATURE: "body-temperature",
  BLOOD_GLUCOSE: "blood-glucose",
  WEIGHT: "weight",
};

/** Mobility-section `MeasurementType` → layout tile id (routed slug). */
const MOBILITY_TILE_LAYOUT_ID: Record<string, string> = {
  STAIR_ASCENT_SPEED: "stair-ascent-speed",
  STAIR_DESCENT_SPEED: "stair-descent-speed",
  WRIST_TEMPERATURE: "wrist-temperature",
};

/** The reader's unit for a tile whose value has no unit preference. */
function unitLabel(type: string, t: (key: string) => string): string {
  return measurementUnitLabel(type, getUnitForType(type), t);
}

/**
 * v1.15.11 — the layout `order` for a tile id, used to sort the grid.
 * Falls back to `MAX_SAFE_INTEGER` (render last) for an unenumerated id and to
 * a stable 0 when no layout is present (callers keep their source order).
 */
function tileOrder(layout: InsightsLayout | undefined, tileId: string): number {
  if (!layout) return 0;
  return resolveTileLayout(layout, tileId).order;
}

/**
 * A single median ± k·MAD personal-band tile. Shared by the per-vital
 * `VITALS_BASELINE` reads and the v1.10.3 any-user HealthKit bands
 * (`WRIST_TEMPERATURE_BASELINE`, `STAIR_ASCENT_SPEED_BASELINE`,
 * `STAIR_DESCENT_SPEED_BASELINE`) — every one returns the same
 * `VitalsBaselineValue` and frames as a personal typical range. The `metric`
 * selects the batch token + provenance entry; `type` drives the icon, label
 * and unit (and, for `VITALS_BASELINE`, the read token's `type`).
 */
function BaselineTile({
  metric,
  type,
  read,
  isLoading,
}: TileProps & {
  metric: keyof typeof METRIC_PROVENANCE;
  type: string;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const unitDisplay = useUnitDisplay();
  // `VITALS_BASELINE` is the type-generic engine and needs the type on the
  // token; the dedicated bands pin their own single input, so no `type`.
  const data = read<VitalsBaselineValue>(
    metric === "VITALS_BASELINE" ? { metric, type } : { metric },
  );

  if (isLoading || !data) return null;
  // Absent → don't render the tile at all.
  if (
    data.status === "insufficient" &&
    data.reason === "no_readings_in_window"
  ) {
    return null;
  }

  const Icon = MEASUREMENT_TYPE_ICONS[type] ?? Gauge;
  const labelKey = MEASUREMENT_TYPE_LABEL_KEYS[type];
  const label = labelKey ? t(labelKey) : type;
  // v1.32.26 — resolve the display unit from the user's preference. For an
  // absolute temperature this converts celsius→°F (affine); the reporter's
  // proven canonical-label bug (a value labelled by the storage unit rather
  // than the preferred one) is fixed here, retiring the local celsius shim.
  const unit = unitDisplay.unitFor(type);
  const toShown = (raw: number) => unitDisplay.toDisplay(type, raw);
  // `VITALS_BASELINE` tiles tag the DOM by their vital type (the stable
  // contract the existing surfaces + tests key on); the dedicated bands tag
  // by their own metric id.
  const tileId = metric === "VITALS_BASELINE" ? type : metric;

  // Provisional — building the band; show value-less coverage state.
  if (data.status === "insufficient") {
    return (
      <BuildingTile
        slot="vitals-tile"
        metric={tileId}
        state="provisional"
        icon={Icon}
        title={label}
        messageSlot="vitals-tile-building"
        message={t("insights.derived.vitals.building", {
          count: data.coverage.historyDays,
          target: 7,
        })}
        coverage={data.coverage}
      />
    );
  }

  const v = data.value!;
  // Range bounds + centre + sparkline are ABSOLUTE readings → affine-convert.
  const framing = t("insights.derived.vitals.typicalRange", {
    low: fmt.number(toShown(v.low), 1),
    high: fmt.number(toShown(v.high), 1),
  });
  const displaySeries = unitDisplay.isTransformed(type)
    ? v.series.map(toShown)
    : v.series;

  return (
    <div data-slot="vitals-tile" data-metric={tileId} data-state="ok">
      <SparklineDeltaTile
        label={label}
        value={toShown(v.center)}
        unit={unit}
        icon={Icon}
        series={displaySeries}
        framing={framing}
        // v1.43 — resolved on the server against the person's own target
        // or profile default; an older server sends none and the tile
        // stays neutral rather than assuming a polarity.
        directionSentiment={v.direction?.direction ?? "neutral"}
        provenance={
          // v1.29.1 muted this on VITALS_BASELINE tiles because the always-on
          // "typical range = median ± MAD" caption repeated across every vital
          // baseline tile and read as clutter. v1.29.2 restores the context —
          // now behind the compact (i) trigger (`InfoPopover`) instead of a
          // full-width caption, so every baseline tile carries it again
          // without the repetition or the header-row squeeze that clipped the
          // cardio-fitness heading.
          <MetricProvenance metric={metric} provenance={data.provenance} />
        }
        footer={<LearnMoreLink concept={tileId} />}
      />
    </div>
  );
}

/**
 * Estimated 6-minute-walk band tile (`SIX_MINUTE_WALK_BAND` passthrough
 * re-frame). Surfaces the device's estimated distance + trend always; the
 * percent-of-predicted framing only when the Enright equation's demographics
 * are present, otherwise an honest "add your demographics" prompt. Absent
 * when no reading exists in the window.
 */
function SixMinuteWalkTile({ read, isLoading }: TileProps) {
  const { t } = useTranslations();
  const data = read<SixMinuteWalkValue>({ metric: "SIX_MINUTE_WALK_BAND" });
  if (isLoading || !data || data.status !== "ok" || !data.value) return null;
  const v = data.value;
  const framing =
    v.band != null && v.percentOfPredicted != null
      ? t(`insights.derived.vitals.sixMinuteBand.${v.band}`, {
          percent: v.percentOfPredicted,
        })
      : t("insights.derived.vitals.sixMinuteNoBand");
  return (
    <div
      data-slot="vitals-tile"
      data-metric="SIX_MINUTE_WALK_BAND"
      data-state="ok"
    >
      <SparklineDeltaTile
        label={t("measurements.typeSixMinuteWalkDistance")}
        value={v.distanceM}
        unit={unitLabel("SIX_MINUTE_WALK_DISTANCE", t)}
        icon={MEASUREMENT_TYPE_ICONS.SIX_MINUTE_WALK_DISTANCE ?? Footprints}
        series={v.series}
        delta={v.trendDelta}
        directionSentiment="up-good"
        framing={framing}
        precision={0}
        provenance={
          <MetricProvenance
            metric="SIX_MINUTE_WALK_BAND"
            provenance={data.provenance}
          />
        }
      />
    </div>
  );
}

/** Cardio-fitness band tile (VO₂max passthrough re-frame). */
function FitnessAgeTile({ read, isLoading }: TileProps) {
  const { t } = useTranslations();
  const data = read<FitnessAgeValue>({ metric: "FITNESS_AGE" });
  if (isLoading || !data || data.status !== "ok" || !data.value) return null;
  const v = data.value;
  const framing =
    v.fitnessAgeDeltaYears != null
      ? v.fitnessAgeDeltaYears < 0
        ? t("insights.derived.vitals.fitnessYounger", {
            years: Math.abs(v.fitnessAgeDeltaYears),
          })
        : v.fitnessAgeDeltaYears > 0
          ? t("insights.derived.vitals.fitnessOlder", {
              years: v.fitnessAgeDeltaYears,
            })
          : t("insights.derived.vitals.fitnessTypical")
      : t("insights.derived.vitals.fitnessNoNorm");
  return (
    <div data-slot="vitals-tile" data-metric="FITNESS_AGE" data-state="ok">
      <SparklineDeltaTile
        label={t("measurements.typeVo2Max")}
        value={v.vo2Max}
        unit={unitLabel("VO2_MAX", t)}
        icon={Gauge}
        delta={v.trendDelta}
        directionSentiment="up-good"
        framing={framing}
        precision={1}
        provenance={
          <MetricProvenance metric="FITNESS_AGE" provenance={data.provenance} />
        }
      />
    </div>
  );
}

/** Vascular-age delta tile (Withings passthrough re-frame). */
function VascularAgeTile({ read, isLoading }: TileProps) {
  const { t } = useTranslations();
  const data = read<VascularAgeDeltaValue>({ metric: "VASCULAR_AGE_DELTA" });
  if (isLoading || !data || data.status !== "ok" || !data.value) return null;
  const v = data.value;
  const framing =
    v.deltaYears != null
      ? v.deltaYears < 0
        ? t("insights.derived.vitals.vascularBelow", {
            years: Math.abs(Math.round(v.deltaYears)),
          })
        : v.deltaYears > 0
          ? t("insights.derived.vitals.vascularAbove", {
              years: Math.round(v.deltaYears),
            })
          : t("insights.derived.vitals.vascularMatch")
      : t("insights.derived.vitals.vascularNoAge");
  return (
    <div
      data-slot="vitals-tile"
      data-metric="VASCULAR_AGE_DELTA"
      data-state="ok"
    >
      <SparklineDeltaTile
        label={t("measurements.typeVascularAge")}
        value={v.vascularAge}
        unit={unitLabel("VASCULAR_AGE", t)}
        icon={HeartPulse}
        delta={v.trendDelta}
        directionSentiment="up-bad"
        framing={framing}
        precision={0}
        provenance={
          <MetricProvenance
            metric="VASCULAR_AGE_DELTA"
            provenance={data.provenance}
          />
        }
      />
    </div>
  );
}

/** HRV (SDNN) balance tile (reuses the baseline engine). */
function HrvBalanceTile({ read, isLoading }: TileProps) {
  const { t } = useTranslations();
  const data = read<HrvBalanceValue>({ metric: "HRV_BALANCE" });
  if (isLoading || !data) return null;
  if (
    data.status === "insufficient" &&
    data.reason === "no_readings_in_window"
  ) {
    return null;
  }
  if (data.status === "insufficient") {
    return (
      <BuildingTile
        slot="vitals-tile"
        metric="HRV_BALANCE"
        state="provisional"
        icon={HeartPulse}
        title={t("measurements.typeHeartRateVariability")}
        messageSlot="vitals-tile-building"
        message={t("insights.derived.vitals.building", {
          count: data.coverage.historyDays,
          target: 7,
        })}
        coverage={data.coverage}
      />
    );
  }
  const v = data.value!;
  const framing = t(`insights.derived.vitals.hrvBand.${v.band}`);
  return (
    <div data-slot="vitals-tile" data-metric="HRV_BALANCE" data-state="ok">
      <SparklineDeltaTile
        label={t("measurements.typeHeartRateVariability")}
        value={v.recentAvg}
        unit={unitLabel("HEART_RATE_VARIABILITY", t)}
        icon={HeartPulse}
        series={v.series}
        directionSentiment="up-good"
        framing={framing}
        precision={0}
        provenance={
          <MetricProvenance metric="HRV_BALANCE" provenance={data.provenance} />
        }
      />
    </div>
  );
}

/** BMI tile (weight + height fallback). */
function BmiTile({ read, isLoading }: TileProps) {
  const { t } = useTranslations();
  const data = read<BmiValue>({ metric: "BMI" });
  if (isLoading || !data || data.status !== "ok" || !data.value) return null;
  const v = data.value;
  const framing = t(`insights.derived.vitals.bmiCategory.${v.category}`);
  return (
    <div data-slot="vitals-tile" data-metric="BMI" data-state="ok">
      <SparklineDeltaTile
        label={t("measurements.typeBodyMassIndex")}
        value={v.bmi}
        unit={unitLabel("BODY_MASS_INDEX", t)}
        icon={Scale}
        series={v.series}
        directionSentiment="neutral"
        framing={framing}
        precision={1}
        provenance={
          <MetricProvenance metric="BMI" provenance={data.provenance} />
        }
      />
    </div>
  );
}

/**
 * A loading placeholder occupying the resolved tile footprint so the grid
 * reserves its final height and the real tiles drop in without a layout
 * shift. Mirrors the SparklineDeltaTile geometry (card + label row + value
 * row + framing line) with `Skeleton` blocks. Decorative — `aria-hidden`.
 */
function VitalsTileSkeleton() {
  return (
    <TrendTile
      data-slot="vitals-tile-skeleton"
      aria-hidden="true"
      className="gap-3"
    >
      {/* The same two-line reserve the tile headers keep, so the real
          tiles drop in without moving the value row. */}
      <div className="flex h-10 items-start justify-between gap-2">
        <Skeleton className="mt-1 h-3 w-24" />
        <Skeleton className="mt-0.5 h-4 w-4 rounded" />
      </div>
      <Skeleton className="h-8 w-20" />
      <Skeleton className="h-3 w-3/4" />
    </TrendTile>
  );
}

/**
 * Whether the resolved batch holds at least one vital tile worth painting.
 * Mirrors the per-tile gates so the section heading is only rendered once
 * there is content under it (an empty heading stranded over blank space was
 * the CLS the load-state QoL pass closes). Kept in sync with the tile gates
 * above — if a new tile gate changes, reflect it here.
 */
function hasRenderableVital(
  read: DerivedBatchRead,
  layout: InsightsLayout | undefined,
): boolean {
  if (tileVisible(layout, "cardio-fitness")) {
    const fitness = read<FitnessAgeValue>({ metric: "FITNESS_AGE" });
    if (fitness?.status === "ok" && fitness.value) return true;
  }

  if (tileVisible(layout, "vascular-age")) {
    const vascular = read<VascularAgeDeltaValue>({
      metric: "VASCULAR_AGE_DELTA",
    });
    if (vascular?.status === "ok" && vascular.value) return true;
  }

  if (tileVisible(layout, "bmi")) {
    const bmi = read<BmiValue>({ metric: "BMI" });
    if (bmi?.status === "ok" && bmi.value) return true;
  }

  if (tileVisible(layout, "hrv")) {
    const hrv = read<HrvBalanceValue>({ metric: "HRV_BALANCE" });
    if (
      hrv &&
      !(hrv.status === "insufficient" && hrv.reason === "no_readings_in_window")
    ) {
      return true;
    }
  }

  for (const type of SECTION_VITALS) {
    if (type === "HEART_RATE_VARIABILITY") continue;
    if (!tileVisible(layout, VITAL_BASELINE_TILE_LAYOUT_ID[type] ?? type)) {
      continue;
    }
    const baseline = read<VitalsBaselineValue>({
      metric: "VITALS_BASELINE",
      type,
    });
    if (
      baseline &&
      !(
        baseline.status === "insufficient" &&
        baseline.reason === "no_readings_in_window"
      )
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Whether the resolved batch holds at least one mobility/body tile worth
 * painting. Mirrors the per-tile gates so the Mobility section heading is
 * only rendered once there is content under it (no stranded heading over
 * blank space). Most users carry none of these → the whole section hides.
 */
function hasRenderableMobility(
  read: DerivedBatchRead,
  layout: InsightsLayout | undefined,
): boolean {
  if (tileVisible(layout, "six-minute-walk")) {
    const sixmw = read<SixMinuteWalkValue>({ metric: "SIX_MINUTE_WALK_BAND" });
    if (sixmw?.status === "ok" && sixmw.value) return true;
  }

  for (const { metric, type } of SECTION_MOBILITY) {
    if (!tileVisible(layout, MOBILITY_TILE_LAYOUT_ID[type] ?? type)) continue;
    const band = read<VitalsBaselineValue>({ metric });
    if (
      band &&
      !(
        band.status === "insufficient" &&
        band.reason === "no_readings_in_window"
      )
    ) {
      return true;
    }
  }

  return false;
}

export function VitalsDashboard({ batch, layout, className }: DashboardProps) {
  const { t } = useTranslations();

  const read = batch.read;
  const isLoading = batch.isLoading;
  const isError = batch.isError;
  const refetch = batch.refetch;
  const tileProps: TileProps = { read, isLoading };

  // v1.15.11 — the vitals-grid tiles in resolved layout order, dropping
  // any the user has hidden. Each tile is `{ id, order, node }`; the tile's
  // own component still self-gates on data, so a visible tile with no readings
  // still renders nothing. The four derived re-frames map to the slug of the
  // metric they re-frame; the per-vital baseline tiles map by `MeasurementType`.
  const vitalTiles = useMemo(() => {
    const entries: { id: string; order: number; node: ReactNode }[] = [
      {
        id: "cardio-fitness",
        order: tileOrder(layout, "cardio-fitness"),
        node: <FitnessAgeTile key="cardio-fitness" {...tileProps} />,
      },
      {
        id: "vascular-age",
        order: tileOrder(layout, "vascular-age"),
        node: <VascularAgeTile key="vascular-age" {...tileProps} />,
      },
      {
        id: "hrv",
        order: tileOrder(layout, "hrv"),
        node: <HrvBalanceTile key="hrv" {...tileProps} />,
      },
      {
        id: "bmi",
        order: tileOrder(layout, "bmi"),
        node: <BmiTile key="bmi" {...tileProps} />,
      },
      ...SECTION_VITALS.filter((type) => type !== "HEART_RATE_VARIABILITY").map(
        (type) => {
          const id = VITAL_BASELINE_TILE_LAYOUT_ID[type] ?? type;
          return {
            id,
            order: tileOrder(layout, id),
            node: (
              <BaselineTile
                key={type}
                metric="VITALS_BASELINE"
                type={type}
                {...tileProps}
              />
            ),
          };
        },
      ),
    ];
    return entries
      .filter((e) => tileVisible(layout, e.id))
      .sort((a, b) => a.order - b.order);
    // `tileProps` is rebuilt every render (read/isLoading); the node closures
    // capture the current values, so memoising on the layout + load state keeps
    // the ordered list stable across a no-op rerender without staleness.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, read, isLoading]);

  const mobilityTiles = useMemo(() => {
    const entries: { id: string; order: number; node: ReactNode }[] = [
      {
        id: "six-minute-walk",
        order: tileOrder(layout, "six-minute-walk"),
        node: <SixMinuteWalkTile key="six-minute-walk" {...tileProps} />,
      },
      ...SECTION_MOBILITY.map(({ metric, type }) => {
        const id = MOBILITY_TILE_LAYOUT_ID[type] ?? type;
        return {
          id,
          order: tileOrder(layout, id),
          node: (
            <BaselineTile
              key={metric}
              metric={metric}
              type={type}
              {...tileProps}
            />
          ),
        };
      }),
    ];
    return entries
      .filter((e) => tileVisible(layout, e.id))
      .sort((a, b) => a.order - b.order);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, read, isLoading]);

  const cumulativeTiles = useMemo(() => {
    return SECTION_CUMULATIVE.map((type) => {
      const id = CUMULATIVE_TILE_LAYOUT_ID[type] ?? type;
      return {
        id,
        order: tileOrder(layout, id),
        node: <SameTimeBaselineTile key={type} type={type} {...tileProps} />,
      };
    })
      .filter((e) => tileVisible(layout, e.id))
      .sort((a, b) => a.order - b.order);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, read, isLoading]);

  // A failed batch (retry:0 + the 8 s client ceiling) must read as an error,
  // not as "no data" — otherwise the whole Vitals + Wellness surface silently
  // vanishes. Surface a compact message + a Retry that refetches the one
  // batch query both strips share.
  if (isError) {
    return (
      <div
        data-slot="vitals-dashboard-wrap"
        className={cn("space-y-6", className)}
      >
        <section
          data-slot="vitals-dashboard"
          aria-label={t("insights.derived.vitals.sectionTitle")}
          className="space-y-3"
        >
          <SectionHeading
            icon={HeartPulse}
            title={t("insights.derived.vitals.sectionTitle")}
            subtitle={t("insights.derived.vitals.sectionSubtitle")}
          />
          <QueryErrorRow
            error={batch.error}
            slot="vitals-dashboard-error"
            retrySlot="vitals-dashboard-retry"
            message={t("insights.derived.vitals.loadError")}
            onRetry={() => refetch()}
          />
        </section>
      </div>
    );
  }

  // The heading only renders once there is content under it (or while the
  // skeleton row reserves the final height). When the batch resolves to zero
  // vitals the heading would otherwise strand over blank space, then content
  // pops in below it — the CLS this pass removes.
  const showSection = isLoading || hasRenderableVital(read, layout);
  const showMobility = !isLoading && hasRenderableMobility(read, layout);
  const showSameTime = !isLoading && hasRenderableSameTime(read, layout);

  return (
    <div
      data-slot="vitals-dashboard-wrap"
      className={cn("space-y-6", className)}
    >
      {showSection && (
        <section
          data-slot="vitals-dashboard"
          aria-label={t("insights.derived.vitals.sectionTitle")}
          className="space-y-3"
        >
          <SectionHeading
            icon={HeartPulse}
            title={t("insights.derived.vitals.sectionTitle")}
            subtitle={t("insights.derived.vitals.sectionSubtitle")}
          />
          <div
            data-slot="vitals-dashboard-grid"
            // The loading label needs a role to name (axe:
            // aria-prohibited-attr); the loaded grid carries neither.
            role={isLoading ? "status" : undefined}
            aria-busy={isLoading}
            aria-live="polite"
            aria-label={
              isLoading ? t("insights.derived.vitals.loadingLabel") : undefined
            }
            className={cn(
              "grid grid-cols-1 gap-3",
              // Multi-column only when the skeleton row or more than one tile
              // fills it; a lone tile spans the full width rather than sitting
              // in a one-third column with dead space beside it.
              (isLoading || vitalTiles.length > 1) &&
                "sm:grid-cols-2 lg:grid-cols-3",
            )}
          >
            {isLoading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <VitalsTileSkeleton key={`vitals-skeleton-${i}`} />
                ))
              : vitalTiles.map((tile) => tile.node)}
          </div>
        </section>
      )}
      {showSameTime && (
        <section
          data-slot="vitals-same-time"
          aria-label={t("insights.derived.sameTime.sectionTitle")}
          className="space-y-3"
        >
          <SectionHeading
            icon={Footprints}
            title={t("insights.derived.sameTime.sectionTitle")}
            subtitle={t(sameTimeSubtitleKey(read, layout))}
          />
          <div
            data-slot="vitals-same-time-grid"
            className={cn(
              "grid grid-cols-1 gap-4",
              // A lone tile spans the full width rather than orphaning a
              // one-third column, matching the sections above it.
              cumulativeTiles.length > 1 && "sm:grid-cols-2 lg:grid-cols-3",
            )}
          >
            {cumulativeTiles.map((tile) => tile.node)}
          </div>
        </section>
      )}
      {showMobility && (
        <section
          data-slot="vitals-mobility"
          aria-label={t("insights.derived.vitals.mobilitySectionTitle")}
          className="space-y-3"
        >
          <SectionHeading
            icon={Footprints}
            title={t("insights.derived.vitals.mobilitySectionTitle")}
          />
          <div
            data-slot="vitals-mobility-grid"
            className={cn(
              "grid grid-cols-1 gap-3",
              // A lone mobility tile spans the full width rather than
              // orphaning a one-third column.
              mobilityTiles.length > 1 && "sm:grid-cols-2 lg:grid-cols-3",
            )}
          >
            {mobilityTiles.map((tile) => tile.node)}
          </div>
        </section>
      )}
    </div>
  );
}
