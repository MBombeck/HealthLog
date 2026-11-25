/**
 * The localised names of the score's pillars and the domains they sit in.
 *
 * One map per concept, read by the hero panel and by the settings surface
 * that decides what counts. Two copies of a name map drift the moment one
 * surface renames a pillar, and the two surfaces would then be talking
 * about different things while showing the same list.
 */
import type { ScorePillarId } from "@/lib/analytics/score/types";

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
