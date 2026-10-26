/**
 * The sleep series: one point per night carrying its time asleep in hours.
 */
import { readSleepNights } from "@/lib/measurements/list/sleep-nights";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import type { SleepStage } from "@/generated/prisma/client";

import type { SeriesRead } from "./kinds";

export async function readSleepSeries(
  userId: string,
  since: Date,
  days: number,
): Promise<SeriesRead> {
  // SLEEP_DURATION is stored one row per STAGE per night (minutes).
  // Collapse the stage rows into ONE point per night carrying the
  // night's TIME ASLEEP (CORE + DEEP + REM, excluding IN_BED + AWAKE),
  // converted to HOURS. The single-stage rows the legacy path returned
  // made the chart show one fragment per stage instead of a nightly
  // trend. The per-night reconstruction clusters stages into sessions
  // (so a midnight-spanning night stays one point) and collapses a
  // dual-source night to one canonical source via the user's `sleep`
  // priority ladder.
  //
  // Sleep is the one kind read row-per-stage rather than from the rollup
  // tier, so the nights are named in Postgres and reconstructed a chunk at
  // a time (`readSleepNights`): "All" reaches as far back as the history
  // does, and the stage rows in the heap stay a chunk's worth.
  const [tz, priorityJson] = await Promise.all([
    resolveUserTimezone(userId),
    loadUserSourcePriority(userId),
  ]);
  const nights = await readSleepNights(userId, tz, priorityJson, {
    from: since,
    // A window of `days` days holds at most one night more than that.
    maxNights: days + 1,
  });
  const points = nights
    .filter((n) => n.asleepMinutes > 0)
    .map((n) => {
      const stageHours = Object.fromEntries(
        Object.entries(n.stages).map(([s, m]) => [
          s,
          Math.round((m / 60) * 100) / 100,
        ]),
      ) as Partial<Record<SleepStage, number>>;
      return {
        id: `sleep:${n.night}`,
        at: n.measuredAt.toISOString(),
        value: Math.round((n.asleepMinutes / 60) * 100) / 100,
        secondary: null,
        sleepStages: Object.keys(stageHours).length > 0 ? stageHours : null,
      };
    });
  return { points, unit: "h" };
}
