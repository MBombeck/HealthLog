/**
 * Where a reading's local day is still read in the profile zone.
 *
 * Since 0520 a reading may carry the zone it was taken in, and the day view,
 * the day aggregates, the daily series and the sleep clock place it on its
 * own local day (`reading-zone.ts`). The doctor report and the BP status did
 * not, so a reading taken abroad sat on one day in the app and another in
 * the report. Those two read the reading's zone now; the files below still
 * place readings on the profile zone's day, either by SQL
 * (`"measured_at" AT TIME ZONE`) or in code (`userDayKey(x.measuredAt, …)`).
 *
 * A ratchet, not a verdict: some of them are right as they are (UTC rollup
 * buckets, window bounds, step-source days that are profile days by
 * definition), the rest are to move onto `readingWallSql` / `readingDayKey`.
 * A new file that places readings by the profile zone fails here; a file
 * that moves off it must leave the list, so the list only shrinks.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

const SQL_PROFILE_DAY = /measured_at"\)?\s*AT TIME ZONE/;
const CODE_PROFILE_DAY = /userDayKey\(\s*[A-Za-z_$][\w$.]*\.measuredAt\b/;

const BASELINE_SQL = [
  "lib/activity/calendar-read.ts",
  "lib/analytics/resting-pulse-read.ts",
  "lib/day/daily-stats.ts",
  "lib/environment/air-quality-history.ts",
  "lib/gamification/achievements-result.ts",
  "lib/insights/correlation-channel-series.ts",
  "lib/measurements/day-aggregates.ts",
  "lib/measurements/dense-series-read.ts",
  "lib/rollups/tiered-context.ts",
  "lib/targets/glucose-read.ts",
  "lib/tz/reading-zone-sql.ts",
  "lib/withings/other-step-source-days.ts",
];

const BASELINE_CODE = [
  "lib/ai/coach/snapshot-series.ts",
  "lib/analytics/correlations-fast-path.ts",
  "lib/analytics/score/reader.ts",
  "lib/day/scores.ts",
  "lib/export/paged-measurements.ts",
  "lib/gamification/expansion-metrics.ts",
  "lib/illness/correlation-read.ts",
  "lib/illness/safety-floor-check.ts",
  "lib/insights/comprehensive-overview/daily-series.ts",
  "lib/insights/correlation-channel-series.ts",
  "lib/insights/derived/coach-read.ts",
  "lib/insights/derived/coincident-deviation.ts",
  "lib/insights/derived/readiness.ts",
  "lib/insights/derived/wellness-scores.ts",
  "lib/insights/signals-of-day.ts",
  "lib/jobs/oura-backfill.ts",
  "lib/measurements/consolidation-base.ts",
  "lib/measurements/folded-window.ts",
  "lib/measurements/intraday-cumulative-profile.ts",
  "lib/search/search-records.ts",
  "lib/targets/consistency.ts",
  "lib/targets/glucose-read.ts",
  "lib/targets/vitals-builder.ts",
  "lib/timeline/load-timeline.ts",
  "lib/timeline/readiness.ts",
];

function matching(pattern: RegExp): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => p.startsWith("lib/") || p.startsWith("app/"))
    .filter((p) => !p.includes("__tests__") && !/\.test\.tsx?$/.test(p))
    .filter((p) => pattern.test(stripComments(readSourceText(join(SRC, p)))))
    .sort();
}

describe("readers that place a reading on the profile zone's day", () => {
  it("in SQL are only the known ones", () => {
    const found = matching(SQL_PROFILE_DAY);
    expect(found.length).toBeGreaterThan(0);
    expect(
      found,
      "Place a reading on its own day with readingWallSql() (src/lib/tz/reading-zone-sql.ts); remove a file from the list once it does.",
    ).toEqual([...BASELINE_SQL].sort());
  });

  it("in code are only the known ones", () => {
    const found = matching(CODE_PROFILE_DAY);
    expect(found.length).toBeGreaterThan(0);
    expect(
      found,
      "Place a reading on its own day with readingDayKey() (src/lib/tz/reading-zone.ts); remove a file from the list once it does.",
    ).toEqual([...BASELINE_CODE].sort());
  });

  it("do not include the doctor report or the BP status", () => {
    for (const f of [
      "lib/doctor-report/dense-buckets.ts",
      "lib/insights/blood-pressure-status.ts",
      "lib/analytics/bp-in-target.ts",
      "lib/insights/bucket-series.ts",
    ]) {
      expect([...BASELINE_SQL, ...BASELINE_CODE]).not.toContain(f);
    }
  });
});
