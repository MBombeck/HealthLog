/**
 * The evidence block of the arrival line (`reaction-line.ts`): the exact new
 * datum first, then the context the digest already computed.
 */
import { countsModelExcludedPillar } from "@/lib/analytics/score/model-bound";

/**
 * The deterministic evidence block. The first section is the exact new datum;
 * the remaining context comes from the already-computed digest the line will
 * sit inside.
 *
 * The health score goes only when its composition counts no pillar a model
 * may not see: the digest holds the live composite, not its pillars, so a
 * score built on the questionnaires (or on a composition it does not name)
 * is left out rather than recomposed.
 */
export function buildEvidence(
  arrived: string,
  digest: {
    score: {
      value: number;
      band: string;
      numberBand?: string;
      delta: number | null;
      composition?: readonly string[];
      bandSetter?: string | null;
      bandSetterBand?: "yellow" | "red" | null;
    } | null;
    topSignal: { headline: string; delta: string | null } | null;
    briefingLead: string | null;
  },
): string {
  const parts: string[] = [arrived];
  if (
    digest.score &&
    digest.score.composition !== undefined &&
    !countsModelExcludedPillar(digest.score.composition)
  ) {
    const delta =
      digest.score.delta === null
        ? "no baseline comparison available"
        : `${digest.score.delta > 0 ? "+" : ""}${Math.round(digest.score.delta)} vs their baseline`;
    // The band follows the number, so a pillar in a worse band rides beside
    // it; "79 (green)" alone over a red blood pressure would read as all good.
    const setter =
      digest.score.bandSetter && digest.score.bandSetterBand
        ? `; the ${digest.score.bandSetter} area is ${digest.score.bandSetterBand}`
        : "";
    parts.push(
      `- Health score: ${Math.round(digest.score.value)} (${digest.score.numberBand ?? digest.score.band}${setter}), ${delta}.`,
    );
  }
  if (digest.topSignal) {
    parts.push(
      `- Today's leading signal: ${digest.topSignal.headline}${
        digest.topSignal.delta ? ` (${digest.topSignal.delta})` : ""
      }.`,
    );
  }
  if (digest.briefingLead) {
    parts.push(`- The day's standing read: ${digest.briefingLead}`);
  }
  return parts.join("\n");
}
