/**
 * Structural guard: no reader materialises a dense measurement stream.
 *
 * #1023: a single account syncing heart rate from a watch took the worker
 * down within half an hour. The status-card read was bounded in time
 * (`measuredAt >= now − 91 days`) but not in rows, and a stream sampled every
 * minute or faster turns 91 days into six or seven figures of objects. The
 * read also ran into the statement timeout. The cure was to fold per day in
 * SQL (`readDayAggregates`, `readLiveBuckets`), so the reader's size tracks
 * the number of days, not the sampling rate.
 *
 * The same class kept turning up outside the directories this guard first
 * walked: the targets page read a year of glucose and a month of heart rate,
 * the cycle insights read a year of every outcome channel, the per-kind series
 * read heart-rate variability and blood oxygen raw for ten years, all from
 * `app/api` or a helper beside it. So the guard now covers the request
 * handlers, import, export, the targets and the doctor report as well, and
 * the raw SQL reads of `measurements` anywhere in the tree.
 *
 * Two checks.
 *
 *   1. `measurement.findMany` without a `take`, in the scoped directories,
 *      must be bounded by its `where`: a type named as a literal (or a list of
 *      literals) none of which a device streams, or a key list (`id`,
 *      `externalId` or `measuredAt` `in: [...]`, or an exact `measuredAt`).
 *      Anything else is listed below with the reason it stays bounded.
 *
 *   2. A raw `$queryRaw` / `$queryRawUnsafe` whose statement reads from
 *      `measurements` must fold: `GROUP BY`, `DISTINCT`, `LIMIT`, or a select
 *      list of aggregates only. A statement that returns rows is listed below
 *      with its reason. A statement held in a variable is invisible to the
 *      matcher; that is the check's known blind spot.
 *
 * Both lists are frozen both ways: a new unlisted read fails, and an entry
 * whose read is gone fails too. The floors below fail the guard if a matcher
 * stops finding reads at all, and the "plants" cases run each matcher over a
 * planted offender, which is the mutation proof kept in the suite: the
 * planted findMany of `BLOOD_GLUCOSE` over a year and the planted raw SELECT of
 * every pulse row are both caught. It is a tripwire, not a proof.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";
import {
  CUMULATIVE_HK_TYPES,
  HIGH_FREQUENCY_MEAN_TYPES,
} from "@/lib/measurements/apple-health-mapping";

const SRC = join(process.cwd(), "src");

const SCOPED_DIRS = [
  "lib/insights/",
  "lib/jobs/",
  "lib/rollups/",
  "lib/ai/",
  "lib/analytics/",
  "lib/dashboard/",
  "lib/daily/",
  // Widened in v1.39.7: the request handlers and the helpers they lean on.
  "app/api/",
  "lib/import",
  "lib/export",
  "lib/targets/",
  "lib/doctor-report",
];

/** Types a device writes at sampling rate rather than a few times a day. */
const DENSE_TYPES: ReadonlySet<string> = new Set([
  "PULSE",
  "BLOOD_GLUCOSE",
  "HEART_RATE_VARIABILITY",
  "OXYGEN_SATURATION",
  ...CUMULATIVE_HK_TYPES,
  ...HIGH_FREQUENCY_MEAN_TYPES,
]);

/**
 * Untaken reads whose `where` neither names sparse literal types nor a key
 * list, keyed `<file>::<type expression>`, with why each stays bounded.
 */
