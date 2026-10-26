"use client";

import type { ReactNode } from "react";
import {
  Activity,
  Bone,
  Droplet,
  Droplets,
  Dumbbell,
  Footprints,
  Gauge,
  GlassWater,
  Heart,
  HeartPulse,
  Moon,
  Percent,
  Smile,
  Target,
  Thermometer,
  TrendingUp,
  Wind,
} from "lucide-react";

import { TrendCard } from "@/components/charts/trend-card";
import {
  getRangeColorClass,
  getRangeHint,
  toHoursSummary,
} from "@/components/dashboard/range-display";
import { SleepSourceDiscrepancyMarker } from "@/components/insights/sleep-source-discrepancy-marker";
import { summaryToTrend7Delta } from "@/lib/analytics/trend-delta";
import { isWindowSufficient } from "@/lib/analytics/window-confidence";
import { convertGlucose, glucoseFractionDigits } from "@/lib/glucose";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/lib/measurements/type-label-keys";
import type { TrendDirectionSentiment } from "@/lib/insights/trend-sentiment";

import type { DashboardTileContext } from "./tile-context";

/** One card in the tile strip, positioned by `order`. */
export interface StripEntry {
  id: string;
  order: number;
  node: ReactNode;
}

/**
 * A strip tile: which layout widget switches and orders it, the rule that
 * decides whether it has anything to show, and the card(s) it paints.
 *
 * The layout toggle is applied by `buildStripEntries` for every tile, so
 * `visible` holds only the tile's own rule (a data floor, a module gate).
 * A tile can paint more than one card (blood pressure paints two, glucose one
 * per meal-time context); each card's `orderOffset` keeps them together
 * behind the widget's position.
 */
interface StripTile {
  widget: string;
  visible: (ctx: DashboardTileContext) => boolean;
  cards: (
    ctx: DashboardTileContext,
  ) => Array<{ id: string; orderOffset?: number; node: ReactNode }>;
}

const countOf = (summary: { count?: number } | null | undefined) =>
  summary?.count ?? 0;

/**
 * The pulse tile shows ONE of two statistics, and its name says which. With
 * resting rows it is the resting heart rate (one figure a day, judged against
 * the resting band); without them it is the pulse, whose latest value is the
 * latest day's mean of its hours' means, and no resting band colours it (it
 * would mark workout heart rate as "outside target").
 */
function pulseSource(ctx: DashboardTileContext) {
  const rhr = ctx.summaries?.RESTING_HEART_RATE;
  const hasRestingHr = countOf(rhr) > 0;
  return {
    hasRestingHr,
    summary: hasRestingHr ? rhr : ctx.summaries?.PULSE,
    type: hasRestingHr ? "RESTING_HEART_RATE" : "PULSE",
  };
}

type Summary = NonNullable<DashboardTileContext["summaries"]>[string];
type TrafficRange = Parameters<typeof getRangeColorClass>[1]["range"];

/**
 * One metric tile: the headline, its 7- and 30-day means, the trend and the
 * comparison delta. `type` names the series (direction and freshness follow
 * it unless overridden); `summary` replaces the summary read off `type`.
 * With `display` the values go through the metric / imperial transform, and
 * with `range` the means are coloured against it (on the canonical values)
 * and carry its hint (in `hintRange`, the display unit, when given).
 */
function metricCard(
  ctx: DashboardTileContext,
  id: string,
  props: {
    type: string;
    label: string;
    unit: string;
    icon: React.ComponentType<{ className?: string }>;
    summary?: Summary | null;
    display?: boolean;
    fractionDigits?: number;
    range?: TrafficRange;
    hintRange?: TrafficRange;
    direction?: TrendDirectionSentiment;
    staleType?: string | null;
    valueAdornment?: ReactNode;
  },
): ReactNode {
  const s = "summary" in props ? props.summary : ctx.summaries?.[props.type];
  const value = (v: number | null | undefined) =>
    props.display ? ctx.td(props.type, v) : (v ?? null);
  const delta = (v: number | null | undefined) =>
    props.display ? ctx.tdd(props.type, v) : v;
  const hint =
    props.range === undefined
      ? undefined
      : getRangeHint(
          props.unit,
          { range: props.hintRange ?? props.range },
          ctx.t,
          ctx.fmt.number,
        );
  return (
    <TrendCard
      key={id}
      fractionDigits={props.fractionDigits}
      label={props.label}
      latest={value(s?.latest)}
      unit={props.unit}
      avg7={value(s?.avg7)}
      avg30={value(s?.avg30)}
      avg7ColorClass={
        props.range === undefined
          ? undefined
          : getRangeColorClass(s?.avg7, { range: props.range })
      }
      avg30ColorClass={
        props.range === undefined
          ? undefined
          : getRangeColorClass(s?.avg30, { range: props.range })
      }
      avg7Hint={hint}
      avg30Hint={hint}
      slope30={s?.slope30 ?? null}
      trend7Delta={delta(summaryToTrend7Delta(s)) as number | null}
      icon={props.icon}
      directionSentiment={props.direction ?? ctx.directionOf(props.type)}
      compareBaseline={ctx.compareBaseline}
      compareDelta={delta(ctx.tileCompareDelta(s)) as number | null}
      staleDays={ctx.tileStaleDays(
        props.staleType === undefined ? props.type : props.staleType,
      )}
      valueAdornment={props.valueAdornment}
    />
  );
}

