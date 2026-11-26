/**
 * The localised names of the score's pillars and the domains they sit in.
 *
 * One map per concept, read by the hero panel and by the settings surface
 * that decides what counts. Two copies of a name map drift the moment one
 * surface renames a pillar, and the two surfaces would then be talking
 * about different things while showing the same list.
 */
import { scoreBand } from "@/lib/analytics/score/shared";
import type {
  HealthScoreReport,
  ScorePillarId,
} from "@/lib/analytics/score/types";

export const SCORE_PILLAR_LABEL_KEYS: Record<ScorePillarId, string> = {
  BLOOD_PRESSURE: "insights.healthScore.pillar.bloodPressure",
  GLYCAEMIA: "insights.healthScore.pillar.glycaemia",
  ACTIVITY: "insights.healthScore.pillar.activity",
  SLEEP: "insights.healthScore.pillar.sleep",
  ADIPOSITY: "insights.healthScore.pillar.adiposity",
  WELLBEING: "insights.healthScore.pillar.wellbeing",
  LIPIDS: "insights.healthScore.pillar.lipids",
};

/**
 * The line that names the pillar sitting in a worse band than the health
 * score itself (`bandSetter`), or null when none does. Since 1.50 the
 * score's band follows its number like every other score, so an 81 reads
 * good; a red or yellow pillar under it is said here, by name, on every
 * surface that shows the score, rather than folded into its band word.
 */
export function healthScoreSetterLine(
  report: Pick<HealthScoreReport, "composite" | "pillars">,
  t: (key: string, params?: Record<string, string | number>) => string,
): string | null {
  const { composite } = report;
  if (composite.status !== "ok" || !composite.value.bandSetter) return null;
  const id = composite.value.bandSetter;
  const pillar = report.pillars.find((p) => p.id === id);
  if (!pillar || pillar.result.status !== "ok") return null;
  const key =
    scoreBand(pillar.result.value.score) === "red"
      ? "insights.healthScore.setter.outside"
      : "insights.healthScore.setter.attention";
  return t(key, { pillar: t(SCORE_PILLAR_LABEL_KEYS[id]) });
}
