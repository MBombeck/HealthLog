/**
 * v1.28 — server-authoritative medication-efficacy builder.
 *
 * Composes ONE resolved DTO relating a medication to the outcome metric(s) /
 * lab(s) its class is prescribed to move, over the span around its start:
 *
 *   target resolution (override → ATC-prefix → name, `med-target-map`)
 *     → the target's DAY-mean series (rollup tier) or lab trajectory
 *     → a before / after-start comparison over the SAME series
 *     → an adherence lane from `dailyComplianceRatesFromLedger` (never recomputed)
 *     → an optional conservative level-shift note (`detectChangepoints`)
 *
 * Strictly descriptive. There is NO verdict / score / "working" field on the
 * DTO by construction — the view can only render numbers + neutral connective
 * phrasing. Honest empty states below the data floor (need N readings before
 * AND after the start). Mirrors the `adherence-storyline` safety posture:
 * association-only, never causal, never dose advice. iOS renders the DTO; it
 * never recomputes a delta or a mean (parity rule).
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";
import { readDayMeanSeries } from "@/lib/insights/derived/baseline";
import {
  buildComplianceMedicationContext,
  buildMedicationComplianceBundle,
  dailyComplianceRatesFromLedger,
  lastNonSkippedTakenAt,
} from "@/lib/analytics/compliance";
import {
  resolveRichMetric,
  getLabHistory,
  detectChangepoints,
} from "@/lib/mcp/rich-reads";
import {
  resolveMedicationTargets,
  type MedTarget,
  type MedTargetTier,
} from "@/lib/medications/med-target-map";
import { dueSchedules } from "@/lib/medications/intake-tracking";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Weeks of target data required on EACH side of the start for the delta. */
const MIN_WEEKS_PER_SIDE = 4;
/** Distinct readings required on each side before a before/after delta shows. */
const MIN_READINGS_PER_SIDE = 5;
/** The before-window the comparison reaches back over from the start. */
const BEFORE_WINDOW_DAYS = 56;
/** Series ceiling — the rollup tier caps timelines at one year. */
const MAX_WINDOW_DAYS = 365;
/** A detected level shift within this many days of the start reads "near". */
const CHANGEPOINT_NEAR_START_DAYS = 21;

export interface EfficacySeriesPoint {
  /** ISO date (YYYY-MM-DD for a metric day-bucket, full instant for a lab). */
  t: string;
  value: number;
  /** Lab-only per-point placement against the reference range. */
  status?: "in-range" | "below" | "above" | "unknown";
}

export interface EfficacyBeforeAfter {
  present: boolean;
  /** Why the delta is absent — mirrors the tools' honest `{present:false}`. */
  reason?:
    "insufficient_before" | "insufficient_after" | "no_start" | "no_data";
  before?: { mean: number; count: number; from: string; to: string };
  after?: { mean: number; count: number; from: string; to: string };
  /** after − before; `pct` relative to before, null when before is 0. */
  delta?: { mean: number; pct: number | null } | null;
}

export interface EfficacyLevelShift {
  present: boolean;
  /** Bucket-start ISO of the detected shift, when one fired. */
  at?: string;
  /** True when the shift sits within tolerance of the start (coincidence). */
  nearStart?: boolean;
}

export interface EfficacyTargetView {
  kind: "metric" | "lab";
  /** MeasurementType (metric) or the analyte needle (lab). */
  key: string;
  label: string;
  unit: string | null;
  primary: boolean;
  referenceBand: { low: number; high: number } | null;
  series: EfficacySeriesPoint[];
  beforeAfter: EfficacyBeforeAfter;
  /** Metric targets only; null for lab targets (changepoint reads metrics). */
  levelShift: EfficacyLevelShift | null;
}

export interface EfficacyMarkers {
  /** The pivot instant (ISO date) — `startsOn`, else the first-reading fallback. */
  start: string | null;
  startSource: "startsOn" | "firstReading" | null;
  doseChanges: { at: string; label: string }[];
  pauses: { from: string; to: string | null }[];
}

export interface EfficacyAdherencePoint {
  date: string;
  rate: number;
  taken: number;
  missed: number;
}

