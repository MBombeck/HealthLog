import type { AggregatedFeatures } from "@/lib/insights/features";
import type { ReferenceMetric } from "@/lib/reference-ranges";
import {
  bpBandFromRows,
  bucketWeekly,
  buildDailyBpRows,
  buildDailyValueRows,
  type CoarseTimelineTail,
} from "../snapshot-series";
import type {
  CoachProvenance,
  CoachProvenanceMetric,
  CoachScopeSource,
} from "../types";

interface CoreMetricsBlockContext {
  sources: ReadonlySet<CoachScopeSource>;
  features: Pick<
    AggregatedFeatures,
    "bloodPressure" | "weight" | "pulse" | "mood"
  >;
  measurementRows: ReadonlyArray<{
    type: string;
    value: number;
    measuredAt: Date;
  }>;
  moodRows: ReadonlyArray<{ moodLoggedAt: Date; score: number }> | null;
  recentCutoff: Date;
  userTz: string;
  coarseTails: Readonly<{
    bp?: CoarseTimelineTail;
    weight?: CoarseTimelineTail;
    pulse?: CoarseTimelineTail;
  }>;
  snapshot: Record<string, unknown>;
  windows: Set<CoachProvenance["windows"][number]>;
  metrics: Set<CoachProvenanceMetric>;
  counts: NonNullable<CoachProvenance["counts"]>;
  registerBlock: (key: string, source: CoachScopeSource) => void;
  groundingValues: Map<ReferenceMetric, number>;
}

export function buildCoreMetricsBlocks(
  ctx: Readonly<CoreMetricsBlockContext>,
): void {
  const byType = (type: string) =>
    ctx.measurementRows
      .filter((row) => row.type === type)
      .map((row) => ({ measuredAt: row.measuredAt, value: row.value }));

  if (ctx.sources.has("bp") && ctx.features.bloodPressure) {
    const sysRows = byType("BLOOD_PRESSURE_SYS");
    const diaRows = byType("BLOOD_PRESSURE_DIA");
    const recentDaily = buildDailyBpRows(
      sysRows,
      diaRows,
      ctx.recentCutoff,
      ctx.userTz,
    );
    const olderSys = sysRows.filter((row) => row.measuredAt < ctx.recentCutoff);
    const olderDia = diaRows.filter((row) => row.measuredAt < ctx.recentCutoff);
    const sysBand = bpBandFromRows(sysRows);
    const diaBand = bpBandFromRows(diaRows);
    const usualRange =
      sysBand || diaBand
        ? {
            ...(sysBand ? { sys: sysBand } : {}),
            ...(diaBand ? { dia: diaBand } : {}),
          }
        : undefined;

    ctx.snapshot.bloodPressure = {
      aggregate: ctx.features.bloodPressure,
      timeline: {
        recent: recentDaily,
        weeklySys: bucketWeekly(olderSys, ctx.userTz),
        weeklyDia: bucketWeekly(olderDia, ctx.userTz),
        ...(ctx.coarseTails.bp ? { coarse: ctx.coarseTails.bp } : {}),
      },
      ...(usualRange ? { usualRange } : {}),
    };
    ctx.metrics.add("bp");
    ctx.windows.add("last30days");
    ctx.windows.add("last90days");
    ctx.counts.bp = ctx.features.bloodPressure.coverage?.count ?? undefined;
    ctx.registerBlock("bloodPressure", "bp");

    const sys30 =
      ctx.features.bloodPressure.avgSys30 ??
      ctx.features.bloodPressure.allTimeAvgSys;
    if (sys30 != null) ctx.groundingValues.set("BLOOD_PRESSURE", sys30);
  }

  if (ctx.sources.has("weight") && ctx.features.weight) {
    const rows = byType("WEIGHT");
    ctx.snapshot.weight = {
      aggregate: ctx.features.weight,
      timeline: {
        recent: buildDailyValueRows(rows, ctx.recentCutoff, ctx.userTz),
        weekly: bucketWeekly(
          rows.filter((row) => row.measuredAt < ctx.recentCutoff),
          ctx.userTz,
        ),
        ...(ctx.coarseTails.weight ? { coarse: ctx.coarseTails.weight } : {}),
      },
    };
    ctx.metrics.add("weight");
    ctx.windows.add("last7days");
    ctx.windows.add("last30days");
    ctx.counts.weight = ctx.features.weight.coverage?.count ?? undefined;
    ctx.registerBlock("weight", "weight");

    if (ctx.features.weight.bmi != null) {
      ctx.groundingValues.set("BMI", ctx.features.weight.bmi);
    }
  }

  if (ctx.sources.has("pulse") && ctx.features.pulse) {
    const rows = byType("PULSE");
    ctx.snapshot.pulse = {
      aggregate: ctx.features.pulse,
      timeline: {
        recent: buildDailyValueRows(rows, ctx.recentCutoff, ctx.userTz),
        weekly: bucketWeekly(
          rows.filter((row) => row.measuredAt < ctx.recentCutoff),
          ctx.userTz,
        ),
        ...(ctx.coarseTails.pulse ? { coarse: ctx.coarseTails.pulse } : {}),
      },
    };
    ctx.metrics.add("pulse");
    ctx.windows.add("last7days");
    ctx.windows.add("last30days");
    ctx.windows.add("last90days");
    ctx.counts.pulse = ctx.features.pulse.coverage?.count ?? undefined;
    ctx.registerBlock("pulse", "pulse");
  }

  if (ctx.sources.has("mood") && ctx.features.mood && ctx.moodRows) {
    const normalised = ctx.moodRows.map((row) => ({
      measuredAt: row.moodLoggedAt,
      value: row.score,
    }));
    ctx.snapshot.mood = {
      aggregate: ctx.features.mood,
      timeline: {
        recent: buildDailyValueRows(normalised, ctx.recentCutoff, ctx.userTz),
        weekly: bucketWeekly(
          normalised.filter((row) => row.measuredAt < ctx.recentCutoff),
          ctx.userTz,
        ),
      },
    };
    ctx.metrics.add("mood");
    ctx.windows.add("last7days");
    ctx.windows.add("last30days");
    ctx.counts.mood = ctx.features.mood.coverage?.count ?? undefined;
    ctx.registerBlock("mood", "mood");
  }
}
