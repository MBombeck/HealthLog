/**
 * The data kinds that never leave for a model or an external tool.
 *
 * One list, read by every path that hands a person's record to a model (the
 * Coach and its tools, the AI status cards, the briefing) or to an MCP
 * client. The mental-wellbeing page tells the person that their answers and
 * scores never reach an AI feature, so the questionnaires sit here:
 *
 *   - the administrations themselves (item answers, total, severity band,
 *     the PHQ-9 self-harm item flag), which the day carries as its
 *     `assessments` section;
 *   - the total each administration also files as a `*_SCORE` measurement
 *     (`score-projection.ts`), which every generic measurement read would
 *     otherwise pick up like any other reading.
 *
 *   - the health score's wellbeing pillar, which is scored from those
 *     questionnaires alone. A score leaves for a model in its model-bound
 *     form, recomposed from the other pillars
 *     (`analytics/score/model-bound.ts`).
 *
 * Life events sit in the day section list for the same reason
 * (`MODEL_EXCLUDED_DAY_SECTIONS`). AUDIT-C is not on this list: it belongs to
 * the life circumstances, whose sections reach the Coach only when the person
 * releases them there.
 *
 * Two layers use the list. The readers leave the kinds out where they build
 * a payload (the day projection, the status-card reads). The exits run
 * {@link withoutModelBoundExclusions} over what is about to leave (every MCP
 * tool result and resource, every Coach tool result), so a reader added
 * later that forgets the rule still cannot hand the kinds over.
 * `model-bound-data-guard.test.ts` holds both.
 */
import { MODEL_EXCLUDED_DAY_SECTIONS } from "@/lib/day/contract";
import { INSTRUMENT_MEASUREMENT_TYPE } from "@/lib/mental-health/instruments";
import type { ScorePillarId } from "@/lib/analytics/score/types";

/** Measurement types that never reach a model: the questionnaire totals. */
export const MODEL_EXCLUDED_MEASUREMENT_TYPES: ReadonlySet<string> = new Set(
  Object.values(INSTRUMENT_MEASUREMENT_TYPE),
);

/**
 * Health score pillars that never reach a model, in a score or on their own:
 * the wellbeing pillar is the questionnaire totals under another name.
 */
export const MODEL_EXCLUDED_SCORE_PILLARS: ReadonlySet<ScorePillarId> =
  new Set<ScorePillarId>(["WELLBEING"]);

/** Day sections that never reach a model. */
export const MODEL_EXCLUDED_SECTIONS: ReadonlySet<string> = new Set(
  MODEL_EXCLUDED_DAY_SECTIONS,
);

/** Whether a measurement type may reach a model at all. */
export function isModelVisibleMeasurementType(type: string): boolean {
  return !MODEL_EXCLUDED_MEASUREMENT_TYPES.has(type);
}

/** Whether an object names an excluded kind in one of its own fields. */
function carriesExcludedKind(value: Record<string, unknown>): boolean {
  for (const [key, field] of Object.entries(value)) {
    if (typeof field !== "string") continue;
    if (MODEL_EXCLUDED_MEASUREMENT_TYPES.has(field)) return true;
    if (key === "section" && MODEL_EXCLUDED_SECTIONS.has(field)) return true;
  }
  return false;
}

const DROP = Symbol("drop");

function scrub(value: unknown, dropped: { count: number }): unknown {
  if (typeof value === "string") {
    if (MODEL_EXCLUDED_MEASUREMENT_TYPES.has(value)) {
      dropped.count += 1;
      return DROP;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const next = scrub(item, dropped);
      if (next !== DROP) out.push(next);
    }
    return out;
  }
  if (value !== null && typeof value === "object") {
    // Only plain objects are walked; a Date or any other instance leaves as
    // it is and serialises through its own `toJSON`.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const record = value as Record<string, unknown>;
    if (carriesExcludedKind(record)) {
      dropped.count += 1;
      return DROP;
    }
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(record)) {
      if (MODEL_EXCLUDED_MEASUREMENT_TYPES.has(key)) {
        dropped.count += 1;
        continue;
      }
      const next = scrub(field, dropped);
      if (next !== DROP) out[key] = next;
    }
    return out;
  }
  return value;
}

/**
 * A model-bound payload without any excluded kind: an entry that names one
 * (a reading of a questionnaire total, an item of the `assessments` section,
 * a key or a string that is such a type) is dropped from its list or its
 * object. `undefined` when the payload itself is such an entry, so the exit
 * answers with its own miss instead.
 *
 * The readers already leave these kinds out; a non-zero `dropped` here means
 * one of them did not, and the exit reports it.
 */
export function withoutModelBoundExclusions<T>(payload: T): {
  value: T | undefined;
  dropped: number;
} {
  const dropped = { count: 0 };
  const next = scrub(payload, dropped);
  return {
    value: next === DROP ? undefined : (next as T),
    dropped: dropped.count,
  };
}
