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
 * The message key suffix (under `insights.healthScore.reason.`) for each
 * reason a pillar is not scored. The panel on Insights and the dashboard
 * snapshot's pillar block word a pillar the same way from this one map; an
 * unknown reason falls back to "unavailable".
 */
export const SCORE_PILLAR_REASON_KEYS: Readonly<Record<string, string>> = {
  read_failed: "readFailed",
  not_tracked: "notTracked",
  missing_reference_profile: "missingProfile",
  missing_height: "missingHeight",
  incomplete_or_stale_panel: "incompletePanel",
  crisis_signposting: "crisis",
  below_day_floor_or_stale: "insufficientHistory",
  below_reading_floor: "insufficientHistory",
  stale_or_untracked: "insufficientHistory",
  unverified_or_stale: "insufficientHistory",
  below_reading_floor_or_stale: "insufficientHistory",
  below_night_floor_or_stale: "insufficientHistory",
  stale: "insufficientHistory",
};

/** The full message key for a pillar's not-scored reason. */
export function scorePillarReasonKey(reason: string): string {
  return `insights.healthScore.reason.${SCORE_PILLAR_REASON_KEYS[reason] ?? "unavailable"}`;
}

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
  return healthScoreSetter(report, t)?.line ?? null;
}

/** The pillar named beside the health score: its id, its band, its line. */
export interface HealthScoreSetter {
  id: ScorePillarId;
  /** The pillar's own band; always worse than the score's. */
  band: "yellow" | "red";
  /** The worded line, e.g. "Blood pressure: outside the reference range". */
  line: string;
}

/**
 * The pillar the health score's band leaves unsaid (`bandSetter`), resolved
 * once: every surface that puts the score into words or colour reads this,
 * so none of them can call a day steady while that pillar is red.
 */
export function healthScoreSetter(
  report: Pick<HealthScoreReport, "composite" | "pillars">,
  t: (key: string, params?: Record<string, string | number>) => string,
): HealthScoreSetter | null {
  const { composite } = report;
  if (composite.status !== "ok" || !composite.value.bandSetter) return null;
  const id = composite.value.bandSetter;
  const pillar = report.pillars.find((p) => p.id === id);
  if (!pillar || pillar.result.status !== "ok") return null;
  const band = scoreBand(pillar.result.value.score);
  if (band === "green") return null;
  const key =
    band === "red"
      ? "insights.healthScore.setter.outside"
      : "insights.healthScore.setter.attention";
  return { id, band, line: t(key, { pillar: t(SCORE_PILLAR_LABEL_KEYS[id]) }) };
}

/**
 * The worse of the score's own band and its setter's: the band a sentence
 * about the day may use. A green 79 over a red blood pressure is not a
 * "steady" day, whatever the number's colour.
 */
export function worseScoreBand(
  band: string,
  setterBand: "yellow" | "red" | null | undefined,
): string {
  if (!setterBand) return band;
  const rank: Record<string, number> = { red: 0, yellow: 1, green: 2 };
  return (rank[setterBand] ?? 2) < (rank[band] ?? 2) ? setterBand : band;
}
