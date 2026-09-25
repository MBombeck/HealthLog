/**
 * v1.22 (W9, B5) — adherence → target-vital storyline.
 *
 * When a user's medication adherence dips AND the vital that medication targets
 * drifts over the same span, the Coach surfaces the connection in ONE
 * association-framed line — the link a pillbox app structurally cannot make
 * because it owns only the adherence side. The data channels already exist
 * (compliance rollups + the FDR correlation matrix since v1.21.0); what was
 * missing is the med-class→target map (`med-target-map.ts`) and this narrated
 * storyline surface.
 *
 * Two halves:
 *  - `shapeAdherenceStoryline` — the PURE decision: given a recent adherence
 *    summary, a before/after read of the target vital, and the vital's robust
 *    spread, decide whether there is a storyline worth surfacing and with what
 *    framing. Conservative-fail everywhere (thin data → null; no dip → null; no
 *    material vital move → null). Never causal — the output is "lines up with".
 *  - `buildAdherenceStoryline` — the reader: active meds → known class+target →
 *    overall adherence series + the target-vital DAY means → the shaper.
 *
 * Safety: this is the one B-item that makes a medication-adjacent claim. The
 * output never advises a dose change and never asserts causation; that framing
 * is enforced in the prompt clause + the B0 golden/red-team cases.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";
import { readDayMeanSeries } from "@/lib/insights/derived/baseline";
import { buildScheduleAnchoredComplianceBuckets } from "@/lib/analytics/schedule-anchored-compliance";
import { DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import { sanitizeForPrompt } from "@/lib/insights/sanitize";
import {
  inferMedTargetClass,
  MED_TARGET_MAP,
  type MedTargetClass,
} from "@/lib/medications/med-target-map";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAD_TO_SIGMA = 1.4826;

/** Max chars of the free-text medication label that may enter the prompt. */
const MED_LABEL_MAX_CHARS = 60;

/** Recent window over which adherence + the vital drift are read. */
const ADHERENCE_WINDOW_DAYS = 14;
/** Window for the target-vital before/after read (split in half). */
const VITAL_WINDOW_DAYS = 28;

/** Adherence must clear this many days of scheduled doses to be trusted. */
const MIN_ADHERENCE_DAYS = 7;
/** Each side of the vital before/after read needs this many days. */
const MIN_VITAL_DAYS_PER_SIDE = 5;
/** Recent adherence at/below this counts as a material dip (0–100). */
const ADHERENCE_DIP_PCT = 80;
/** A vital move counts as material at ≥ this fraction of its robust spread. */
const VITAL_MATERIAL_SPREAD_FRACTION = 0.5;

/** The storyline the snapshot carries, or `null` when there is none. */
export interface AdherenceStoryline {
  medLabel: string;
  medClass: MedTargetClass;
  targetMetric: MeasurementType;
  /** Recent-window adherence, whole percent. */
  adherencePct: number;
  adherenceDays: number;
  /** Signed recent − prior mean of the target vital, 1dp. */
  vitalDelta: number;
  vitalDirection: "up" | "down";
  vitalPriorMean: number;
  vitalRecentMean: number;
  /** Always "watch" — the storyline is tentative, association-only. */
  confidenceTier: "watch";
}

export interface ShapeStorylineInput {
  medLabel: string;
  medClass: MedTargetClass;
  targetMetric: MeasurementType;
  adherencePct: number;
  adherenceDays: number;
  vitalPriorMean: number;
  vitalRecentMean: number;
  vitalDaysPrior: number;
  vitalDaysRecent: number;
  /** Robust spread (MAD·1.4826) of the vital over the window. */
  vitalSpread: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Decide whether the adherence dip + vital drift line up enough to surface a
 * storyline. Returns `null` unless ALL hold: enough adherence days, a material
 * adherence dip, enough vital days on both sides, and a material vital move.
 */
export function shapeAdherenceStoryline(
  input: ShapeStorylineInput,
): AdherenceStoryline | null {
  if (input.adherenceDays < MIN_ADHERENCE_DAYS) return null;
  if (input.adherencePct > ADHERENCE_DIP_PCT) return null;
  if (
    input.vitalDaysPrior < MIN_VITAL_DAYS_PER_SIDE ||
    input.vitalDaysRecent < MIN_VITAL_DAYS_PER_SIDE
  ) {
    return null;
  }

  const delta = input.vitalRecentMean - input.vitalPriorMean;
  const materialFloor = Math.max(
    input.vitalSpread * VITAL_MATERIAL_SPREAD_FRACTION,
    0,
  );
  if (materialFloor <= 0) return null;
  if (Math.abs(delta) < materialFloor) return null;

  return {
    medLabel: input.medLabel,
    medClass: input.medClass,
    targetMetric: input.targetMetric,
    adherencePct: Math.round(input.adherencePct),
    adherenceDays: input.adherenceDays,
    vitalDelta: round1(delta),
    vitalDirection: delta >= 0 ? "up" : "down",
    vitalPriorMean: round1(input.vitalPriorMean),
    vitalRecentMean: round1(input.vitalRecentMean),
    confidenceTier: "watch",
  };
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function robustSpread(xs: readonly number[]): number {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m))) * MAD_TO_SIGMA;
}

