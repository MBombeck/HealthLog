/**
 * Which dashboard tiles have something to say today (`TileAttention`), from
 * the reads the snapshot already holds: the summaries, the last-seen
 * timestamps and the resolved target bands. No query of its own.
 */
import type { DataSummary } from "@/lib/analytics/trends";
import type { DashboardTargetBands } from "@/lib/dashboard/bands";
import type { DashboardLayout } from "@/lib/dashboard-layout";
import { userDayKey } from "@/lib/tz/format";

import {
  orderStripWidgets,
  type TileAttention,
  type TileAttentionMap,
} from "./tile-priority";

/** The measurement types a tile reads, the one it shows first. */
const TILE_TYPES: Readonly<Record<string, readonly string[]>> = {
  weight: ["WEIGHT"],
  bp: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
  pulse: ["RESTING_HEART_RATE", "PULSE"],
  hrv: ["HEART_RATE_VARIABILITY", "HRV_RMSSD"],
  oxygenSaturation: ["OXYGEN_SATURATION"],
  respiratoryRate: ["RESPIRATORY_RATE"],
  wristTemperature: ["WRIST_TEMPERATURE"],
  bodyFat: ["BODY_FAT"],
  muscleMass: ["MUSCLE_MASS"],
  totalBodyWater: ["TOTAL_BODY_WATER"],
  boneMass: ["BONE_MASS"],
  sleep: ["SLEEP_DURATION"],
  steps: ["ACTIVITY_STEPS"],
  vo2Max: ["VO2_MAX"],
  glucose: ["BLOOD_GLUCOSE"],
  waterIntake: ["NUTRIENT_WATER"],
  energyIntake: ["NUTRIENT_ENERGY"],
};

/** A week's fit must reach this R² before it counts as a clear change. */
const CHANGE_MIN_CONFIDENCE = 0.7;
/** ...and add up to at least this share of the monthly mean. */
const CHANGE_MIN_SHARE = 0.05;
/** A reading older than this says nothing about today. */
const FRESH_DAYS = 7;

type GreenRange = { greenMin: number; greenMax: number } | null | undefined;

const outside = (value: number | null | undefined, range: GreenRange) =>
  value != null &&
  range != null &&
  (value < range.greenMin || value > range.greenMax);

function clearChange(s: DataSummary): boolean {
  const slope = s.slope7;
  if (!slope || slope.confidence < CHANGE_MIN_CONFIDENCE) return false;
  if (s.avg30 == null || s.avg30 === 0) return false;
  return Math.abs(slope.slope * 7) >= CHANGE_MIN_SHARE * Math.abs(s.avg30);
}

export function resolveTileAttention(input: {
  summaries: Record<string, DataSummary>;
  lastSeenByType: Record<string, { lastSeenAt: string } | null>;
  bands: DashboardTargetBands;
  now: Date;
  timezone: string;
}): TileAttentionMap {
  const { summaries, lastSeenByType, bands, now, timezone } = input;
  const todayKey = userDayKey(now, timezone);
  const ranges: Record<string, GreenRange> = {
    WEIGHT: bands.weightRange,
    BLOOD_PRESSURE_SYS: bands.bpSysRange,
    BLOOD_PRESSURE_DIA: bands.bpDiaRange,
    RESTING_HEART_RATE: bands.pulseDisplayRange,
  };
  const out: TileAttentionMap = {};
  for (const [widget, types] of Object.entries(TILE_TYPES)) {
    // The tile shows the first type that has readings (resting heart rate
    // before pulse, SDNN before RMSSD); blood pressure judges both sides.
    const shown = types.filter((type) => (summaries[type]?.count ?? 0) > 0);
    const judged = widget === "bp" ? shown : shown.slice(0, 1);
    let best: TileAttention | null = null;
    for (const type of judged) {
      const s = summaries[type];
      const seen = lastSeenByType[type]?.lastSeenAt;
      if (!s || !seen) continue;
      const seenAt = new Date(seen);
      if (now.getTime() - seenAt.getTime() > FRESH_DAYS * 86_400_000) continue;
      const reason: TileAttention | null = outside(s.latest, ranges[type])
        ? "range"
        : clearChange(s)
          ? "change"
          : userDayKey(seenAt, timezone) === todayKey
            ? "today"
            : null;
      if (reason === "range" || (reason && best !== "change")) best = reason;
      if (best === "range") break;
    }
    if (best) out[widget] = best;
  }
  return out;
}

/**
 * The snapshot with `tiles.attention` and `tiles.order` filled in, from the
 * bands, summaries, last-seen times and layout it already carries.
 */
export function withTileOrder<
  S extends {
    user: { timezone: string };
    layout: DashboardLayout;
    targetBands: DashboardTargetBands;
    generatedAt: string;
    tiles: {
      summaries: Record<string, DataSummary>;
      lastSeenByType: Record<string, { lastSeenAt: string } | null>;
      attention?: TileAttentionMap;
      order?: string[];
    };
  },
>(snapshot: S): S {
  const attention = resolveTileAttention({
    summaries: snapshot.tiles.summaries,
    lastSeenByType: snapshot.tiles.lastSeenByType,
    bands: snapshot.targetBands,
    now: new Date(snapshot.generatedAt),
    timezone: snapshot.user.timezone,
  });
  return {
    ...snapshot,
    tiles: {
      ...snapshot.tiles,
      attention,
      order: orderStripWidgets(snapshot.layout, attention),
    },
  };
}
