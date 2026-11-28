/**
 * Where a dashboard tile's comparison lines (the 7- and 30-day means) sit
 * against the person's target band: `tiles.comparison` on the snapshot.
 *
 * One rule for every band judgement on the tiles: {@link rangeTone} places a
 * value in a resolved `TrafficRange` through the same `makeRangeClassifier`
 * the targets page and its consistency strips use, and tile attention reads
 * the same function for its `range` reason. The client renders the served
 * tone and never places a value in a band itself
 * (`src/__tests__/client-band-classification-guard.test.ts`).
 */
import type { DataSummary } from "@/lib/analytics/trends";
import type { TrafficRange } from "@/lib/analytics/value-bands";
import type { DashboardTargetBands } from "@/lib/dashboard/bands";
import { makeRangeClassifier } from "@/lib/targets/consistency";

import type { TileAttentionMap } from "./tile-priority";

/** Inside the green band, in the orange wings, beyond them. */
export const COMPARISON_BANDS = ["good", "fair", "low"] as const;
export type ComparisonBand = (typeof COMPARISON_BANDS)[number];
/** Which edge of the green band a value outside it crossed. */
export const COMPARISON_SIDES = ["above", "below"] as const;
export type ComparisonSide = (typeof COMPARISON_SIDES)[number];

export interface ComparisonTone {
  /** Null when there is no value or no band to judge it against. */
  band: ComparisonBand | null;
  /** Null inside the band and when `band` is null. */
  side: ComparisonSide | null;
}

export interface TileComparison {
  avg7: ComparisonTone;
  avg30: ComparisonTone;
  /**
   * The tile's deviation line in the response language ("Above target
   * range"), only while `tiles.attention[id]` is `range`: avg7's side when
   * it has one, else avg30's. Null otherwise, so a tile whose reading is back
   * in range never carries one.
   */
  line: string | null;
}

/** Per tile widget id; a tile without a target band is absent. */
export type TileComparisonMap = Partial<Record<string, TileComparison>>;

const BAND_OF = { in: "good", near: "fair", out: "low" } as const;
const UNJUDGED: ComparisonTone = { band: null, side: null };

/** One value against one resolved range. */
export function rangeTone(
  value: number | null | undefined,
  range: TrafficRange | null | undefined,
): ComparisonTone {
  if (value == null || !Number.isFinite(value) || !range) return UNJUDGED;
  const day = makeRangeClassifier(
    { min: range.greenMin, max: range.greenMax },
    { orangeMin: range.orangeMin, orangeMax: range.orangeMax },
  )(value);
  if (!day) return UNJUDGED;
  return {
    band: BAND_OF[day],
    side: day === "in" ? null : value > range.greenMax ? "above" : "below",
  };
}

const SEVERITY: Record<ComparisonBand, number> = { good: 1, fair: 2, low: 3 };
const severity = (tone: ComparisonTone) =>
  tone.band ? SEVERITY[tone.band] : 0;

/** The side further from its band; systolic on a tie. */
const worse = (sys: ComparisonTone, dia: ComparisonTone) =>
  severity(sys) >= severity(dia) ? sys : dia;

const hasReadings = (s: DataSummary | undefined) => (s?.count ?? 0) > 0;

type Means = Omit<TileComparison, "line">;

const bothMeans = (
  s: DataSummary | undefined,
  range: TrafficRange | null,
): Means => ({
  avg7: rangeTone(s?.avg7, range),
  avg30: rangeTone(s?.avg30, range),
});

/** The message key of each side's line (`dashboard.tileComparison.*`). */
const LINE_KEY: Record<ComparisonSide, string> = {
  above: "dashboard.tileComparison.above",
  below: "dashboard.tileComparison.below",
};

/**
 * The comparison tones of the tiles that have a target band: weight, blood
 * pressure (the side further from its band colours the pair) and the resting
 * heart rate (a pulse tile without resting rows has no band and is absent).
 * `attention` is the snapshot's `tiles.attention`; `t` words the line.
 */
export function resolveTileComparison(input: {
  summaries: Record<string, DataSummary>;
  bands: DashboardTargetBands;
  attention: TileAttentionMap;
  t: (key: string) => string;
}): TileComparisonMap {
  const { summaries, bands, attention, t } = input;
  const means: Partial<Record<string, Means>> = {};
  if (hasReadings(summaries.WEIGHT) && bands.weightRange) {
    means.weight = bothMeans(summaries.WEIGHT, bands.weightRange);
  }
  const sys = summaries.BLOOD_PRESSURE_SYS;
  const dia = summaries.BLOOD_PRESSURE_DIA;
  if (
    (hasReadings(sys) || hasReadings(dia)) &&
    (bands.bpSysRange || bands.bpDiaRange)
  ) {
    const s = bothMeans(sys, bands.bpSysRange);
    const d = bothMeans(dia, bands.bpDiaRange);
    means.bp = { avg7: worse(s.avg7, d.avg7), avg30: worse(s.avg30, d.avg30) };
  }
  if (hasReadings(summaries.RESTING_HEART_RATE)) {
    means.pulse = bothMeans(
      summaries.RESTING_HEART_RATE,
      bands.pulseDisplayRange,
    );
  }
  const out: TileComparisonMap = {};
  for (const [widget, m] of Object.entries(means)) {
    if (!m) continue;
    const side = m.avg7.side ?? m.avg30.side;
    out[widget] = {
      ...m,
      line: attention[widget] === "range" && side ? t(LINE_KEY[side]) : null,
    };
  }
  return out;
}
