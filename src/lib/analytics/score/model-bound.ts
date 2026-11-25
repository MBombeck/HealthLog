/**
 * The health score as it may leave for a model.
 *
 * The wellbeing pillar is scored from the mental-health questionnaires alone,
 * and those never reach a model (`MODEL_EXCLUDED_SCORE_PILLARS` in
 * `ai/model-bound-data.ts`). A composite that counted it would carry them in
 * its number, so a score bound for a model is recomposed from the pillars it
 * may carry: the mean of their stored scores, rounded as the composite rounds
 * (`computeComposite`). The score a person sees is not touched.
 *
 * Two exits use it: the day read the Coach and the MCP endpoint share
 * (`readDayScores` with `modelBound`) recomposes every stored day, and the
 * arrival line (`reaction-line.ts`), which holds the live composite but not
 * its pillars, leaves the score out whenever the composition counts an
 * excluded pillar. `privacy-promise-guard.test.ts` holds both.
 */
import { MODEL_EXCLUDED_SCORE_PILLARS } from "@/lib/ai/model-bound-data";

/** Whether a composition counts a pillar no model may see. */
export function countsModelExcludedPillar(
  composition: readonly string[],
): boolean {
  return composition.some((id) =>
    MODEL_EXCLUDED_SCORE_PILLARS.has(id as never),
  );
}

/** A stored day of the score: its composite and the pillars behind it. */
export interface StoredCompositeRow {
  composite: number;
  composition: readonly string[];
  pillarScores: unknown;
}

/**
 * The composite a model may read for a stored day: the composite itself when
 * no excluded pillar counted, otherwise the rounded mean of the other
 * counted pillars. Null when nothing else counted, or when a counted pillar's
 * score is missing from the row, since a mean over part of the composition
 * would be a number nobody was shown.
 */
export function modelBoundComposite(row: StoredCompositeRow): number | null {
  if (!countsModelExcludedPillar(row.composition)) return row.composite;
  const scores =
    row.pillarScores !== null &&
    typeof row.pillarScores === "object" &&
    !Array.isArray(row.pillarScores)
      ? new Map(Object.entries(row.pillarScores as Record<string, unknown>))
      : new Map<string, unknown>();
  const kept: number[] = [];
  for (const id of row.composition) {
    if (MODEL_EXCLUDED_SCORE_PILLARS.has(id as never)) continue;
    const score = scores.get(id);
    if (typeof score !== "number" || !Number.isFinite(score)) return null;
    kept.push(score);
  }
  if (kept.length === 0) return null;
  return Math.round(kept.reduce((sum, n) => sum + n, 0) / kept.length);
}
