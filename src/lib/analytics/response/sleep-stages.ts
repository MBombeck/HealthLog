/**
 * The sleep-stage block of the default analytics body.
 */
import { prisma } from "@/lib/db";
import {
  buildSleepStageComposition,
  type SleepStageComposition,
} from "@/lib/analytics/sleep-stage-composition";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";

/**
 * Per-stage sleep-minutes breakdown over the trailing 30 days.
 *
 * Returns `null` when the user has no stage-tagged sleep rows in
 * window — the analytics consumer renders the existing
 * `summaries.SLEEP_DURATION` totals without a stage card in that
 * case. Returns the sum-per-stage AND the day count covered so the
 * UI can render an "averaged across N nights" caption truthfully.
 *
 * Also returns a `perNight` array: one entry per
 * Berlin-tz day inside the window, with minutes-per-stage for the
 * stacked-bar chart. Days with zero stage-tagged rows are omitted
 * from `perNight` (the chart treats them as gaps).
 *
 * The per-night stages are the MAIN NIGHT's stages. A nap ends on the
 * same wake day as that morning's night, and the per-wake-day totals
 * folded it into the night's buckets — an afternoon nap added CORE to
 * the night and the column read longer and shallower than the night
 * was. The nap's minutes now ride alongside on `napMinutes` /
 * `napCount`, both absent on a day without one.
 */
export async function computeSleepStageBreakdown(
  userId: string,
  userTz: string,
): Promise<SleepStageComposition | null> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WINDOW_DAYS = 30;
  const since = new Date(Date.now() - WINDOW_DAYS * DAY_MS);
  // Read the FULL per-stage row set (not `sleepStage: { not: null }`)
  // and route it through the canonical session reconstruction so the
  // stacked-bar agrees with the dashboard tile + chart series. The old path
  // keyed each stage row by its OWN calendar day (splitting a midnight-
  // spanning night across two buckets) and never collapsed multi-source
  // (double-counting a WHOOP + Apple Health night). Routing through the
  // helper fixes both: it session-clusters, keys by the wake day, and picks
  // one canonical source per night. The bare-vs-granular de-dup is applied
  // per-session to the per-stage breakdown too. The `source` is selected so
  // the helper's source-collapse can run.
  const rows = await prisma.measurement.findMany({
    where: {
      userId,
      type: "SLEEP_DURATION",
      measuredAt: { gte: since },
      deletedAt: null,
    },
    select: {
      value: true,
      measuredAt: true,
      sleepStage: true,
      source: true,
      deviceType: true,
    },
  });

  if (rows.length === 0) return null;

  const priorityJson = await loadUserSourcePriority(userId);
  return buildSleepStageComposition(rows, userTz, priorityJson, WINDOW_DAYS);
}
