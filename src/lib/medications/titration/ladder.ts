/**
 * v1.4.25 W19f — pure titration-ladder helpers for the GLP-1 detail page.
 *
 * The W19a knowledge layer (`glp1-knowledge.ts`) already carries the
 * EMA-approved escalation schedules under `titrationStepsMg` +
 * `titrationIntervalWeeks`. This module turns that static reference
 * into a small contract the API route and the detail-page section
 * can both read:
 *
 *   - `getLadder(drugId)`        — normalises the catalog row into an
 *                                  ordered `TitrationStep[]` with
 *                                  `stepIndex` and `typicalWeeks`.
 *   - `findCurrentStep(...)`     — matches the user's latest dose to
 *                                  the closest ladder step within a
 *                                  ±10 % tolerance window; returns
 *                                  null when the dose is outside any
 *                                  ladder bucket (e.g. user is on a
 *                                  non-standard dose).
 *   - `nextStep(...)`            — immediate-next step, null at the
 *                                  ladder ceiling.
 *   - `weeksOnCurrentStep(...)`  — how long the user has actually been
 *                                  on the matched step, derived from
 *                                  the `MedicationDoseChange` stream.
 *   - `escalationDue(...)`       — true when (a) there's a next step
 *                                  and (b) the user has been on the
 *                                  current step at least
 *                                  `titrationIntervalWeeks`. Display
 *                                  copy is strictly observational
 *                                  ("ladder typically steps up around
 *                                  N weeks") — never prescriptive
 *                                  (parallel to the W19c-Safety
 *                                  GROUND RULE: MDR boundary).
 *
 * No DB access; every function takes pre-fetched rows. Same shape as
 * the W19d / W19e pure modules so the route owns prisma and this
 * module owns the math.
 */

import {
  GLP1_DRUGS,
  type Glp1DrugId,
  type Glp1DrugRecord,
} from "@/lib/medications/glp1-knowledge";

/**
 * Normalised ladder step — easier to consume in the UI than the bare
 * `number[]` on the catalog record because each step carries its own
 * position and the typical-weeks figure attached to the drug.
 */
export interface TitrationStep {
  /** 0-based position in the ladder. */
  stepIndex: number;
  /** Step dose in mg (always > 0, strictly ascending across the ladder). */
  doseMg: number;
  /** EMA-reference minimum weeks before stepping up from this dose. */
  typicalWeeks: number;
}

/** Dose-change row this module needs — a tiny subset of the model. */
export interface DoseChangeLike {
  /** When the user transitioned onto a new dose. */
  effectiveFrom: Date;
  /** Numeric dose, paired with `doseUnit` for display elsewhere. */
  doseValue: number;
}

/** ±10 % match radius for snapping a logged dose to a ladder step. */
const STEP_MATCH_TOLERANCE = 0.1;

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * Build the ordered ladder for a given drug-id. Returns an empty
 * array if the id is not in the catalog (defensive — the catalog is
 * static so this branch is unreachable in practice).
 */
export function getLadder(drugId: Glp1DrugId): TitrationStep[] {
  const record = GLP1_DRUGS[drugId];
  if (!record) return [];
  return ladderFromRecord(record);
}

/**
 * Convenience overload that takes the record directly (the chart and
 * the API route already resolve the record once via `findDrugByBrand`
 * — passing it through avoids a second lookup).
 */
export function ladderFromRecord(record: Glp1DrugRecord): TitrationStep[] {
  return record.titrationStepsMg.map((doseMg, stepIndex) => ({
    stepIndex,
    doseMg,
    typicalWeeks: record.titrationIntervalWeeks,
  }));
}

/**
 * Match the user's most recent dose to the closest step on the
 * ladder, within ±10 % tolerance.
 *
 * Returns null when the latest dose is outside any step's tolerance
 * window — this is the "user is on a non-standard dose" path the UI
 * surfaces with an explanatory caption instead of a misleading
 * highlight.
 */
