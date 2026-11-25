/**
 * The headline value of a metric tile: the number printed large on a card
 * that stands for "where this metric is now".
 *
 * It is the summary's `latest`, the canonical latest reading the server
 * resolves once per type (`readLatestCanonical`: the latest day, then the
 * source ladder). The dashboard tiles and the vitals grid on the insights
 * overview both print it. The vitals grid used to print a statistic of its
 * own (the band's 30-day median on most tiles, a seven-day mean on the HRV
 * tile), so the same metric read 55 ms on the dashboard and 57 ms one page
 * further. Windows and bands still frame the headline; they never replace it.
 */
export function headlineValue(
  summary: { latest: number | null } | null | undefined,
): number | null {
  return summary?.latest ?? null;
}