/**
 * Build the adherence→vital storyline for a user, or `null`. Reads the active
 * medications, infers each one's target-class (conservative-fail), computes the
 * overall recent adherence, and for the first medication with a known class +
 * target with enough vital data, runs the shaper. One storyline per snapshot.
 */
export async function buildAdherenceStoryline(
  userId: string,
  timezone: string | null,
  now: Date = new Date(),
): Promise<AdherenceStoryline | null> {
  // 1. Active medications with a confidently-known target class.
  const meds = await prisma.medication.findMany({
    where: {
      userId,
      active: true,
      // v1.39.1 (#1033) — the adherence figure below counts tracked
      // medications only, so a record-only one cannot be its subject.
      ...TRACKED_INTAKE_WHERE,
      OR: [{ endsOn: null }, { endsOn: { gte: now } }],
    },
    select: { name: true, treatmentClass: true },
  });
  const candidates = meds
    .map((m) => ({
      // v1.30.25 — `Medication.name` is free text (typed by the user, or
      // transcribed by a model from an uploaded document via the inbound
      // medication-statement path) and this label reaches the Coach prompt
      // through `snapshot.adherenceStoryline`. It is the same column the
      // GLP-1 block already sanitises for exactly this reason. Classification
      // still reads the RAW name so sanitisation cannot change which
      // treatment class a medication is matched to.
      label: sanitizeForPrompt(m.name, MED_LABEL_MAX_CHARS),
      cls: inferMedTargetClass(m.name, m.treatmentClass),
    }))
    .filter((c): c is { label: string; cls: MedTargetClass } => c.cls !== null);
  if (candidates.length === 0) return null;

  // 2. Overall recent adherence — schedule-anchored + cadence-aware, the SAME
  //    engine the dashboard tile reads (`buildScheduleAnchoredComplianceBuckets`).
  //    v1.26.0 SEAM-N3 — this replaced `readMedicationCompliance`, whose
  //    `scheduled` was a RAW coverage count of LOGGED intake slots: a user who
  //    logs only the doses they took (never minting `takenAt:null` reminder
  //    rows for missed ones) read ~100% adherence, and the dip gate below
  //    (adherencePct > 80 → null) wrongly suppressed the storyline. The
  //    schedule-anchored `scheduled` is the recurrence engine's EXPECTED-dose
  //    count, so genuinely missed doses pull the rate down. One engine, one
  //    number — the storyline's % now equals the dashboard tile's %.
  const buckets = await buildScheduleAnchoredComplianceBuckets(
    userId,
    ADHERENCE_WINDOW_DAYS,
    timezone ?? DEFAULT_TIMEZONE,
    now,
  );
  let scheduled = 0;
  let taken = 0;
  let adherenceDays = 0;
  for (const b of buckets) {
    if (b.scheduled > 0) {
      scheduled += b.scheduled;
      taken += b.taken;
      adherenceDays += 1;
    }
  }
  if (scheduled === 0) return null;
  const adherencePct = (100 * taken) / scheduled;

  // 3. The target vital before/after read, first candidate that clears.
  const coverage = await probeRollupCoverage(userId);
  for (const cand of candidates) {
    for (const targetMetric of MED_TARGET_MAP[cand.cls]) {
      const { points } = await readDayMeanSeries(
        userId,
        targetMetric,
        VITAL_WINDOW_DAYS,
        now,
        coverage,
      );
      if (points.length < MIN_VITAL_DAYS_PER_SIDE * 2) continue;
      const splitAt = now.getTime() - (VITAL_WINDOW_DAYS / 2) * MS_PER_DAY;
      const prior = points.filter(
        (p) => new Date(`${p.day}T12:00:00Z`).getTime() < splitAt,
      );
      const recent = points.filter(
        (p) => new Date(`${p.day}T12:00:00Z`).getTime() >= splitAt,
      );
      const storyline = shapeAdherenceStoryline({
        medLabel: cand.label,
        medClass: cand.cls,
        targetMetric,
        adherencePct,
        adherenceDays,
        vitalPriorMean: mean(prior.map((p) => p.mean)),
        vitalRecentMean: mean(recent.map((p) => p.mean)),
        vitalDaysPrior: prior.length,
        vitalDaysRecent: recent.length,
        vitalSpread: robustSpread(points.map((p) => p.mean)),
      });
      if (storyline) return storyline;
    }
  }
  return null;
}
