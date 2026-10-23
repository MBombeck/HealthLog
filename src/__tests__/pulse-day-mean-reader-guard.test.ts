/**
 * Structural guard: every reader that averages pulse goes through the
 * day-mean helper.
 *
 * A watch samples pulse every few minutes at rest and every few seconds in a
 * workout, so a plain mean over pulse readings lets one workout hour outweigh
 * the rest of the day. A day of pulse is the mean of its hours' means and a
 * window the mean of its days (`src/lib/measurements/day-statistic.ts`), and
 * `src/lib/measurements/day-mean.ts` is the one place that computes it. The
 * statistic first shipped in the chart and the rollup tier while some twenty
 * other readers kept the plain mean, so the dashboard's year delta compared
 * one statistic against another.
 *
 * Two matchers, both frozen both ways (a new unlisted match fails, a listed
 * file that no longer matches fails):
 *
 *   1. Database means over measurement values: `AVG(value)`, the per-day
 *      folds `SUM(total) / SUM(cnt)` and `SUM(count * mean)`, and Prisma's
 *      `_avg: { value }`. A file that holds one imports the shared statistic
 *      (it averages pulse among other types and the helper's CASE keeps the
 *      others on the plain mean).
 *
 *   2. In-memory means in a file that names pulse: a left fold divided by a
 *      length, `avgInWindow(`, `summarize(`, `bucketWeekly(`,
 *      `buildDailyValueRows(` or `applyPayloadBudget(`. A file that holds one
 *      imports the shared statistic, hands the type to a fold that does, or
 *      is listed with the reason it never averages pulse readings.
 *
 * A third matcher has no list: since the pulse day-mean method (v1.43) an
 * hour weighs by the method, so no day may still be folded from its hours'
 * means with every hour weighing one (`AVG(hour_mean)`, a sum over hours
 * divided by their number). The weight lives in the helper alone.
 *
 * Comments are stripped before matching, the matchers are whitespace-tolerant,
 * and the floors fail the guard if either matcher stops finding anything. The
 * planted cases run each matcher over an offender; dropping the type from the
 * mood correlation's fold, or a new file with a plain `AVG(value)` over pulse,
 * fails the two list checks. It is a tripwire, not a proof: a mean written
 * some other way slips it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments, walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** The shared statistic: the helper, or the type set it is keyed on. */
