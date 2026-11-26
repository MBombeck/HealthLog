/**
 * Structural guard: a reader of a day's value for a metric that several
 * sources report goes through the one source-priority rule.
 *
 * The rule is the person's ladder (`loadUserSourcePriority`) and the day
 * picker that applies it: `pickCanonicalSourceRows` over rows or per-source
 * groups, `readDayAggregates` with `sourcePriority`, the rank CASE
 * (`buildSourceRankCase`, `canonicalMeasurementsCte`) in SQL, and the rollup
 * collapse. Two devices reporting the same day's resting heart rate are two
 * estimates of one value: their mean is neither, and the newest row is
 * whichever synced last. The today readings averaged across sources (#1514),
 * the sleep reader that took segments for nights (#1565) and the day totals
 * read as hours (#1459) each slipped past a different reader, because every
 * reader chose for itself.
 *
 * Two arms, both frozen both ways (a new unlisted match fails, a listed entry
 * that no longer matches fails):
 *
 *   1. Every `readDayAggregates(...)` call in `src/lib` and `src/app` passes
 *      `sourcePriority`. Without it the helper folds every source's readings
 *      into one day. The one call listed folds the worst reading of any
 *      source on purpose.
 *
 *   2. Every file under `lib/{insights,daily,analytics,dashboard}` that reads
 *      measurement rows itself (Prisma `measurement.findMany` / `findFirst` /
 *      `aggregate` / `groupBy` / `count`, or SQL `FROM measurements`) applies
 *      the rule somewhere in its code, or is listed with the reason its read
 *      is not a day value of a multi-source metric: a presence probe, a
 *      single producer, a reader that keeps the source on every row for its
 *      consumer, a latest-reading lookup of a sparse type.
 *
 * Comments are stripped before matching, the matchers are whitespace-tolerant,
 * and floors fail the guard if either arm stops finding anything. The planted
 * cases run each matcher over an offender. It is a tripwire, not a proof: arm
 * 2 judges a file, not each read inside it, so a second read added to a file
 * that already applies the rule slips it.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

type Reason =
  | "probe"
  | "single-producer"
  | "per-source"
  | "latest-reading"
  | "window"
  | "worst-of-any-source"
  | "open";

/** Arm 1: `readDayAggregates` calls that fold every source, by file. */
const POOLED_DAY_AGGREGATES: Record<
  string,
  { count: number; reason: Reason; why: string }
> = {
  "lib/illness/safety-floor-check.ts": {
    count: 1,
    reason: "worst-of-any-source",
    why: "the sustained-low safety floor takes each day's worst reading of any device, so a dip one device saw is never hidden behind another device's ladder rank",
  },
};

/** Arm 2: files that read measurement rows without the rule, and why. */
const READERS_WITHOUT_RULE: Record<string, { reason: Reason; why: string }> = {
  "lib/insights/feature-cache.ts": {
    reason: "probe",
    why: "the newest updatedAt of any row, a cache fingerprint; no value is read",
  },
  "lib/insights/recovery-empty-read.ts": {
    reason: "probe",
    why: "whether any device recovery row exists, to explain an empty card",
  },
  "lib/dashboard/widgets/unavailable-widgets.ts": {
    reason: "probe",
    why: "whether a type has any row at all, to hide a widget without data",
  },
  "lib/insights/derived/readiness.ts": {
    reason: "single-producer",
    why: "reads RECOVERY_SCORE filtered to source COMPUTED, HealthLog's own readiness rows",
  },
  "lib/daily/morning-load.ts": {
    reason: "per-source",
    why: "device scores of the last nights with their source on every row; the card names each device's own score",
  },
  "lib/insights/recent-readings.ts": {
    reason: "open",
    why: "the status snapshots' newest readings (rows, or hour cells beyond the cap) pool every source, and metric-status and pulse-status fold them into days; the pick has to reach readNewestRowsPerType and readHourCells",
  },
  "lib/insights/derived/bmi.ts": {
    reason: "latest-reading",
    why: "the newest weight in the window as the BMI input",
  },
  "lib/insights/derived/fitness-age.ts": {
    reason: "latest-reading",
    why: "the newest VO2 max reading, a sparse type a device writes every few days",
  },
  "lib/insights/derived/six-minute-walk.ts": {
    reason: "latest-reading",
    why: "the newest six-minute-walk distance and weight, sparse types",
  },
  "lib/insights/derived/vascular-age.ts": {
    reason: "latest-reading",
    why: "the newest vascular-age and pulse-wave-velocity readings, written by one scale",
  },
  "lib/dashboard/summary-reads.ts": {
    reason: "latest-reading",
    why: "the newest reading per type ever, the reading counts, and which local days hold any reading; no day value",
  },
  "lib/dashboard/snapshot.ts": {
    reason: "window",
    why: "the same 30-day glucose panel as lib/analytics/response/glucose.ts, read for the snapshot; its other reads go through the ladder helpers",
  },
  "lib/analytics/response/glucose.ts": {
    reason: "window",
    why: "the 30-day glucose panel over every reading at its own instant, grouped by meal context; spot checks and a sensor are readings of one blood, not two estimates of one day",
  },
  "lib/analytics/resting-pulse-read.ts": {
    reason: "open",
    why: "the low-percentile resting proxy pools every source's PULSE readings per day; the pick belongs in the fold and the closed-block cache key, and the pinned single-statement read in dense-day-readers.test.ts moves with it",
  },
};