export interface MedicationEfficacyDTO {
  medicationId: string;
  medicationName: string;
  /** False → the "Wirkung" tab is hidden (oneShot / no target & no override). */
  eligible: boolean;
  /** Why the view is not eligible, when it is not. */
  reason?: "one_shot" | "no_target";
  startsOn: string | null;
  resolution: {
    tier: MedTargetTier | "override" | "none";
    cls: string | null;
  };
  windowDays: number;
  minWeeksPerSide: number;
  markers: EfficacyMarkers;
  targets: EfficacyTargetView[];
  adherence: EfficacyAdherencePoint[];
  /** The "not right? pick another" chooser source (user's own signals). */
  overrideOptions: {
    metrics: { key: string; label: string }[];
    biomarkers: { id: string; label: string; unit: string }[];
  };
}

/** Curated retarget metrics the fallback chooser offers (client localises). */
const OVERRIDE_METRIC_OPTIONS: { key: MeasurementType; label: string }[] = [
  { key: "BLOOD_PRESSURE_SYS", label: "Systolic blood pressure" },
  { key: "BLOOD_PRESSURE_DIA", label: "Diastolic blood pressure" },
  { key: "BLOOD_GLUCOSE", label: "Blood glucose" },
  { key: "WEIGHT", label: "Weight" },
  { key: "PULSE", label: "Pulse" },
  { key: "BODY_MASS_INDEX", label: "Body-mass index" },
];

/** Fixed reference bands for the metric targets `resolveRichMetric` omits. */
const METRIC_META_FALLBACK: Partial<
  Record<
    MeasurementType,
    { label: string; unit: string; band: { low: number; high: number } | null }
  >
> = {
  BLOOD_PRESSURE_SYS: {
    label: "Systolic blood pressure",
    unit: "mmHg",
    band: { low: 90, high: 120 },
  },
  BLOOD_PRESSURE_DIA: {
    label: "Diastolic blood pressure",
    unit: "mmHg",
    band: { low: 60, high: 80 },
  },
};

function resolveMetricMeta(mt: MeasurementType): {
  label: string;
  unit: string | null;
  band: { low: number; high: number } | null;
} {
  const rich = resolveRichMetric(mt);
  if (rich) return { label: rich.label, unit: rich.unit, band: rich.band };
  const fb = METRIC_META_FALLBACK[mt];
  if (fb) return fb;
  return { label: mt, unit: null, band: null };
}

const dayToInstant = (day: string): number =>
  new Date(`${day}T12:00:00Z`).getTime();

function meanOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Split a chronological value+instant series into before/after the pivot and
 * emit the honest before/after card. Below the per-side floor the card carries
 * `{present:false}` with the reason — never a fabricated delta.
 */
export function beforeAfterFromSeries(
  points: { at: number; value: number }[],
  pivotMs: number | null,
): EfficacyBeforeAfter {
  if (pivotMs === null) return { present: false, reason: "no_start" };
  const beforeFloor = pivotMs - BEFORE_WINDOW_DAYS * DAY_MS;
  const before = points.filter((p) => p.at >= beforeFloor && p.at < pivotMs);
  const after = points.filter((p) => p.at >= pivotMs);
  if (before.length < MIN_READINGS_PER_SIDE) {
    return { present: false, reason: "insufficient_before" };
  }
  if (after.length < MIN_READINGS_PER_SIDE) {
    return { present: false, reason: "insufficient_after" };
  }
  const beforeMean = meanOf(before.map((p) => p.value));
  const afterMean = meanOf(after.map((p) => p.value));
  const diff = afterMean - beforeMean;
  return {
    present: true,
    before: {
      mean: round1(beforeMean),
      count: before.length,
      from: new Date(before[0].at).toISOString(),
      to: new Date(before[before.length - 1].at).toISOString(),
    },
    after: {
      mean: round1(afterMean),
      count: after.length,
      from: new Date(after[0].at).toISOString(),
      to: new Date(after[after.length - 1].at).toISOString(),
    },
    delta: {
      mean: round1(diff),
      pct:
        beforeMean !== 0 ? round1((diff / Math.abs(beforeMean)) * 100) : null,
    },
  };
}

