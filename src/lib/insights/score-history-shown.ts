/**
 * The number each score's headline shows right now, for the newest point of
 * its history chart (`readScoreHistory`'s `shown`).
 *
 * Each resolver reads the headline's own source, never a second computation
 * beside it: the health score's kept or freshly computed report (the one
 * `/api/analytics` serves, recorded on the same call), readiness's cached
 * derived read (the one `/api/insights/derived` serves). The sleep score has
 * none: its headline is the newest night of the series the chart reads.
 *
 * Server-only.
 */
import { shownHealthScore } from "@/lib/analytics/score/derived";
import type { ReadinessValue } from "@/lib/insights/derived/readiness";
import { readDerivedSingle } from "@/lib/insights/derived/single-read";

import type { ScoreHistoryId } from "./score-history-ids";

type Shown = { day: string; value: number } | null;

export function shownScoreFor(
  score: ScoreHistoryId,
  userId: string,
): (() => Promise<Shown>) | null {
  switch (score) {
    case "HEALTH_SCORE":
      return () => shownHealthScore(userId);
    case "READINESS":
      return async () => {
        const derived = await readDerivedSingle({
          userId,
          metric: "READINESS",
        });
        if (derived.status !== "ok" || !derived.value) return null;
        const value = derived.value as ReadinessValue;
        return { day: value.asOfDay, value: value.score };
      };
    case "SLEEP_SCORE":
      return null;
  }
}