const ALLOWED: Record<string, string> = {
  "lib/insights/comprehensive-generate.ts::(shorthand)":
    'Only reached for SLEEP_DURATION (guarded by `type === "SLEEP_DURATION"`); a few stage rows per night.',
  "lib/insights/derived/vascular-age.ts::VASCULAR_AGE_TYPE":
    "A constant for a type written at most a few times a day.",
  "lib/insights/derived/fitness-age.ts::VO2_MAX_TYPE":
    "A constant for VO2 max, written at most daily.",
  "lib/insights/derived/six-minute-walk.ts::SIX_MINUTE_WALK_TYPE":
    "A constant for six-minute-walk distance, written at most daily.",
  "lib/insights/derived/wellness-scores.ts::measurementType":
    "Daily computed / provider scores (recovery, strain, readiness), one row per day.",
  "lib/jobs/step-consolidation-repair.ts::STEP_TYPE":
    "Repair job over one user's step rows for a bounded day range; runs once per repair, not per status refresh.",
  'lib/ai/coach/snapshot.ts::"BLOOD_GLUCOSE" as never':
    "Clinical CGM metrics (time in range, SD / CV, J-index, LBGI / HBGI, reading span) are functions of the individual readings, which a per-day aggregate cannot reproduce. 30 days at a sensor's fixed rate (at most one a minute) stays below 45 000 rows.",
  'lib/dashboard/snapshot.ts::"BLOOD_GLUCOSE"':
    "Same 30-day clinical glucose panel as the coach snapshot (per-reading metrics), grouped by meal context.",
  "lib/analytics/score/reader.ts::{ in: types":
    "Health-score inputs: steps (drained to one row per day nightly), sleep, waist, weight, blood pressure, fasting glucose only.",
  'app/api/analytics/route.ts::"BLOOD_GLUCOSE"':
    "The 30-day per-context glucose summary, the same window and bound as the dashboard and coach glucose panels: at a sensor's fixed rate, below 45 000 rows.",
  "app/api/measurements/batch/route.ts::p.row.type as MeasurementType":
    "Cross-source merge probe: one ±tolerance window around each posted reading's instant, so the rows found are bounded by the batch size.",
  "app/api/measurements/route.ts::(shorthand)":
    "Cross-source merge probe for one posted sleep segment: SLEEP_DURATION in a ±tolerance window around its end.",
  "lib/targets/build-response.ts::{ in: recentTypes":
    "Thirty days of weight, blood pressure, resting heart rate, body fat and steps (drained to one row per day). PULSE is filtered out of `recentTypes` and folds in SQL.",
  "lib/doctor-report/collect.ts::{ notIn: rawExcluded":
    "The report window's sparse types. Pulse, heart-rate variability and blood oxygen over 10 000 readings or any window over 90 days, and glucose over 90 days, are in `rawExcluded` and read as day buckets; glucose inside 90 days stays raw for the clinical panel (per-reading metrics), below 26 000 rows at a sensor's rate.",
};

/**
 * Raw statements that read rows of `measurements` without folding them, keyed
 * `<file>::<ordinal among this file's unfolded statements>`, with why each
 * stays bounded.
 */
const ALLOWED_SQL: Record<string, string> = {
  "lib/analytics/bp-in-target-fast-path.ts::1":
    "Canonical-source blood pressure, one type over 365 days: a cuff, a few readings a day. The in-target pairing needs the individual readings.",
  "lib/insights/comprehensive-aggregator.ts::1":
    "Canonical-source blood pressure and weight over 90 days: sparse types, a few rows a day.",
  "lib/measurements/reconcile-external-measurement.ts::1":
    "Row locks (`FOR UPDATE`) on an id list the caller already read; returns those ids only.",
  "lib/jobs/pr-detection.ts::1":
    "Selects account ids; `measurements` is read inside `EXISTS`, one row per account at most.",
  "lib/rollups/measurement-coverage.ts::1":
    "Selects from `unnest` of the caller's type list; `measurements` is read inside `EXISTS`, one row per type at most.",
};

interface UntakenRead {
  file: string;
  line: number;
  typeExpr: string;
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

/** Index just past the bracket that closes the one at `open`. */
function closeOf(src: string, open: number): number {
  const pair: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const want = pair[src[open]];
  let depth = 1;
  let i = open + 1;
  while (depth > 0 && i < src.length) {
    if (src[i] === src[open]) depth += 1;
    else if (src[i] === want) depth -= 1;
    i += 1;
  }
  return i;
}

/** The `where: { … }` object of a call, or null when `where` is a variable. */
function whereObject(call: string): string | null {
  const m = /\bwhere\s*:\s*\{/.exec(call);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  return call.slice(open, closeOf(call, open));
}

/** The type expression a `where` object constrains on. */
function typeExprOf(call: string): string {
  const where = whereObject(call);
  if (where === null) {
    return /\bwhere\s*[,}]/.test(call) ? "(where variable)" : "(none)";
  }
  const typed = /\btype\s*:\s*([^,\n}]+)/.exec(where);
  if (typed) return typed[1].trim();
  return /\btype\s*[,}\n]/.test(where) ? "(shorthand)" : "(none)";
}