/** Build the metric-target view (day-mean series + before/after + changepoint). */
async function buildMetricTarget(
  userId: string,
  mt: MeasurementType,
  primary: boolean,
  pivotMs: number | null,
  windowDays: number,
  now: Date,
  coverage: Awaited<ReturnType<typeof probeRollupCoverage>>,
): Promise<EfficacyTargetView> {
  const meta = resolveMetricMeta(mt);
  const { points } = await readDayMeanSeries(
    userId,
    mt,
    windowDays,
    now,
    coverage,
  );
  const series: EfficacySeriesPoint[] = points.map((p) => ({
    t: p.day,
    value: round1(p.mean),
  }));
  const straddle = points.map((p) => ({
    at: dayToInstant(p.day),
    value: p.mean,
  }));

  // Level-shift note — metric targets only, and only when the metric resolves
  // through the rich-read resolver (blood pressure is multi-series and does
  // not, so it carries no changepoint note by construction).
  let levelShift: EfficacyLevelShift | null = null;
  if (resolveRichMetric(mt)) {
    const cp = await detectChangepoints(userId, {
      metric: mt,
      window: "lastYear",
    });
    if (
      cp.present &&
      cp.changepoints &&
      cp.changepoints.length > 0 &&
      pivotMs !== null
    ) {
      const nearest = cp.changepoints
        .map((c) => ({ at: c.at, dist: Math.abs(Date.parse(c.at) - pivotMs) }))
        .sort((a, b) => a.dist - b.dist)[0];
      levelShift = {
        present: true,
        at: nearest.at,
        nearStart: nearest.dist <= CHANGEPOINT_NEAR_START_DAYS * DAY_MS,
      };
    } else {
      levelShift = { present: false };
    }
  }

  return {
    kind: "metric",
    key: mt,
    label: meta.label,
    unit: meta.unit,
    primary,
    referenceBand: meta.band,
    series,
    beforeAfter: beforeAfterFromSeries(straddle, pivotMs),
    levelShift,
  };
}

/** Build the lab-target view (analyte trajectory + before/after over readings). */
async function buildLabTarget(
  userId: string,
  analyte: string,
  label: string,
  primary: boolean,
  pivotMs: number | null,
): Promise<EfficacyTargetView> {
  const hist = await getLabHistory(userId, { analyte, limit: 50 });
  const readings = (hist.present ? (hist.readings ?? []) : [])
    .filter((r) => r.value !== null)
    .slice()
    // getLabHistory returns newest-first; the view + before/after want oldest-first.
    .sort((a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt));

  const unit = readings[0]?.unit ?? null;
  const withBounds = readings.find(
    (r) => r.referenceLow !== null || r.referenceHigh !== null,
  );
  const referenceBand =
    withBounds &&
    withBounds.referenceLow !== null &&
    withBounds.referenceHigh !== null
      ? { low: withBounds.referenceLow, high: withBounds.referenceHigh }
      : null;

  const series: EfficacySeriesPoint[] = readings.map((r) => ({
    t: r.takenAt,
    value: r.value as number,
    status: r.rangeStatus,
  }));
  const straddle = readings.map((r) => ({
    at: Date.parse(r.takenAt),
    value: r.value as number,
  }));

  return {
    kind: "lab",
    key: analyte,
    label,
    unit,
    primary,
    referenceBand,
    series,
    beforeAfter: beforeAfterFromSeries(straddle, pivotMs),
    levelShift: null,
  };
}

/**
 * Resolve the effective targets for a medication: the user's persisted
 * override wins (tier "override"); otherwise the derived ATC/name resolution.
 * Returns the tier + class provenance for the DTO alongside the target list.
 */
async function resolveEffectiveTargets(med: {
  id: string;
  name: string;
  treatmentClass: string;
  atcCode: string | null;
}): Promise<{
  tier: MedTargetTier | "override" | "none";
  cls: string | null;
  targets: MedTarget[];
}> {
  const overrides = await prisma.medicationEfficacyTarget.findMany({
    where: { medicationId: med.id },
    orderBy: [{ primary: "desc" }, { createdAt: "asc" }],
    select: {
      measurementType: true,
      primary: true,
      biomarker: { select: { name: true } },
    },
  });
  const overrideTargets: MedTarget[] = [];
  for (const row of overrides) {
    if (row.measurementType) {
      overrideTargets.push({
        kind: "metric",
        measurementType: row.measurementType,
      });
    } else if (row.biomarker) {
      overrideTargets.push({
        kind: "lab",
        analyte: row.biomarker.name,
        label: row.biomarker.name,
      });
    }
  }
  if (overrideTargets.length > 0) {
    return { tier: "override", cls: null, targets: overrideTargets };
  }

  const derived = resolveMedicationTargets({
    name: med.name,
    treatmentClass: med.treatmentClass,
    atcCode: med.atcCode,
  });
  if (derived) {
    return {
      tier: derived.tier,
      cls: derived.cls,
      targets: [...derived.targets],
    };
  }
  return { tier: "none", cls: null, targets: [] };
}

