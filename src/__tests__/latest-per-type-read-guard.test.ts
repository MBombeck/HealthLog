/**
 * Structural guard: the latest reading per measurement type has two readers,
 * and the summaries slice one cache cell.
 *
 * Postgres 16 has no skip scan, so `DISTINCT ON (type)` over `measurements`
 * sorts every row it can see to keep one per type. Five copies of that shape
 * sat in the dashboard, analytics, insights and targets reads; each one now
 * goes through `readLatestCanonical` (the ladder-canonical reading of the
 * latest day) or `readLatestEver` (the latest raw reading), both driven from
 * the type list with one index probe per type.
 *
 * The summaries slice was computed inside three cells (the tile-strip route,
 * the thick analytics body, the dashboard snapshot). `readSummariesSlice` is
 * the one cell; `computeSummariesSlice` is its builder and is called nowhere
 * else in production code.
 *
 * The Prisma spelling of the same question is `measurement.groupBy` by type
 * with nothing but `_max` (or nothing at all, a presence probe) and no time
 * window: it groups every live row the account has to answer a question one
 * index probe per type answers. Grouped reads that count, sum or average, or
 * that are bounded in time, ask something else and pass.
 *
 * Comments are stripped before matching, and the planted cases prove each
 * matcher finds what it claims to.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

/** The shared comment strip, plus SQL line comments inside template strings. */
function stripCode(text: string): string {
  return stripComments(text).replace(/^\s*--.*$/gm, "");
}

const SRC = join(process.cwd(), "src");

/** `DISTINCT ON (type)` or `DISTINCT ON (m."type")`, the type alone. */
const LATEST_PER_TYPE = /DISTINCT\s+ON\s*\(\s*(?:\w+\s*\.\s*)?"?type"?\s*\)/i;

const SLICE_BUILDER_CALL = /\bcomputeSummariesSlice\s*\(/;

/** Grouped presence reads that ask something the per-type probe cannot. */
const GROUPBY_ALLOWED: Record<string, string> = {
  "lib/measurements/import-apple-health-export-writer.ts":
    "Which types hold a MANUAL reading: a source-filtered presence the per-type probe does not take.",
  "lib/jobs/insight-pregenerate.ts":
    "Which types exist at all, with no type list to drive a per-type probe; a nightly job, not a request path.",
};

/** Each `measurement.groupBy(...)` argument that asks only latest or presence. */
function latestOnlyGroupBys(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/\.measurement\s*\.\s*groupBy\s*\(/g)) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (depth > 0 && i < code.length) {
      if (code[i] === "(") depth += 1;
      else if (code[i] === ")") depth -= 1;
      i += 1;
    }
    const arg = code.slice(m.index + m[0].length, i - 1);
    const byType = /by:\s*\[\s*"type"\s*\]/.test(arg);
    const asksMore = /\b_(?:count|sum|avg|min)\b/.test(arg);
    const windowed = /\bmeasuredAt\s*:/.test(
      arg.replace(/_max:\s*\{[^}]*\}/, ""),
    );
    if (byType && !asksMore && !windowed) out.push(arg.replace(/\s+/g, " "));
  }
  return out;
}

function productionFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 }).filter(
    (file) =>
      !file.startsWith("generated/") &&
      !file.includes("__tests__/") &&
      !/\.test\.tsx?$/.test(file),
  );
}

describe("latest-per-type reads", () => {
  it("the matchers find their shapes", () => {
    expect(
      LATEST_PER_TYPE.test(`SELECT DISTINCT ON (m."type") m."value"`),
    ).toBe(true);
    expect(LATEST_PER_TYPE.test(`SELECT DISTINCT ON ("type") value`)).toBe(
      true,
    );
    expect(
      LATEST_PER_TYPE.test(`SELECT DISTINCT ON ("type", "bucket_start")`),
    ).toBe(false);
    expect(
      SLICE_BUILDER_CALL.test(`await computeSummariesSlice(user.id)`),
    ).toBe(true);
  });

  it("no production read keeps one row per type with DISTINCT ON", () => {
    const offenders = productionFiles().filter((file) =>
      LATEST_PER_TYPE.test(stripCode(readSourceText(join(SRC, file)))),
    );
    expect(offenders).toEqual([]);
  });

  it("the groupBy matcher finds a latest-only or presence-only read", () => {
    expect(
      latestOnlyGroupBys(
        `prisma.measurement.groupBy({ by: ["type"], where: { userId }, _max: { measuredAt: true } })`,
      ),
    ).toHaveLength(1);
    expect(
      latestOnlyGroupBys(
        `prisma.measurement\n .groupBy({ by: ["type"], where: { userId, deletedAt: null } })`,
      ),
    ).toHaveLength(1);
    expect(
      latestOnlyGroupBys(
        `prisma.measurement.groupBy({ by: ["type"], where: { userId }, _count: { _all: true }, _max: { measuredAt: true } })`,
      ),
    ).toEqual([]);
    expect(
      latestOnlyGroupBys(
        `prisma.measurement.groupBy({ by: ["type"], where: { userId, measuredAt: { gte: since } }, _max: { measuredAt: true } })`,
      ),
    ).toEqual([]);
  });

  it("no production read groups every row for the latest per type", () => {
    const files = productionFiles();
    const grouped = files.filter((file) =>
      /\.measurement\s*\.\s*groupBy\s*\(/.test(readSourceText(join(SRC, file))),
    );
    // The tree groups measurements in several places; finding none means
    // the walk read the wrong tree. Six since the dense-stream counts (MCP
    // discovery, doctor report, feature cache, status gate) moved to capped
    // descents and the rollup tier.
    expect(grouped.length).toBeGreaterThanOrEqual(6);
    const offenders = files
      .filter((file) => !(file in GROUPBY_ALLOWED))
      .flatMap((file) =>
        latestOnlyGroupBys(stripComments(readSourceText(join(SRC, file)))).map(
          (arg) => `${file}: ${arg.slice(0, 100)}`,
        ),
      );
    expect(offenders).toEqual([]);
  });

  it("the summaries slice is built only behind its cache cell", () => {
    const callers = productionFiles().filter((file) =>
      SLICE_BUILDER_CALL.test(stripCode(readSourceText(join(SRC, file)))),
    );
    expect(callers).toEqual(["lib/analytics/summaries-slice.ts"]);
  });
});