export function findCurrentStep(
  drugId: Glp1DrugId,
  latestDoseMg: number | null,
): TitrationStep | null {
  if (latestDoseMg === null || !Number.isFinite(latestDoseMg)) return null;
  if (latestDoseMg <= 0) return null;
  const ladder = getLadder(drugId);
  if (ladder.length === 0) return null;

  let best: { step: TitrationStep; diff: number } | null = null;
  for (const step of ladder) {
    const diff = Math.abs(step.doseMg - latestDoseMg);
    const tolerance = step.doseMg * STEP_MATCH_TOLERANCE;
    if (diff > tolerance) continue;
    if (!best || diff < best.diff) {
      best = { step, diff };
    }
  }
  return best?.step ?? null;
}

/**
 * Return the immediate-next step above `currentStep`, or null when
 * the user is already on the ceiling. Identity-by-stepIndex so callers
 * that round-tripped the step through JSON still match.
 */
export function nextStep(
  drugId: Glp1DrugId,
  currentStep: TitrationStep | null,
): TitrationStep | null {
  if (!currentStep) return null;
  const ladder = getLadder(drugId);
  const idx = ladder.findIndex((s) => s.stepIndex === currentStep.stepIndex);
  if (idx < 0) return null;
  if (idx + 1 >= ladder.length) return null;
  return ladder[idx + 1];
}

/**
 * Count how long the user has been on the matched step, in whole
 * weeks rounded down. Reads the `MedicationDoseChange` stream and
 * scans backwards from `asOf` for the most recent transition onto
 * (or past) the matched dose; the elapsed time since that transition
 * is the answer.
 *
 * Returns 0 when:
 *   - no dose-change rows match the step at all (e.g. brand-new med
 *     where the user hasn't logged a titration row yet);
 *   - the latest matching change is in the future;
 *   - `currentStep` is null.
 *
 * Rationale: matching by step (not by exact mg) is what makes this
 * resilient to a user logging "0.5 mg" and the ladder declaring
 * "0.5 mg" — we already snap to a step in `findCurrentStep`, so we
 * snap dose-change rows the same way here.
 */
export function weeksOnCurrentStep(
  drugId: Glp1DrugId,
  currentStep: TitrationStep | null,
  doseChanges: DoseChangeLike[],
  asOf: Date,
): number {
  if (!currentStep) return 0;
  const tolerance = currentStep.doseMg * STEP_MATCH_TOLERANCE;
  // Sort defensively — the API route orders by effectiveFrom asc but
  // we don't trust caller ordering.
  const matches = doseChanges
    .filter((dc) => {
      const diff = Math.abs(dc.doseValue - currentStep.doseMg);
      return diff <= tolerance;
    })
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
  if (matches.length === 0) return 0;
  const latest = matches[0];
  if (latest.effectiveFrom.getTime() > asOf.getTime()) return 0;
  const elapsedMs = asOf.getTime() - latest.effectiveFrom.getTime();
  return Math.max(0, Math.floor(elapsedMs / MS_PER_WEEK));
}

/**
 * Display flag — true when the EMA-reference minimum dwell time has
 * elapsed AND a next ladder step exists.
 *
 * Parameters:
 *   - `drugIdForCeiling`: identifies which ladder to walk so the
 *     "next step exists" guard knows when the user has hit the
 *     ceiling. The dwell-time check itself reads `typicalWeeks`
 *     straight off `currentStep`; the drug id is only needed to
 *     answer "is there a step above this one?".
 *   - `currentStep`: the step the user is sitting on today. Null
 *     when titration is paused or the user is at the bottom of the
 *     ladder with no recorded dose history.
 *   - `weeksOnStep`: how many complete weeks have elapsed since the
 *     user landed on `currentStep`. Computed by `weeksOnCurrentStep`.
 *
 * IMPORTANT: this is a *reference* signal, not advice. The UI copy
 * tied to this boolean is strictly observational ("ladder typically
 * steps up around N weeks") — never prescriptive. MDR boundary, see
 * the W19c safety ground-rules.
 */
export function escalationDue(
  drugIdForCeiling: Glp1DrugId,
  currentStep: TitrationStep | null,
  weeksOnStep: number,
): boolean {
  if (!currentStep) return false;
  if (!nextStep(drugIdForCeiling, currentStep)) return false;
  return weeksOnStep >= currentStep.typicalWeeks;
}