const HELPER_IMPORT =
  /from\s+["'](?:@\/lib\/measurements\/|\.\/)day-(?:mean|statistic)["']/;

/**
 * Database means over a measurement value: SQL `AVG(value)`, the per-day folds
 * `SUM(total) / SUM(cnt)` and `SUM(count * mean)`, and Prisma's
 * `_avg: { value: ... }`.
 */
const SQL_MEAN =
  /_avg\s*:\s*\{\s*value\s*:|\bAVG\s*\(\s*(?:[a-z_]+\s*\.\s*)?"?value"?\s*\)|\bSUM\s*\(\s*(?:[a-z_]+\s*\.\s*)?"?total"?\s*\)\s*\/\s*SUM\s*\(\s*(?:[a-z_]+\s*\.\s*)?"?cnt"?\s*\)|\bSUM\s*\(\s*"?count"?\s*\*\s*"?mean"?\s*\)/gi;

/** In-memory means and the folds that make them, counted in files that name pulse. */
const TS_MEAN =
  /\.reduce\(\s*\(\s*\w+\s*,\s*\w+\s*\)\s*=>\s*\w+\s*\+\s*[\w.]+\s*,\s*0\s*\)\s*\/\s*[\w.]+\.length|\bavgInWindow\s*\(|\bsummarize\s*\(|\bbucketWeekly\s*\(|\bbuildDailyValueRows\s*\(|\bapplyPayloadBudget\s*\(/g;

// The stored type, or the series route's `kind === "pulse"` (its readers name
// the wire kind, not the type).
const NAMES_PULSE = /\bPULSE\b|===\s*"pulse"/;

/**
 * A day folded from its hours' means with every hour weighing one: SQL
 * `AVG(hour_mean)` and an in-memory sum over hours divided by their number.
 * Since v1.43 an hour weighs by the pulse day-mean method, which only the
 * helper applies (`hourWeightSql`, `combineHourCells`), so none may remain.
 */
const UNWEIGHTED_HOURS =
  /\bAVG\s*\(\s*(?:[a-z_]+\s*\.\s*)?"?hour_mean"?\s*\)|\/\s*hours\.(?:length|size)\b/g;

type Entry =
  /** Averages pulse and imports the shared statistic. */
  | { helper: true }
  /** Averages pulse through a fold that imports it, and hands that fold the type. */
  | { via: string; passes: RegExp }
  /** Never averages pulse readings; the reason is the claim. */
  | { exempt: string };

const HELPER: Entry = { helper: true };

/** Files with a database mean over values. */
const SQL_READERS: Record<string, Entry> = {
  "lib/ai/coach/tools/availability.ts": HELPER,
  "lib/analytics/summaries-slice.ts": HELPER,
  "lib/doctor-report/dense-buckets.ts": HELPER,
  "lib/insights/comprehensive-aggregator.ts": HELPER,
  "lib/insights/comprehensive-generate.ts": HELPER,
  // The dry run's hour means, weighed by both methods through the helper.
  "lib/jobs/pulse-day-mean.ts": HELPER,
  "lib/measurements/daily-series-read.ts": HELPER,
  // The series route's long-window dense read.
  "lib/measurements/dense-series-read.ts": HELPER,
  "lib/rollups/measurement-rollups.ts": HELPER,
  "lib/rollups/tiered-context.ts": HELPER,
  "lib/insights/correlation-channel-series.ts": {
    exempt:
      "the one SQL mean is the room-climate hour mean, over INDOOR_CO2 / INDOOR_TEMPERATURE / INDOOR_HUMIDITY only; pulse reaches the correlation channels through `dayValueRows` and the rollup compose",
  },
};

/** Files that name pulse and hold an in-memory mean or a mean-making fold. */
const TS_READERS: Record<string, Entry> = {
  "lib/measurements/series/read-raw.ts": HELPER,
  "lib/doctor-report/collect.ts": HELPER,
  "lib/doctor-report-pdf/clinical-summary.ts": HELPER,
  "lib/insights/comprehensive-generate.ts": HELPER,
  "lib/insights/features.ts": HELPER,
  "lib/insights/mood-status.ts": {
    via: "lib/insights/bucket-series.ts",
    passes: /\{\s*now\s*,\s*tz\s*,\s*type\s*\}/,
  },
  "lib/insights/pulse-status.ts": {
    via: "lib/insights/bucket-series.ts",
    passes:
      /applyPayloadBudget\(\s*pulsePoints\s*,\s*\{[^}]*type\s*:\s*"PULSE"/,
  },
  "lib/insights/signals-of-day.ts": {
    via: "lib/insights/feature-window.ts",
    passes: /byType\(\s*"PULSE"\s*\)[\s\S]{0,80}type\s*:\s*"PULSE"/,
  },
  "lib/ai/coach/snapshot-blocks/core-metrics-block.ts": {
    via: "lib/ai/coach/snapshot-series.ts",
    passes: /buildDailyValueRows\([^)]*"PULSE"/,
  },
  "components/day/day-values-model.ts": {
    exempt:
      "means several readings of a type the day route sends one by one (weight, blood pressure, glucose); pulse arrives as one server-side day value (`dayValueShape` in lib/day/values.ts)",
  },
  "components/charts/health-chart/series-math.ts": {
    exempt:
      "a rolling average over the points the chart draws: display smoothing, not a stated figure",
  },
  "lib/analytics/correlations-fast-path.ts": {
    exempt: "mood mean; pulse enters as the resting series, never a day mean",
  },
  "lib/dashboard/summary/cards.ts": {
    exempt:
      "places a card's seven-day sparkline mean against its band for the trend verdict; each sparkline point is already one rollup day value, so the mean weighs every day once",
  },
  "lib/dashboard/snapshot.ts": {
    exempt: "summarises water-intake days and glucose contexts",
  },
  "lib/gamification/expansion-metrics.ts": {
    exempt: "means of mood day means; pulse is only counted",
  },
  "lib/illness/correlation.ts": { exempt: "mean of episode durations" },
  "lib/insights/mood-aggregates.ts": { exempt: "the mood series only" },
  "lib/insights/narrative/period-narrative.ts": {
    exempt: "means of day-keyed series, already one value per day",
  },
  "lib/medications/efficacy/build-efficacy.ts": {
    exempt: "means of the day-mean series (readDayMeanSeries)",
  },
  "lib/targets/build-response.ts": {
    exempt:
      "pulse is excluded from the 30-day averages; the resting proxy stands in",
  },
  "lib/targets/vitals-builder.ts": {
    exempt:
      "trend halves over the other vitals and the resting proxy's day points",
  },
  "app/api/insights/cards/route.ts": {
    exempt: "pulse is summarised from day means (readDayMeanSeries)",
  },
  "lib/insights/comprehensive-overview/build.ts": {
    exempt: "summarises the mood series only",
  },
};

function scan(): {
  sql: Map<string, number>;
  ts: Map<string, number>;
  unweighted: string[];
} {
  const files = walkSourceFiles(SRC, { floor: 1500 }).filter(
    (f) =>
      !f.startsWith("generated/") &&
      !f.includes("__tests__/") &&
      !/\.test\.tsx?$/.test(f) &&
      f !== "lib/measurements/day-mean.ts",
  );
  const sql = new Map<string, number>();
  const ts = new Map<string, number>();
  const unweighted: string[] = [];
  for (const f of files) {
    const text = stripComments(readFileSync(join(SRC, f), "utf8"));
    if (UNWEIGHTED_HOURS.test(text)) unweighted.push(f);
    UNWEIGHTED_HOURS.lastIndex = 0;
    const s = text.match(SQL_MEAN)?.length ?? 0;
    if (s > 0) sql.set(f, s);
    if (NAMES_PULSE.test(text)) {
      const t = text.match(TS_MEAN)?.length ?? 0;
      if (t > 0) ts.set(f, t);
    }
  }
  return { sql, ts, unweighted };
}

const { sql, ts, unweighted } = scan();
const source = (f: string) => readFileSync(join(SRC, f), "utf8");

function check(found: Map<string, number>, listed: Record<string, Entry>) {
  const unlisted = [...found.keys()].filter((f) => !(f in listed)).sort();
  const stale = Object.keys(listed)
    .filter((f) => !found.has(f))
    .sort();
  const broken: string[] = [];
  for (const [f, entry] of Object.entries(listed)) {
    if (!found.has(f)) continue;
    if ("helper" in entry && !HELPER_IMPORT.test(source(f))) {
      broken.push(`${f}: does not import the day-mean helper`);
    }
    if ("via" in entry) {
      if (!HELPER_IMPORT.test(source(entry.via))) {
        broken.push(`${f}: ${entry.via} does not import the day-mean helper`);
      }
      if (!entry.passes.test(source(f))) {
        broken.push(`${f}: no longer hands the type to ${entry.via}`);
      }
    }
  }
  return { unlisted, stale, broken };
}

describe("pulse day-mean reader guard", () => {
  it("finds the SQL means it is meant to find", () => {
    expect(sql.size).toBeGreaterThanOrEqual(9);
    expect([...sql.values()].reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(
      15,
    );
  });

  it("finds the in-memory pulse means it is meant to find", () => {
    expect(ts.size).toBeGreaterThanOrEqual(20);
  });

  it("every SQL mean over values is listed, and every listed pulse reader uses the helper", () => {
    expect(check(sql, SQL_READERS)).toEqual({
      unlisted: [],
      stale: [],
      broken: [],
    });
  });

  it("every in-memory pulse mean is listed, and every listed reader uses the helper", () => {
    expect(check(ts, TS_READERS)).toEqual({
      unlisted: [],
      stale: [],
      broken: [],
    });
  });

  it("leaves no day folded from equally weighted hours", () => {
    expect(unweighted).toEqual([]);
  });

  it("catches a planted unweighted hour fold", () => {
    expect(`AVG(h.hour_mean) AS day_mean`.match(UNWEIGHTED_HOURS)).toHaveLength(
      1,
    );
    expect(
      `hours.reduce((s, h) => s + h.total / h.count, 0) / hours.length`.match(
        UNWEIGHTED_HOURS,
      ),
    ).toHaveLength(1);
    expect(`SUM(h.hour_mean * w) / SUM(w)`.match(UNWEIGHTED_HOURS)).toBeNull();
  });

  it("catches a planted plain AVG and a planted fold", () => {
    expect(
      `SELECT AVG( m."value" ) FROM measurements m`.match(SQL_MEAN),
    ).toHaveLength(1);
    expect(`(SUM(c.total) /  SUM(c.cnt))`.match(SQL_MEAN)).toHaveLength(1);
    expect(`SUM("count" * "mean")`.match(SQL_MEAN)).toHaveLength(1);
    expect(`aggregate({ _avg: { value: true } })`.match(SQL_MEAN)).toHaveLength(
      1,
    );
    expect(stripComments("// AVG(value) in prose").match(SQL_MEAN)).toBeNull();
    const planted = `const pulse = byType("PULSE");
      const avg = pulse.reduce((s, r) => s + r.value, 0) / pulse.length;`;
    expect(NAMES_PULSE.test(planted)).toBe(true);
    expect(planted.match(TS_MEAN)).toHaveLength(1);
  });
});
