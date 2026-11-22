/**
 * Structural guard: no reader cuts a dense measurement stream short with a
 * row cap and then folds what is left.
 *
 * #1429: the intraday pulse chart read a day's heart rate with `take: 6000`
 * and folded the rows into ten-minute buckets in JavaScript. A watch syncing
 * through Google Health writes about 35 000 rows a day, so the cap ran out
 * a little after four in the morning and the chart ended there; the workout
 * page's curve did the same over a long session. Nothing on the page said
 * the day was cut. The existing bounded-read guard
 * (`dense-measurement-read-guard.test.ts`) counts a `take` as bounded, which
 * is true of memory and false of the answer: a capped read of a dense stream
 * is a silently partial one.
 *
 * The rule: a `measurement.findMany` with a `take`, anywhere in `src/lib` or
 * `src/app`, whose `where` is not pinned to sparse literal types (types no
 * device streams), carries a `// dense-take: <reason>` comment inside the
 * call or on the three lines above it, saying why the cap cannot cut the
 * answer: a page of a cursor walk, a "newest N" the caller widens by time,
 * a batch of a job that loops until empty. A reader that needs the whole of
 * a dense window folds it in SQL (`dense-bucket-read.ts`) instead.
 *
 * The "plants" cases run the matcher over a capped dense read (caught), the
 * same read annotated (passes) and a sparse literal read (passes); the floor
 * fails the guard if the matcher stops finding capped reads at all. It is a
 * tripwire, not a proof: a cap passed in through a variable `args` object is
 * invisible to it.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  SRC,
  closeOf,
  lineOf,
  measurementReadSourceFiles,
  sparseLiteral,
  typeExprOf,
} from "./helpers/measurement-read-scan";
import { readSourceText } from "./helpers/source-files";

const SCOPE = ["lib/", "app/"];
const ANNOTATION = /\/\/\s*dense-take:\s*(\S.{9,})/;

interface CappedRead {
  file: string;
  line: number;
  typeExpr: string;
  annotated: boolean;
}

/** Every `measurement.findMany` with a `take` in `src`. */
function cappedFindManyReads(file: string, src: string): CappedRead[] {
  const out: CappedRead[] = [];
  const re = /\.measurement\s*\.\s*findMany\s*\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const end = closeOf(src, m.index + m[0].length - 1);
    const call = src.slice(m.index, end);
    if (!/\btake\s*:/.test(call)) continue;
    const line = lineOf(src, m.index);
    const lines = src.split("\n");
    const before = lines.slice(Math.max(0, line - 4), line - 1).join("\n");
    out.push({
      file,
      line,
      typeExpr: typeExprOf(call),
      annotated: ANNOTATION.test(call) || ANNOTATION.test(before),
    });
  }
  return out;
}

function scan(): CappedRead[] {
  const out: CappedRead[] = [];
  for (const file of measurementReadSourceFiles()) {
    if (!SCOPE.some((d) => file.startsWith(d))) continue;
    const src = readSourceText(join(SRC, file));
    out.push(...cappedFindManyReads(file, src));
  }
  return out;
}

describe("dense measurement reads are never silently capped (#1429)", () => {
  const reads = scan();

  it("finds the capped reads it is meant to police", () => {
    // Pinned below the count on 2026-11-22 (17), so a matcher that stops
    // matching fails here instead of reporting a clean tree.
    expect(reads.length).toBeGreaterThanOrEqual(15);
  });

  it("every capped read of a dense or unnamed type says why the cap cannot cut its answer", () => {
    const offenders = reads
      .filter((r) => !sparseLiteral(r.typeExpr))
      .filter((r) => !r.annotated)
      .map((r) => `${r.file}:${r.line} type ${r.typeExpr}`);
    expect(offenders).toEqual([]);
  });

  it("the readers fixed for #1429 fold in SQL rather than capping rows", () => {
    for (const file of [
      "lib/analytics/intraday-pulse-io.ts",
      "lib/workouts/hr-series.ts",
      "lib/measurements/intraday-cumulative-profile.ts",
      "lib/insights/strain-score.ts",
      "lib/insights/stress-score.ts",
      "lib/illness/safety-floor-check.ts",
      "lib/insights/derived/readiness.ts",
      "lib/insights/derived/coincident-deviation.ts",
    ]) {
      const offenders = reads.filter(
        (r) => r.file === file && !sparseLiteral(r.typeExpr),
      );
      expect(offenders, file).toEqual([]);
    }
  });

  it("plants: a capped read of a dense type is caught, an annotated or sparse one is not", () => {
    const planted = `
      const rows = await prisma.measurement.findMany({
        where: { userId, type: "PULSE", measuredAt: { gte: dayStart } },
        orderBy: { measuredAt: "asc" },
        take: 6000,
        select: { value: true, measuredAt: true },
      });`;
    const [caught] = cappedFindManyReads("lib/planted.ts", planted);
    expect(caught.typeExpr).toBe('"PULSE"');
    expect(sparseLiteral(caught.typeExpr)).toBe(false);
    expect(caught.annotated).toBe(false);

    const annotated = cappedFindManyReads(
      "lib/planted.ts",
      planted.replace(
        "take: 6000,",
        "// dense-take: a page of a cursor walk that loops to the end\n take: 6000,",
      ),
    );
    expect(annotated[0].annotated).toBe(true);
    const above = cappedFindManyReads(
      "lib/planted.ts",
      "// dense-take: a page of a cursor walk that loops to the end\n" +
        planted.trimStart(),
    );
    expect(above[0].annotated).toBe(true);
    // A reason has to say something.
    expect(
      cappedFindManyReads(
        "lib/planted.ts",
        planted.replace("take: 6000,", "// dense-take: ok\n take: 6000,"),
      )[0].annotated,
    ).toBe(false);

    const sparse = cappedFindManyReads(
      "lib/planted.ts",
      planted.replace('"PULSE"', '"WEIGHT"'),
    );
    expect(sparseLiteral(sparse[0].typeExpr)).toBe(true);
    // A type held in a variable could be anything, so it needs the reason.
    const unnamed = cappedFindManyReads(
      "lib/planted.ts",
      planted.replace('type: "PULSE"', "type"),
    );
    expect(sparseLiteral(unnamed[0].typeExpr)).toBe(false);
    // No take, nothing to police here.
    expect(
      cappedFindManyReads("lib/planted.ts", planted.replace("take: 6000,", "")),
    ).toEqual([]);
  });
});
