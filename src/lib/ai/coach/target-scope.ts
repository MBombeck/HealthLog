import type { CoachScopeSource } from "@/lib/ai/coach/types";

/**
 * v1.4.25 W3e — per-target Coach scope source mapping.
 *
 * The per-card "Ask Coach about this" CTA narrows the snapshot to the
 * single source the user is asking about. For derived metrics (BMI
 * derives from weight; mood stability derives from mood) we map to the
 * underlying source — the Coach prompt-builder knows how to talk
 * about the derived view but the data it needs lives in the source.
 *
 * Targets without a CoachScopeSource counterpart (glucose contexts,
 * steps, sleep, body-fat as of v1.4.23) fall back to an empty array,
 * which the drawer reads as "do not narrow — use defaults". The
 * Coach defaults already include the five-source set, so the snapshot
 * stays useful even when this map has no opinion.
 */
export function coachScopeForTarget(
  targetType: string,
): ReadonlyArray<CoachScopeSource> {
  switch (targetType) {
    case "WEIGHT":
    case "BMI":
      return ["weight"];
    case "BLOOD_PRESSURE":
    case "BLOOD_PRESSURE_IN_TARGET":
      return ["bp"];
    case "PULSE":
      return ["pulse"];
    case "MOOD_SCORE":
    case "MOOD_STABILITY":
      return ["mood"];
    case "MEDICATION_COMPLIANCE":
      return ["compliance"];
    case "SLEEP_DURATION":
      return ["sleep"];
    case "ACTIVITY_STEPS":
      return ["steps"];
    case "BODY_FAT":
      // No 1:1 source — the snapshot's weight + general blocks carry
      // the surrounding context. Empty scope = "use defaults".
      return [];
    default:
      // Glucose contexts + future targets — defaults will surface the
      // available scopes in the drawer.
      return [];
  }
}
