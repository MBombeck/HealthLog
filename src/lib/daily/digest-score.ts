/**
 * The Health score as the digest carries it: the snapshot's block, how long
 * it has held, and its short name for a tile. Pure.
 */
import type {
  ScoreBasis,
  ScoreDeltaReason,
  ScorePillarId,
} from "@/lib/analytics/score/types";
import type { SteadyRun } from "@/lib/daily/score-steady";
import { scoreShortLabel } from "@/lib/scores/registry";

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export interface DailyDigestScore {
  value: number;
  /** The worse of the number's band and the worst pillar's (shipped apps). */
  band: string;
  /** 1.50: the number's own band; the web draws this. Old caches lack it. */
  numberBand?: string;
  delta: number | null;
  /** Additive score identity; omitted by older cached digests. */
  deltaReason?: ScoreDeltaReason | null;
  scoreVersion?: number;
  composition?: ScorePillarId[];
  /**
   * The resolved "this score is configured" flag, carried
   * straight from the snapshot's health-score block. Omitted by older
   * cached digests, like its siblings above.
   */
  configured?: boolean;
  /**
   * How broad the set behind the number is, carried straight
   * from the snapshot's health-score block. Since v1.38 a score exists
   * at one or two areas of health as well as three and is computed the
   * same way at each, so this block is what tells a narrow score from a
   * broad one. Omitted by older cached digests, like its siblings above.
   */
  scoreBasis?: ScoreBasis;
  /**
   * Whole weeks the score has held where it is (same band, within two
   * points, computed the same way), read off the stored daily scores. Null
   * when it has not held for two weeks, when the stored record does not
   * reach today, or when the score moved. Optional so older cached digests
   * stay valid.
   */
  steadyWeeks?: number | null;
  /**
   * True when the run reaches back past everything the read covered, so
   * `steadyWeeks` is a lower bound ("at least"), not the run's start.
   */
  steadyAtLeast?: boolean;
  /**
   * The pillar in a worse band than the score, its band and its worded line
   * (the snapshot's). Shown wherever the score is; optional for old caches.
   */
  bandSetter?: ScorePillarId | null;
  bandSetterBand?: "yellow" | "red" | null;
  bandSetterLine?: string | null;
  /**
   * The score's short name for a tile ("Gesundheit"), from the score
   * registry (`scoreShortLabel`). Optional for old caches; additive in 1.50.
   */
  shortLabel?: string;
}

/** The digest's score from the snapshot's, or null when there is none. */
export function digestScore(
  score: DailyDigestScore | null | undefined,
  steady: SteadyRun | null | undefined,
  t: Translate,
): DailyDigestScore | null {
  if (!score) return null;
  return {
    ...score,
    steadyWeeks: steady?.weeks ?? null,
    steadyAtLeast: steady?.atLeast ?? false,
    shortLabel: scoreShortLabel("HEALTH_SCORE", t),
  };
}
