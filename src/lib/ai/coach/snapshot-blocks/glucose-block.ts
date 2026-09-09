/**
 * Glucose block for the Coach snapshot (v1.7.0, per-context daily means).
 *
 * Glucose is summarised per `GlucoseContext` so the Coach can tell
 * fasting from postprandial without seeing raw samples. Each context
 * gets its own per-day mean timeline; the block omits when no rows.
 * The clinical panel summary (TIR / GMI / CV%) is computed over the
 * fixed trailing-30-day rows the insights panel + doctor report use,
 * never the coach's variable narration window.
 *
 * Split out of `snapshot.ts`; the builder passes the rows it already
 * read plus the shared accumulators, so the emitted shape and ordering
 * are unchanged.
 */
import {
  convertGlucose,
  glucoseContextBucket,
  type GlucoseUnit,
} from "@/lib/glucose";
import {
  computeGlucoseClinicalMetrics,
  GLUCOSE_PANEL_WINDOW_DAYS,
} from "@/lib/analytics/glucose-metrics";
import { annotate } from "@/lib/logging/context";
import type { ReferenceMetric } from "@/lib/reference-ranges";
import { bucketWeekly, buildDailyValueRows } from "../snapshot-series";
import type {
  CoachProvenance,
  CoachProvenanceMetric,
  CoachScopeSource,
} from "../types";

/**
 * v1.17.0 — the glucose clinical panel is a fixed trailing-30-day artifact,
 * identical across the insights panel, the dashboard snapshot, the doctor
 * report, and (here) the coach. Pinned independently of the coach's variable
 * narration window so the coach's TIR/GMI/CV% always equals what the panel
 * renders.
 */
export const GLUCOSE_CLINICAL_WINDOW_DAYS = GLUCOSE_PANEL_WINDOW_DAYS;

interface GlucoseBlockContext {
  measurementRows: ReadonlyArray<{
    type: string;
    value: number;
    measuredAt: Date;
    glucoseContext: unknown;
  }>;
  /** Effective window cutoff for the glucose source (multi-cluster aware). */
  glucoseCutoff: Date;
  glucoseClinicalRows: Array<{ value: number; measuredAt: Date }> | null;
  glucoseUnit: GlucoseUnit;
  recentCutoff: Date;
  userTz: string;
  now: Date;
  snapshot: Record<string, unknown>;
  metrics: Set<CoachProvenanceMetric>;
  counts: NonNullable<CoachProvenance["counts"]>;
  registerBlock: (key: string, source: CoachScopeSource) => void;
  groundingValues: Map<ReferenceMetric, number>;
}