/**
 * Build the full efficacy DTO for one medication the caller owns. The caller
 * (route / server component) is responsible for the ownership gate; this
 * builder reads only rows scoped to `userId` / the owned medication.
 */
export async function buildMedicationEfficacy(
  userId: string,
  medicationId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<MedicationEfficacyDTO | null> {
  const med = await prisma.medication.findFirst({
    where: { id: medicationId, userId },
    include: {
      schedules: true,
      scheduleRevisions: { orderBy: { validFrom: "asc" } },
      pauseEras: { select: { pausedAt: true, resumedAt: true } },
      doseChanges: { orderBy: { effectiveFrom: "asc" } },
    },
  });
  if (!med) return null;

  const startsOnIso = med.startsOn ? med.startsOn.toISOString() : null;
  const baseDto = {
    medicationId: med.id,
    medicationName: med.name,
    startsOn: startsOnIso,
    minWeeksPerSide: MIN_WEEKS_PER_SIDE,
  };

  // One-shot meds have a single administration and no trend to relate.
  if (med.oneShot) {
    annotate({
      action: {
        name: "medication.efficacy.build",
        entity_type: "medication",
        entity_id: med.id,
      },
      meta: { eligible: false, reason: "one_shot" },
    });
    return {
      ...baseDto,
      eligible: false,
      reason: "one_shot",
      resolution: { tier: "none", cls: null },
      windowDays: 0,
      markers: { start: null, startSource: null, doseChanges: [], pauses: [] },
      targets: [],
      adherence: [],
      overrideOptions: { metrics: [], biomarkers: [] },
    };
  }

  const resolved = await resolveEffectiveTargets({
    id: med.id,
    name: med.name,
    treatmentClass: med.treatmentClass,
    atcCode: med.atcCode ?? null,
  });

  // The user's own retarget options (fallback chooser) — always attached.
  const biomarkerRows = await prisma.biomarker.findMany({
    where: { userId, hidden: false },
    orderBy: { name: "asc" },
    select: { id: true, name: true, unit: true },
  });
  const overrideOptions = {
    metrics: OVERRIDE_METRIC_OPTIONS.map((m) => ({
      key: m.key,
      label: m.label,
    })),
    biomarkers: biomarkerRows.map((b) => ({
      id: b.id,
      label: b.name,
      unit: b.unit,
    })),
  };

  if (resolved.targets.length === 0) {
    annotate({
      action: {
        name: "medication.efficacy.build",
        entity_type: "medication",
        entity_id: med.id,
      },
      meta: { eligible: false, reason: "no_target" },
    });
    return {
      ...baseDto,
      eligible: false,
      reason: "no_target",
      resolution: { tier: "none", cls: null },
      windowDays: 0,
      markers: { start: null, startSource: null, doseChanges: [], pauses: [] },
      targets: [],
      adherence: [],
      overrideOptions,
    };
  }

  // Pivot: `startsOn` when present; else the first reading of the primary
  // target (captioned as a fallback); else null (the before/after card then
  // renders the honest "set a start date" empty state).
  const coverage = await probeRollupCoverage(userId);
  let pivotMs = med.startsOn ? med.startsOn.getTime() : null;
  let startSource: "startsOn" | "firstReading" | null = med.startsOn
    ? "startsOn"
    : null;

  // Establish a window that spans well before the pivot through today.
  const spanFromPivot = pivotMs !== null ? now.getTime() - pivotMs : 0;
  const windowDays = Math.min(
    MAX_WINDOW_DAYS,
    Math.max(
      90,
      Math.ceil((spanFromPivot + BEFORE_WINDOW_DAYS * DAY_MS) / DAY_MS),
    ),
  );

  // Build each target view. Fallback pivot uses the primary metric's first day.
  const targets: EfficacyTargetView[] = [];
  for (let i = 0; i < resolved.targets.length; i++) {
    const target = resolved.targets[i];
    const primary = i === 0;
    if (target.kind === "metric") {
      const view = await buildMetricTarget(
        userId,
        target.measurementType,
        primary,
        pivotMs,
        windowDays,
        now,
        coverage,
      );
      // Legacy no-start med: fall back to the primary metric's first reading.
      if (primary && pivotMs === null && view.series.length > 0) {
        pivotMs = dayToInstant(view.series[0].t);
        startSource = "firstReading";
        view.beforeAfter = beforeAfterFromSeries(
          view.series.map((p) => ({ at: dayToInstant(p.t), value: p.value })),
          pivotMs,
        );
      }
      targets.push(view);
    } else {
      const view = await buildLabTarget(
        userId,
        target.analyte,
        target.label,
        primary,
        pivotMs,
      );
      if (primary && pivotMs === null && view.series.length > 0) {
        pivotMs = Date.parse(view.series[0].t);
        startSource = "firstReading";
        view.beforeAfter = beforeAfterFromSeries(
          view.series.map((p) => ({ at: Date.parse(p.t), value: p.value })),
          pivotMs,
        );
      }
      targets.push(view);
    }
  }

  // Adherence lane — the cadence-aware per-day rate from the SAME ledger the
  // compliance surfaces read; never recomputed here.
  const fetchFrom = new Date(
    Math.max(med.createdAt.getTime(), now.getTime() - windowDays * DAY_MS),
  );
  const events = await prisma.medicationIntakeEvent.findMany({
    where: {
      medicationId: med.id,
      userId,
      deletedAt: null,
      scheduledFor: { gte: fetchFrom },
    },
    orderBy: { scheduledFor: "desc" },
    select: {
      takenAt: true,
      skipped: true,
      scheduledFor: true,
      autoMissed: true,
      attributionSource: true,
    },
  });
  const ctx = buildComplianceMedicationContext(
    med,
    lastNonSkippedTakenAt(events),
    timezone,
  );
  // v1.39.1 (#1033) — with intake tracking off the live era expects
  // nothing, so the adherence band shows no fabricated misses.
  const bundle = buildMedicationComplianceBundle(
    events,
    dueSchedules(med),
    ctx,
    now,
  );
  const windowFloorMs =
    pivotMs !== null
      ? pivotMs - BEFORE_WINDOW_DAYS * DAY_MS
      : fetchFrom.getTime();
  const adherence: EfficacyAdherencePoint[] = dailyComplianceRatesFromLedger(
    bundle.ledgerRows,
    timezone,
  )
    .filter((d) => d.date.getTime() >= windowFloorMs)
    .map((d) => ({
      date: d.date.toISOString(),
      rate: d.rate,
      taken: d.taken,
      missed: d.missed,
    }));

  // Markers — dose changes + pause bands intersecting the window.
  const doseChanges = med.doseChanges
    .filter((dc) => dc.effectiveFrom.getTime() >= windowFloorMs)
    .map((dc) => ({
      at: dc.effectiveFrom.toISOString(),
      label: `${dc.doseValue} ${dc.doseUnit}`.trim(),
    }));
  const pauses = med.pauseEras
    .filter((p) => (p.resumedAt?.getTime() ?? now.getTime()) >= windowFloorMs)
    .map((p) => ({
      from: p.pausedAt.toISOString(),
      to: p.resumedAt ? p.resumedAt.toISOString() : null,
    }));

  annotate({
    action: {
      name: "medication.efficacy.build",
      entity_type: "medication",
      entity_id: med.id,
    },
    meta: {
      eligible: true,
      tier: resolved.tier,
      cls: resolved.cls,
      targetCount: targets.length,
      startSource: startSource ?? "none",
      windowDays,
    },
  });

  return {
    ...baseDto,
    eligible: true,
    resolution: { tier: resolved.tier, cls: resolved.cls },
    windowDays,
    markers: {
      start: pivotMs !== null ? new Date(pivotMs).toISOString() : null,
      startSource,
      doseChanges,
      pauses,
    },
    targets,
    adherence,
    overrideOptions,
  };
}
