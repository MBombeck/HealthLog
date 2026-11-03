/**
 * Query string for one type's chart series (`GET /api/measurements`).
 *
 * Every range asks for one row per local calendar day. The 7-day range used
 * to ask for raw rows oldest-first under a 5 000-row limit; a per-minute
 * heart-rate stream holds 10 080 rows in seven days, so the answer stopped
 * half-way through the week and the newest days were silently missing. The
 * chart folds rows into days either way, so the daily answer draws the same
 * points while its size depends only on the number of days.
 *
 * `partOfDay` narrows each day to the readings of one part of it (#1331).
 *
 * Pure so the request the chart makes can be tested against the real route.
 */
export function chartSeriesParams(
  type: string,
  window: { from: string; to: string },
  partOfDay?: string,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("type", type);
  params.set("sortBy", "measuredAt");
  params.set("sortDir", "asc");
  params.set("from", window.from);
  params.set("to", window.to);
  params.set("limit", "5000");
  params.set("aggregate", "daily");
  params.set("source", "rollup");
  if (partOfDay) params.set("partOfDay", partOfDay);
  return params;
}
