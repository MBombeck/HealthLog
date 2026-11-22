/**
 * The seizure diary in the Coach snapshot.
 *
 * MCP's `get_seizures` and the doctor report carried the diary; the Coach
 * did not, so "has she had more seizures since the new dose?" got "no data"
 * in the app while Claude over MCP could answer it. The block is the same
 * server derivation (`readSeizureDiary`), condensed to counts and dates:
 * recorded seizures, seizure days, days since the last, the cluster episodes
 * under the record's own rule and under NICE's 3 in 24 hours, rescue doses,
 * emergency care, and the month totals. No type names, notes or rescue plans
 * (the family's own words), so nothing in it needs fencing.
 *
 * Gated on the `seizures` module and held to the Coach's history reach. The
 * Coach itself is behind the AI capability; this block adds no data surface.
 * The system prompt's seizure rule says how to word it: the record, never a
 * diagnosis, a risk estimate or advice to wait.
 */
import { isModuleEnabled } from "@/lib/modules/gate";
import { readSeizureDiary } from "@/lib/seizures/server";

import {
  reachFloor,
  UNBOUNDED_REACH,
  type CoachHistoryReach,
} from "./history-reach";

/** The trailing window the block covers, inside the history reach. */
export const COACH_SEIZURE_WINDOW_DAYS = 90;
/** The newest cluster episodes the block names by date. */
const MAX_CLUSTERS = 5;

export interface CoachSeizuresBlock {
  windowDays: number;
  clusterRule: { count: number; windowHours: number };
  recordedSeizures: number;
  suspected: number;
  seizureDays: number;
  daysSinceLastRecorded: number | null;
  clusterEpisodes: number;
  clusterEpisodesNice3In24h: number;
  recentClusters: Array<{ startAt: string; endAt: string; seizures: number }>;
  rescueDoses: number;
  emergencies: { emsCalled: number; edVisits: number; admissions: number };
  /** Seizures and seizure days per `YYYY-MM`, all types together. */
  monthly: {
    months: string[];
    seizures: Record<string, number>;
    days: Record<string, number>;
  };
  note: string;
}

export async function buildSeizuresSnapshotBlock(
  userId: string,
  userTz: string,
  now: Date,
  reach: CoachHistoryReach = UNBOUNDED_REACH,
): Promise<CoachSeizuresBlock | null> {
  if (!(await isModuleEnabled(userId, "seizures"))) return null;
  const windowStart = new Date(
    now.getTime() - COACH_SEIZURE_WINDOW_DAYS * 86_400_000,
  );
  const floor = reachFloor(reach, now);
  const from = floor && floor > windowStart ? floor : windowStart;
  const diary = await readSeizureDiary({
    userId,
    viewerId: userId,
    tz: userTz,
    from,
    to: now,
    now,
  });
  if (diary.events.length === 0) return null;
  const s = diary.summary;
  return {
    windowDays: Math.round((now.getTime() - from.getTime()) / 86_400_000),
    clusterRule: diary.settings.rule,
    recordedSeizures: s.seizures,
    suspected: s.suspected,
    seizureDays: s.seizureDays,
    daysSinceLastRecorded: s.streak.daysSinceLast,
    clusterEpisodes: s.clusters.length,
    clusterEpisodesNice3In24h: s.niceClusterCount,
    recentClusters: [...s.clusters]
      .sort((a, b) => b.startAt.localeCompare(a.startAt))
      .slice(0, MAX_CLUSTERS)
      .map((c) => ({
        startAt: c.startAt,
        endAt: c.endAt,
        seizures: c.seizureCount,
      })),
    rescueDoses: s.rescueDoses,
    emergencies: s.emergencies,
    monthly: {
      months: s.monthly.months,
      seizures: s.monthly.total.counts,
      days: s.monthly.total.days,
    },
    note: "Recorded seizures from a patient or carer diary; likely an undercount, especially from sleep.",
  };
}