/** A tile that paints one card under its own id. */
function one(
  widget: string,
  visible: StripTile["visible"],
  node: (ctx: DashboardTileContext) => ReactNode,
): StripTile {
  return { widget, visible, cards: (ctx) => [{ id: widget, node: node(ctx) }] };
}

/** A plain metric tile, shown when its series has a reading. */
function metricTile(
  widget: string,
  type: string,
  props: (
    ctx: DashboardTileContext,
  ) => Omit<Parameters<typeof metricCard>[2], "type">,
): StripTile {
  return one(
    widget,
    (ctx) => countOf(ctx.summaries?.[type]) > 0,
    (ctx) => metricCard(ctx, widget, { type, ...props(ctx) }),
  );
}

/**
 * Every strip tile, in the order the cards are collected. Cards are then
 * sorted by their layout order (a stable sort), so for two widgets that share
 * an order this list decides which comes first.
 */
export const STRIP_TILES: readonly StripTile[] = [
  metricTile("weight", "WEIGHT", (ctx) => ({
    label: ctx.t("dashboard.weightShort"),
    unit: ctx.unitDisplay.unitFor("WEIGHT"),
    icon: Activity,
    display: true,
    range: ctx.weightRange,
    hintRange: ctx.weightHintRange,
    // Which way is progress depends on the person's own target, resolved
    // on the server.
    direction: ctx.weightTrend.direction,
  })),
  {
    // One signal, two tiles: systolic and diastolic side by side at the size
    // of every other tile. The diastolic card's offset keeps it right behind
    // the systolic one.
    widget: "bp",
    visible: (ctx) =>
      countOf(ctx.summaries?.BLOOD_PRESSURE_SYS) > 0 ||
      countOf(ctx.summaries?.BLOOD_PRESSURE_DIA) > 0,
    cards: (ctx) => [
      {
        id: "bp-sys",
        node: metricCard(ctx, "bp-sys", {
          type: "BLOOD_PRESSURE_SYS",
          label: ctx.t("dashboard.bloodPressureSysShort"),
          unit: "mmHg",
          icon: Heart,
          fractionDigits: 0,
          range: ctx.bpSysRange,
        }),
      },
      {
        id: "bp-dia",
        orderOffset: 0.001,
        node: metricCard(ctx, "bp-dia", {
          type: "BLOOD_PRESSURE_DIA",
          label: ctx.t("dashboard.bloodPressureDiaShort"),
          unit: "mmHg",
          icon: Heart,
          fractionDigits: 0,
          range: ctx.bpDiaRange,
        }),
      },
    ],
  },
  one(
    "pulse",
    (ctx) =>
      countOf(ctx.summaries?.PULSE) > 0 ||
      countOf(ctx.summaries?.RESTING_HEART_RATE) > 0,
    (ctx) => {
      const { hasRestingHr, summary, type } = pulseSource(ctx);
      return metricCard(ctx, "pulse", {
        type,
        summary,
        label: hasRestingHr
          ? ctx.t(MEASUREMENT_TYPE_LABEL_KEYS.RESTING_HEART_RATE)
          : ctx.t("dashboard.pulseShort"),
        unit: "bpm",
        icon: TrendingUp,
        fractionDigits: 0,
        range: hasRestingHr ? ctx.pulseDisplayRange : null,
      });
    },
  ),
  metricTile("bodyFat", "BODY_FAT", (ctx) => ({
    label: ctx.t("dashboard.bodyFatShort"),
    unit: "%",
    icon: Percent,
  })),
  one(
    "mood",
    (ctx) => countOf(ctx.moodSummary) > 0,
    (ctx) =>
      metricCard(ctx, "mood", {
        type: "MOOD",
        summary: ctx.moodSummary,
        label: ctx.t("dashboard.moodShort"),
        unit: "/ 5",
        icon: Smile,
        staleType: null,
      }),
  ),
  one(
    "sleep",
    (ctx) => countOf(ctx.summaries?.SLEEP_DURATION) > 0,
    (ctx) => {
      // The summary carries per-night time asleep in MINUTES; the tile
      // reads hours, so every value field converts while the staleness and
      // count metadata stay as they are.
      const raw = ctx.summaries?.SLEEP_DURATION;
      const discrepancy = ctx.data?.sleepSourceDiscrepancy;
      return metricCard(ctx, "sleep", {
        type: "SLEEP_DURATION",
        summary: raw ? toHoursSummary(raw) : undefined,
        label: ctx.t("dashboard.sleepShort") ?? "Sleep",
        unit: "h",
        icon: Moon,
        // A discreet "sources disagree" marker beside the headline when two
        // writers reported clearly different totals for the latest night.
        // Null on the ordinary path: no layout change.
        valueAdornment: discrepancy ? (
          <SleepSourceDiscrepancyMarker discrepancy={discrepancy} />
        ) : null,
      });
    },
  ),
  // Steps are activity data tied to the workouts module; only an explicit
  // `false` hides them (fail-open).
  one(
    "steps",
    (ctx) =>
      countOf(ctx.summaries?.ACTIVITY_STEPS) > 0 &&
      ctx.user?.modules?.workouts !== false,
    (ctx) =>
      metricCard(ctx, "steps", {
        type: "ACTIVITY_STEPS",
        label: ctx.t("dashboard.stepsShort") ?? "Steps",
        unit: "",
        icon: Footprints,
        fractionDigits: 0,
      }),
  ),
  metricTile("vo2Max", "VO2_MAX", (ctx) => ({
    label: ctx.t("dashboard.vo2MaxShort") ?? "VO₂ max",
    unit: ctx.t("dashboard.vo2MaxUnit") ?? "mL/(kg·min)",
    icon: Gauge,
  })),
  // HRV is stored under two types (SDNN from Apple Health / Health Connect,
  // nightly RMSSD from rings and straps); `pickHrvSummary` names the one
  // shown, and the label, the direction and the freshness caption follow it.
  // Each series has its OWN label key, never a base label with the measure
  // appended: the label renders truncated on one line, and an appended
  // marker is the first thing a longer locale drops.
  one(
    "hrv",
    (ctx) => countOf(ctx.hrv.summary) > 0,
    (ctx) =>
      metricCard(ctx, "hrv", {
        type: ctx.hrv.type,
        summary: ctx.hrv.summary,
        label: ctx.t(ctx.hrv.labelKey),
        unit: "ms",
        icon: HeartPulse,
        fractionDigits: 0,
      }),
  ),
  metricTile("oxygenSaturation", "OXYGEN_SATURATION", (ctx) => ({
    label: ctx.t("measurements.typeOxygenSaturation"),
    unit: "%",
    icon: Droplets,
  })),
  metricTile("respiratoryRate", "RESPIRATORY_RATE", (ctx) => ({
    label: ctx.t("measurements.typeRespiratoryRate"),
    unit: ctx.t("insights.units.respiratoryRate"),
    icon: Wind,
  })),
  metricTile("wristTemperature", "WRIST_TEMPERATURE", (ctx) => ({
    label: ctx.t("measurements.typeWristTemperature"),
    unit: ctx.unitDisplay.unitFor("WRIST_TEMPERATURE"),
    icon: Thermometer,
    display: true,
  })),
  metricTile("muscleMass", "MUSCLE_MASS", (ctx) => ({
    label: ctx.t("measurements.typeMuscleMass"),
    unit: ctx.unitDisplay.unitFor("MUSCLE_MASS"),
    icon: Dumbbell,
    display: true,
  })),
  metricTile("totalBodyWater", "TOTAL_BODY_WATER", (ctx) => ({
    label: ctx.t("measurements.typeTotalBodyWater"),
    unit: ctx.unitDisplay.unitFor("TOTAL_BODY_WATER"),
    icon: Droplet,
    display: true,
  })),
  metricTile("boneMass", "BONE_MASS", (ctx) => ({
    label: ctx.t("measurements.typeBoneMass"),
    unit: ctx.unitDisplay.unitFor("BONE_MASS"),
    icon: Bone,
    display: true,
  })),
  // Fluid intake: a synthetic summary key derived server-side from the
  // nutrient days. Neutral sentiment, since more water is not simply better.
  metricTile("waterIntake", "NUTRIENT_WATER", (ctx) => ({
    label: ctx.t("nutrients.names.water"),
    unit: "mL",
    icon: GlassWater,
  })),
  {
    // Blood pressure in target. Hidden while every window reads zero, so a
    // literal "0 %" never rides the dashboard; the headline is the trailing
    // 90-day share, the label names the effective span until 90 days of
    // history exist, and below the confidence floor the tile says it is
    // still collecting instead of printing a figure.
    widget: "bpInTarget",
    visible: (ctx) =>
      ctx.data?.bpInTargetPct != null &&
      [
        ctx.data?.bpInTargetPct,
        ctx.data?.bpInTargetPct7d,
        ctx.data?.bpInTargetPct30d,
        ctx.data?.bpInTargetPctAllTime,
      ].some((pct) => pct != null && pct > 0),
    cards: (ctx) => {
      const data = ctx.data;
      const bp7 = data?.bpInTargetPct7d ?? null;
      const bp30 = data?.bpInTargetPct30d ?? null;
      const bpPriorMonth = data?.bpInTargetPctPriorMonth ?? null;
      const bpPriorYear = data?.bpInTargetPctPriorYear ?? null;
      const bpTrendDelta = bp7 !== null && bp30 !== null ? bp7 - bp30 : null;
      const bpComparePrior =
        ctx.compareBaseline === "lastMonth"
          ? bpPriorMonth
          : ctx.compareBaseline === "lastYear"
            ? bpPriorYear
            : null;
      const bpCompareDelta =
        ctx.compareBaseline === "none" ||
        bp30 === null ||
        bpComparePrior === null
          ? null
          : Math.round((bp30 - bpComparePrior) * 10) / 10;
      const bpCount90 = data?.bpInTargetCount90 ?? null;
      const bpSpanDays90 = data?.bpInTargetSpanDays90 ?? null;
      const bpSufficient = bpCount90 === null || isWindowSufficient(bpCount90);
      const bpLabel =
        bpSpanDays90 != null
          ? ctx.t("dashboard.bpInTargetWindowDynamic", { days: bpSpanDays90 })
          : ctx.t("dashboard.bpInTargetWindow90");
      return [
        {
          id: "bpInTarget",
          node: (
            <TrendCard
              key="bpInTarget"
              label={bpLabel}
              latest={bpSufficient ? (data?.bpInTargetPct ?? null) : null}
              emptyHint={
                bpSufficient ? null : ctx.t("dashboard.bpInTargetCollecting")
              }
              unit="%"
              avg7={bpSufficient ? bp7 : null}
              avg30={bpSufficient ? bp30 : null}
              slope30={null}
              trend7Delta={bpSufficient ? bpTrendDelta : null}
              icon={Target}
              directionSentiment={ctx.directionOf("BLOOD_PRESSURE_IN_TARGET")}
              compareBaseline={ctx.compareBaseline}
              compareDelta={bpSufficient ? bpCompareDelta : null}
            />
          ),
        },
      ];
    },
  },
  {
    // One card per meal-time bucket, kept together in a block.
    widget: "glucose",
    visible: (ctx) => ctx.glucoseTiles.length > 0,
    cards: (ctx) =>
      ctx.glucoseTiles.map(({ bucket, labelKey, summary: s }, idx) => {
        const unit = ctx.displayGlucoseUnit;
        const convert = (v: number | null | undefined) =>
          v != null ? convertGlucose(v, unit) : null;
        return {
          id: `glucose-${bucket}`,
          orderOffset: idx / 1000,
          node: (
            <TrendCard
              key={`glucose-${bucket}`}
              label={ctx.t(labelKey)}
              latest={convert(s.latest)}
              unit={unit}
              fractionDigits={glucoseFractionDigits(unit)}
              avg7={convert(s.avg7)}
              avg30={convert(s.avg30)}
              slope30={s.slope30 ?? null}
              icon={Droplet}
              staleDays={ctx.tileStaleDays("BLOOD_GLUCOSE")}
            />
          ),
        };
      }),
  },
];

/**
 * The strip's cards for this render: every tile whose layout toggle is on and
 * whose own rule passes, sorted by layout order.
 */
export function buildStripEntries(ctx: DashboardTileContext): StripEntry[] {
  const entries: StripEntry[] = [];
  for (const tile of STRIP_TILES) {
    if (!ctx.isTileVisible(tile.widget) || !tile.visible(ctx)) continue;
    const order = ctx.widgetOrder(tile.widget);
    for (const card of tile.cards(ctx)) {
      entries.push({
        id: card.id,
        order: order + (card.orderOffset ?? 0),
        node: card.node,
      });
    }
  }
  entries.sort((a, b) => a.order - b.order);
  return entries;
}