export function buildGlucoseBlock(ctx: Readonly<GlucoseBlockContext>): void {
  const {
    measurementRows,
    glucoseCutoff,
    glucoseClinicalRows,
    glucoseUnit,
    recentCutoff,
    userTz,
    now,
    snapshot,
    metrics,
    counts,
    registerBlock,
    groundingValues,
  } = ctx;
  const glucoseRows = measurementRows.filter(
    (r) => r.type === "BLOOD_GLUCOSE" && r.measuredAt >= glucoseCutoff,
  );
  if (glucoseRows.length === 0) {
    annotate({
      action: { name: "coach.cluster.empty_skipped" },
      meta: { cluster: "glucose", source: "glucose" },
    });
  } else {
    // Group by context (NULL → "unspecified"), then per-day mean. The bucket
    // resolver is the shared one (#943) — this block named the untagged
    // bucket first, and the rest of the tree now resolves through the same
    // helper rather than repeating the NULL arm at each surface.
    const byContext = new Map<
      string,
      Array<{ measuredAt: Date; value: number }>
    >();
    for (const r of glucoseRows) {
      const ctxKey = glucoseContextBucket(
        typeof r.glucoseContext === "string" ? r.glucoseContext : null,
      ).toLowerCase();
      const list = byContext.get(ctxKey) ?? [];
      list.push({ measuredAt: r.measuredAt, value: r.value });
      byContext.set(ctxKey, list);
    }
    const contexts: Record<string, unknown> = {};
    for (const [ctxKey, rows] of byContext) {
      // v1.16.16 — glucose is stored canonical mg/dL. A mmol/L-preference
      // user's Coach must read the same number every other surface shows
      // (5.5, not 100). Aggregate the per-day / weekly means in raw mg/dL,
      // then convert each resulting figure ONCE (parity with the series
      // DTO + detail page + FHIR). mg/dL users stay byte-identical because
      // the conversion is skipped entirely.
      const recent = buildDailyValueRows(rows, recentCutoff, userTz).map((d) =>
        glucoseUnit === "mmol/L"
          ? { ...d, value: convertGlucose(d.value, glucoseUnit) }
          : d,
      );
      const weekly = bucketWeekly(
        rows.filter((r) => r.measuredAt < recentCutoff),
        userTz,
      ).map((w) =>
        glucoseUnit === "mmol/L"
          ? { ...w, mean: convertGlucose(w.mean, glucoseUnit) }
          : w,
      );
      contexts[ctxKey] = { recent, weekly };
    }
    // v1.17.0 — clinical panel summary from the ONE literature-locked engine
    // the insights panel + doctor report also consume, computed over the SAME
    // fixed trailing-30-day window + rows the panel uses (`glucoseClinicalRows`,
    // not the coach-window / cap-trimmed `glucoseRows`), so the coach can never
    // quote a TIR / GMI / CV% figure the panel doesn't show — true numeric
    // parity, independent of the user's coach scope. Gated by `stillLearning`
    // so a thin spot-data window is offered as a calm "still learning" note
    // rather than asserted as a clinical AGP. The headline mean is converted
    // ONCE to the user's display unit; the unit-agnostic fractions / indices
    // travel as-is.
    const clinicalRaw = computeGlucoseClinicalMetrics(
      (glucoseClinicalRows ?? []).map((r) => ({
        measuredAt: r.measuredAt,
        mgdl: r.value,
      })),
      { windowDays: GLUCOSE_CLINICAL_WINDOW_DAYS, now },
    );
    const clinical = clinicalRaw.stillLearning
      ? {
          stillLearning: true as const,
          reason: clinicalRaw.stillLearningReason,
          readingCount: clinicalRaw.readingCount,
          spanDays: Math.round(clinicalRaw.actualSpanDays),
        }
      : {
          stillLearning: false as const,
          windowDays: clinicalRaw.windowDays,
          spanDays: Math.round(clinicalRaw.actualSpanDays),
          readingCount: clinicalRaw.readingCount,
          meanInRange:
            clinicalRaw.meanMgdl !== null
              ? Math.round(
                  convertGlucose(clinicalRaw.meanMgdl, glucoseUnit) *
                    (glucoseUnit === "mmol/L" ? 10 : 1),
                ) / (glucoseUnit === "mmol/L" ? 10 : 1)
              : null,
          tirPercent: clinicalRaw.distribution
            ? Math.round(clinicalRaw.distribution.tir * 100)
            : null,
          timeBelowPercent: clinicalRaw.distribution
            ? Math.round(clinicalRaw.distribution.tbrLevel1 * 100)
            : null,
          timeAbovePercent: clinicalRaw.distribution
            ? Math.round(clinicalRaw.distribution.tarLevel1 * 100)
            : null,
          gmi:
            clinicalRaw.gmi !== null
              ? Math.round(clinicalRaw.gmi * 10) / 10
              : null,
          estimatedA1c:
            clinicalRaw.estimatedA1c !== null
              ? Math.round(clinicalRaw.estimatedA1c * 10) / 10
              : null,
          cvPercent: clinicalRaw.variability
            ? Math.round(clinicalRaw.variability.cv)
            : null,
          unstable: clinicalRaw.variability?.unstable ?? null,
          // Density-derived: a sparse spot series stays a spot-reading
          // estimate, a continuous CGM stream (Nightscout) reads false so the
          // model can narrate the TIR/GMI as continuous-trace figures.
          isSpotEstimate: clinicalRaw.isSpotEstimate,
        };
    // The display unit travels with the block so the prompt renders
    // "<value> <unit>" and the EVIDENCE BLOCK tags glucose lines correctly.
    snapshot.glucose = { unit: glucoseUnit, byContext: contexts, clinical };
    metrics.add("glucose");
    counts.glucose = glucoseRows.length;
    registerBlock("glucose", "glucose");
    // W7 grounding: fasting glucose mean in RAW mg/dL (the reference band's
    // unit), independent of the user's mmol/L display preference. The
    // grounding line's band selection respects the W6 `hasDiabetes` opt-in;
    // here we only feed the representative fasting value. Fall back to the
    // overall mean when no row is tagged FASTING so the band is still cited.
    const fastingRows = glucoseRows.filter(
      (r) => String(r.glucoseContext).toUpperCase() === "FASTING",
    );
    const glucoseScalarRows =
      fastingRows.length > 0 ? fastingRows : glucoseRows;
    const glucoseMeanMgdl =
      glucoseScalarRows.reduce((s, r) => s + r.value, 0) /
      glucoseScalarRows.length;
    if (Number.isFinite(glucoseMeanMgdl)) {
      groundingValues.set("BLOOD_GLUCOSE", glucoseMeanMgdl);
    }
  }
}
