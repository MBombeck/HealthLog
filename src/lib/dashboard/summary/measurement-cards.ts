/**
 * The measurement-backed cards of the dashboard summary, in emit order:
 * weight, blood pressure, pulse, body fat, then the optional cards. Every
 * card carries `allTimeCount` + `lastSeenAt` so the iOS tile renderer can
 * keep a metric visible during a logging gap (gate on `allTimeCount > 0`)
 * and paint a muted "last reading N days ago" caption when the most recent
 * reading is older than the 7-day sparkline window.
 */
import type { SleepStage } from "@/generated/prisma/client";
import type {
  summarizeSleepNights,
  SleepStageRow,
} from "@/lib/analytics/sleep-night";

import {
  buildSleepSparkline,
  OPTIONAL_CARD_TYPES,
  plainCard,
  sleepCard,
  type MetricCard,
} from "./cards";
import type { SummaryLookups } from "./lookups";

export interface SummarySleepInput {
  summary: ReturnType<typeof summarizeSleepNights>;
  rows: SleepStageRow[];
  tz: string;
  priorityJson: unknown;
}

/**
 * Blood pressure is a paired metric: the tile is "alive" whenever either
 * side of the pair has history, and an account that has never logged it
 * gets no empty placeholder tile. The count sums both sides; the most
 * recent last-seen instant of the two drives the staleness hint.
 */
function bloodPressureCard(lookups: SummaryLookups): MetricCard | null {
  const latestSys = lookups.latestOf("BLOOD_PRESSURE_SYS");
  const latestDia = lookups.latestOf("BLOOD_PRESSURE_DIA");
  const sysSpark = lookups.sparkOf("BLOOD_PRESSURE_SYS");
  const sysMeta = lookups.metaForType("BLOOD_PRESSURE_SYS");
  const diaMeta = lookups.metaForType("BLOOD_PRESSURE_DIA");
  const bpAllTimeCount = sysMeta.allTimeCount + diaMeta.allTimeCount;
  const bpLastSeenAt = ((): string | null => {
    const sysAt = sysMeta.lastSeenAt;
    const diaAt = diaMeta.lastSeenAt;
    if (!sysAt) return diaAt;
    if (!diaAt) return sysAt;
    return sysAt >= diaAt ? sysAt : diaAt;
  })();
  if (!latestSys && !latestDia && bpAllTimeCount === 0) return null;
  return plainCard("bp", "bloodPressure", {
    latestValue: latestSys?.value ?? null,
    secondaryValue: latestDia?.value ?? null,
    spark: sysSpark,
    updatedAt:
      latestSys?.at?.toISOString() ??
      latestDia?.at?.toISOString() ??
      bpLastSeenAt,
    allTimeCount: bpAllTimeCount,
    lastSeenAt: bpLastSeenAt,
  });
}

/**
 * Sleep is night-aggregated, not single-stage: the latest night's TIME
 * ASLEEP (CORE/light + DEEP + REM, excluding IN_BED + AWAKE) in HOURS, the
 * per-stage breakdown, and a sparkline of the trailing nights' asleep hours
 * from the night reconstruction (the DAY-bucket rollup sparkline blends
 * stages and would be misleading for sleep).
 */
function sleepNightCard(
  sleep: SummarySleepInput,
  meta: { allTimeCount: number; lastSeenAt: string | null },
): MetricCard {
  const night = sleep.summary.latestNight;
  const toHours = (minutes: number): number =>
    Math.round((minutes / 60) * 100) / 100;
  const nightSpark = buildSleepSparkline(
    sleep.rows,
    sleep.tz,
    sleep.priorityJson,
  );
  const stageHours: Partial<Record<SleepStage, number>> | null = night
    ? Object.fromEntries(
        Object.entries(night.stages).map(([s, m]) => [s, toHours(m)]),
      )
    : null;
  return sleepCard({
    latestValue: night ? toHours(night.asleepMinutes) : null,
    sleepStages:
      stageHours && Object.keys(stageHours).length > 0 ? stageHours : null,
    // Additive, observational: the headline night's MAIN session saw two
    // writer buckets with clearly different asleep totals. Rounded to whole
    // minutes, matching the `/api/sleep/night` serialisation.
    sleepSourceDiscrepancy: night?.sourceDiscrepancy
      ? {
          deltaMinutes: Math.round(night.sourceDiscrepancy.deltaMinutes),
          sources: night.sourceDiscrepancy.sources.map((b) => ({
            source: b.source,
            deviceType: b.deviceType,
            asleepMinutes: Math.round(b.asleepMinutes),
          })),
        }
      : null,
    spark: nightSpark,
    updatedAt: night?.measuredAt.toISOString() ?? meta.lastSeenAt,
    allTimeCount: meta.allTimeCount,
    lastSeenAt: night?.measuredAt.toISOString() ?? meta.lastSeenAt,
  });
}

export function measurementCards(
  lookups: SummaryLookups,
  sleep: SummarySleepInput,
): MetricCard[] {
  const metrics: MetricCard[] = [];

  // Weight is always emitted.
  {
    const latest = lookups.latestOf("WEIGHT");
    const meta = lookups.metaForType("WEIGHT");
    metrics.push(
      plainCard("weight", "weight", {
        latestValue: latest?.value ?? null,
        spark: lookups.sparkOf("WEIGHT"),
        updatedAt: latest?.at?.toISOString() ?? meta.lastSeenAt,
        allTimeCount: meta.allTimeCount,
        lastSeenAt: meta.lastSeenAt,
      }),
    );
  }

  const bp = bloodPressureCard(lookups);
  if (bp) metrics.push(bp);

  // Pulse and body fat: emitted whenever there is a latest reading or any
  // history, so a tile doesn't disappear during a fortnight without a fresh
  // reading and an account that never logged one gets no placeholder.
  for (const [type, id, kind] of [
    ["PULSE", "pulse", "pulse"],
    ["BODY_FAT", "bodyFat", "bodyFat"],
  ] as const) {
    const latest = lookups.latestOf(type);
    const meta = lookups.metaForType(type);
    if (latest || meta.allTimeCount > 0) {
      metrics.push(
        plainCard(id, kind, {
          latestValue: latest?.value ?? null,
          spark: lookups.sparkOf(type),
          updatedAt: latest?.at?.toISOString() ?? meta.lastSeenAt,
          allTimeCount: meta.allTimeCount,
          lastSeenAt: meta.lastSeenAt,
        }),
      );
    }
  }

  // Optional cards: emitted whenever the user has *ever* logged the metric,
  // so a glucose tile that hasn't been touched in 10 days still renders with
  // the historical value visible (paired with the lastSeenAt caption).
  for (const [type, kind] of OPTIONAL_CARD_TYPES) {
    const latest = lookups.latestOf(type);
    const meta = lookups.metaForType(type);
    if (!latest && meta.allTimeCount === 0) continue;
    if (kind === "sleep") {
      metrics.push(sleepNightCard(sleep, meta));
      continue;
    }
    metrics.push(
      plainCard(kind, kind, {
        latestValue: latest?.value ?? null,
        spark: lookups.sparkOf(type),
        updatedAt: latest?.at.toISOString() ?? meta.lastSeenAt,
        allTimeCount: meta.allTimeCount,
        lastSeenAt: meta.lastSeenAt,
      }),
    );
  }
  return metrics;
}