/** A `where` that pins rows by key rather than by a window. */
function keyBounded(call: string): boolean {
  const where = whereObject(call) ?? "";
  return (
    /\b(?:id|externalId|measuredAt)\s*:\s*\{\s*in\s*:/.test(where) ||
    /\bmeasuredAt\s*:\s*(?![\s{])/.test(where)
  );
}

function sparseLiteral(typeExpr: string): boolean {
  const lit = /^"([A-Z_0-9]+)"/.exec(typeExpr);
  if (lit) return !DENSE_TYPES.has(lit[1]);
  const list = /^\{\s*in\s*:\s*\[([^\]]*)/.exec(typeExpr);
  if (!list) return false;
  const items = list[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    items.length > 0 &&
    items.every((item) => {
      const m = /^"([A-Z_0-9]+)"$/.exec(item);
      return m !== null && !DENSE_TYPES.has(m[1]);
    })
  );
}

/** Every untaken `measurement.findMany` in `src`, with its type expression. */
function untakenFindManyReads(
  file: string,
  src: string,
): { all: number; untaken: UntakenRead[] } {
  let all = 0;
  const untaken: UntakenRead[] = [];
  // Whitespace-tolerant: a call split across lines still matches.
  const re = /\.measurement\s*\.\s*findMany\s*\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    all += 1;
    const call = src.slice(m.index, closeOf(src, m.index + m[0].length - 1));
    if (/\btake\b/.test(call)) continue;
    if (keyBounded(call)) continue;
    // A type expression can itself contain a full bracket (`{ in: [...] }`);
    // the regex above stops at the first `,` / `}` / newline, which is the
    // stable key the allowlist uses.
    untaken.push({
      file,
      line: lineOf(src, m.index),
      typeExpr: typeExprOf(call),
    });
  }
  return { all, untaken };
}

/** The statement text of the raw call starting at `at`, or null if opaque. */
function statementAt(src: string, at: number): string | null {
  let i = at;
  // Skip a type argument: `$queryRaw<Array<{ … }>>`.
  if (src[i] === "<") {
    let depth = 1;
    i += 1;
    while (depth > 0 && i < src.length) {
      if (src[i] === "<") depth += 1;
      else if (src[i] === ">") depth -= 1;
      i += 1;
    }
  }
  while (/\s/.test(src[i] ?? "")) i += 1;
  if (src[i] === "`") {
    // Tagged template: up to the matching backtick, skipping `${ … }`.
    let j = i + 1;
    while (j < src.length && src[j] !== "`") {
      if (src[j] === "$" && src[j + 1] === "{") j = closeOf(src, j + 1);
      else j += 1;
    }
    return src.slice(i, j + 1);
  }
  if (src[i] === "(") return src.slice(i, closeOf(src, i));
  return null;
}

const READS_MEASUREMENTS =
  /\bFROM\s+"?measurements"?(?![_\w])|canonicalMeasurementsFrom\s*\(/i;
const FOLDS =
  /GROUP\s+BY|\bDISTINCT\b|\bLIMIT\b|^[\s`(]*(?:Prisma\.sql`)?\s*SELECT\s+(?:COUNT|SUM|AVG|MIN|MAX|STDDEV_POP)\s*\(/i;

interface RawRead {
  file: string;
  line: number;
  folds: boolean;
}

/** Every raw statement in `src` that reads from `measurements`. */
function rawMeasurementReads(file: string, src: string): RawRead[] {
  const out: RawRead[] = [];
  const re = /\.\$queryRaw(?:Unsafe)?\b/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const statement = statementAt(src, m.index + m[0].length);
    if (statement === null || !READS_MEASUREMENTS.test(statement)) continue;
    out.push({
      file,
      line: lineOf(src, m.index),
      folds: FOLDS.test(statement),
    });
  }
  return out;
}

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function scan() {
  let all = 0;
  const untaken: UntakenRead[] = [];
  const raw: RawRead[] = [];
  for (const file of sourceFiles()) {
    const src = readFileSync(join(SRC, file), "utf8");
    raw.push(...rawMeasurementReads(file, src));
    if (!SCOPED_DIRS.some((d) => file.startsWith(d))) continue;
    const reads = untakenFindManyReads(file, src);
    all += reads.all;
    untaken.push(...reads.untaken);
  }
  return { all, untaken, raw };
}

/** `<file>::<n>` for the n-th unfolded statement of each file. */
function unfoldedKeys(raw: readonly RawRead[]): Map<string, RawRead> {
  const keys = new Map<string, RawRead>();
  const perFile = new Map<string, number>();
  for (const read of raw) {
    if (read.folds) continue;
    const n = (perFile.get(read.file) ?? 0) + 1;
    perFile.set(read.file, n);
    keys.set(`${read.file}::${n}`, read);
  }
  return keys;
}

describe("dense measurement reads stay bounded (#1023)", () => {
  const { all, untaken, raw } = scan();

  it("finds the reads it is meant to police", () => {
    // Guard against a matcher that silently matches nothing.
    // Pinned below the counts on 2026-10-01 (82 / 45 / 37 / 33).
    expect(all).toBeGreaterThanOrEqual(75);
    expect(untaken.length).toBeGreaterThanOrEqual(40);
    expect(raw.length).toBeGreaterThanOrEqual(33);
    expect(raw.filter((r) => r.folds).length).toBeGreaterThanOrEqual(30);
  });

  it("every untaken read names sparse literal types, a key list, or is listed with its reason", () => {
    const offenders = untaken
      .filter((r) => !sparseLiteral(r.typeExpr))
      .filter((r) => !(`${r.file}::${r.typeExpr}` in ALLOWED))
      .map((r) => `${r.file}:${r.line} type ${r.typeExpr}`);
    expect(offenders).toEqual([]);
  });

  it("every listed exception still exists", () => {
    const present = new Set(untaken.map((r) => `${r.file}::${r.typeExpr}`));
    expect(Object.keys(ALLOWED).filter((k) => !present.has(k))).toEqual([]);
  });

  it("every raw read of measurements folds or is listed with its reason", () => {
    const keys = unfoldedKeys(raw);
    const offenders = [...keys]
      .filter(([key]) => !(key in ALLOWED_SQL))
      .map(([key, read]) => `${key} (line ${read.line})`);
    expect(offenders).toEqual([]);
    expect(Object.keys(ALLOWED_SQL).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("the readers fixed for #1023 fold in SQL rather than reading rows", () => {
    for (const file of [
      "lib/insights/graded-series.ts",
      "lib/rollups/tiered-context.ts",
      "lib/jobs/coach-plan-review.ts",
      "lib/measurements/daily-series-read.ts",
      "lib/insights/derived/baseline.ts",
      "lib/targets/glucose-read.ts",
    ]) {
      const src = readFileSync(join(SRC, file), "utf8");
      expect(src, file).not.toMatch(/\.measurement\s*\.\s*findMany\s*\(/);
    }
  });

  it("plants: an unbounded findMany of a dense type is caught", () => {
    const planted = `
      const rows = await prisma.measurement.findMany({
        where: { userId, type: "BLOOD_GLUCOSE", measuredAt: { gte: oneYearAgo } },
        select: { value: true, measuredAt: true },
      });`;
    const { all: n, untaken: found } = untakenFindManyReads(
      "app/api/planted/route.ts",
      planted,
    );
    expect(n).toBe(1);
    expect(found.map((r) => r.typeExpr)).toEqual(['"BLOOD_GLUCOSE"']);
    expect(sparseLiteral(found[0].typeExpr)).toBe(false);
    // The same read with a key list or a take is bounded.
    expect(
      untakenFindManyReads(
        "x.ts",
        planted.replace("measuredAt: { gte", "id: { in: ids }, x: { gte"),
      ).untaken,
    ).toEqual([]);
    expect(
      untakenFindManyReads(
        "x.ts",
        planted.replace("select:", "take: 10, select:"),
      ).untaken,
    ).toEqual([]);
    // A list of sparse literals passes; one dense member does not.
    expect(sparseLiteral('{ in: ["WEIGHT", "BODY_FAT"]')).toBe(true);
    expect(sparseLiteral('{ in: ["WEIGHT", "PULSE"]')).toBe(false);
  });

  it("plants: a raw SELECT of rows from measurements is caught", () => {
    const planted =
      "const rows = await prisma.$queryRaw<Array<{ v: number }>>`\n" +
      '  SELECT m."value" FROM measurements m\n' +
      '  WHERE m."user_id" = ${userId} AND m."type" = \'PULSE\'\n' +
      "`;";
    const reads = rawMeasurementReads("lib/planted.ts", planted);
    expect(reads).toHaveLength(1);
    expect(reads[0].folds).toBe(false);
    const folded = rawMeasurementReads(
      "lib/planted.ts",
      planted.replace("WHERE", "WHERE true GROUP BY 1 HAVING true AND"),
    );
    expect(folded[0].folds).toBe(true);
    const aggregate = rawMeasurementReads(
      "lib/planted.ts",
      planted.replace('SELECT m."value"', 'SELECT COUNT(*), AVG(m."value")'),
    );
    expect(aggregate[0].folds).toBe(true);
  });
});