/** A file applies the rule when its code names one of these. */
const RULE =
  /\b(?:loadUserSourcePriority|pickCanonicalSourceRows|canonicalMeasurements(?:Cte|From)|collapseRollupRowsBySource|buildSourceRankCase|sourcePriority|priorityJson|rankPerSource|rankUnqualified|resolveCanonicalRecovery|describeRecoveryDivergence|canonicalRowsOfDay|pickCumulativeDaySum|canonicalCumulativeDayTotalsSql)\b/;

/** A measurement read of the file's own. */
const RAW_READ =
  /\.measurement\s*\.\s*(?:findMany|findFirst|aggregate|groupBy|count)\s*\(|\bFROM\s+"?measurements"?\s+[a-z]/g;

/** The argument text of every `readDayAggregates(` call in `code`. */
function readDayAggregatesCalls(code: string): string[] {
  const out: string[] = [];
  const re = /\breadDayAggregates\s*\(/g;
  for (const m of code.matchAll(re)) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      i += 1;
    }
    out.push(code.slice(start, i - 1));
  }
  return out;
}

/** Whether a call's argument text passes the ladder. */
function passesSourcePriority(args: string): boolean {
  return /\bsourcePriority\b/.test(args);
}

const files = walkSourceFiles(SRC, { floor: 1000 }).filter(
  (rel) =>
    (rel.startsWith("lib/") || rel.startsWith("app/")) &&
    !rel.includes("__tests__") &&
    !/\.test\.tsx?$/.test(rel),
);
const code = new Map(
  files.map((rel) => [rel, stripComments(readSourceText(join(SRC, rel)), rel)]),
);

describe("readDayAggregates calls pass the ladder", () => {
  const calls = files.flatMap((rel) =>
    rel === "lib/measurements/day-aggregates.ts"
      ? []
      : readDayAggregatesCalls(code.get(rel)!)
          .filter((a) => a.trim().length > 0)
          .map((args) => ({ file: rel, args })),
  );

  it("finds the calls at all", () => {
    expect(calls.length).toBeGreaterThanOrEqual(8);
  });

  it("folds every source only where it is listed, as often as it is listed", () => {
    const pooled = new Map<string, number>();
    for (const c of calls) {
      if (passesSourcePriority(c.args)) continue;
      pooled.set(c.file, (pooled.get(c.file) ?? 0) + 1);
    }
    expect(Object.fromEntries(pooled)).toEqual(
      Object.fromEntries(
        Object.entries(POOLED_DAY_AGGREGATES).map(([f, a]) => [f, a.count]),
      ),
    );
  });

  it("the matcher catches a planted call without the ladder", () => {
    const planted = `const d = await readDayAggregates({
      userId, type, since,
      timeZone: tz,
    });
    const e = await readDayAggregates({ userId, type, since, timeZone: tz, sourcePriority: p });`;
    const found = readDayAggregatesCalls(planted);
    expect(found).toHaveLength(2);
    expect(found.map(passesSourcePriority)).toEqual([false, true]);
  });
});

describe("day readers in insights, daily, analytics and dashboard apply the rule", () => {
  const scoped = files.filter((rel) =>
    /^lib\/(?:insights|daily|analytics|dashboard)\//.test(rel),
  );
  const readers = scoped.filter((rel) => {
    RAW_READ.lastIndex = 0;
    return RAW_READ.test(code.get(rel)!);
  });

  it("walks the folders and finds their readers", () => {
    expect(scoped.length).toBeGreaterThanOrEqual(250);
    expect(readers.length).toBeGreaterThanOrEqual(30);
  });

  it("every reader applies the rule or is listed with its reason", () => {
    const without = readers.filter((rel) => !RULE.test(code.get(rel)!));
    expect(without.sort()).toEqual(Object.keys(READERS_WITHOUT_RULE).sort());
  });

  it("gives every listed reader a reason", () => {
    for (const [file, { why }] of Object.entries({
      ...READERS_WITHOUT_RULE,
      ...POOLED_DAY_AGGREGATES,
    })) {
      expect(why.length, file).toBeGreaterThan(30);
    }
  });

  it("the matchers catch a planted reader that averages across sources", () => {
    const planted = stripComments(
      `// loadUserSourcePriority is mentioned only in a comment
      const agg = await prisma.measurement
        .aggregate({ where: { userId, type: "HEART_RATE_VARIABILITY" }, _avg: { value: true } });
      const rows = await prisma.$queryRaw\`SELECT AVG(value) FROM measurements m WHERE m."type" = 'PULSE'\`;`,
      "planted.ts",
    );
    RAW_READ.lastIndex = 0;
    expect([...planted.matchAll(RAW_READ)]).toHaveLength(2);
    expect(RULE.test(planted)).toBe(false);
  });
});
