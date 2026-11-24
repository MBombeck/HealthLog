/**
 * No wide event names a person's reproductive state.
 *
 * Wide events land in the container log, in Loki and, for errors, in
 * GlitchTip. Every request event carries the user id, and on a one-person
 * instance even a cron tick without one is attributable. Reproductive health
 * is the most sensitive class the app holds, so the cycle surfaces annotate
 * sizes and flags only, never the state itself: whether a period is late, the
 * forecast's state, the cycle's regularity, a phase, or the pregnancy that
 * explains a vital-sign shift. Each of those once rode a `meta` field.
 *
 * The sweep covers every file under the cycle routes and the cycle library,
 * and every file that reads the vital-shift context or the pregnancy store.
 * It reads each `annotate(...)` argument with its string literals blanked (so
 * an action name may say "explained") and fails on an expression that
 * carries one of the states. It has floors on files and calls, so a matcher
 * that finds nothing fails instead of passing empty.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** Expressions whose value is a reproductive state. */
const STATE_EXPRESSIONS: readonly RegExp[] = [
  /\bverdict\.state\b/,
  /\bprojectionState\b/,
  /\bregularity\b/,
  /\.phase\b/,
  /\bphase\s*[,}]/,
  /\bvitalShiftContext\b/,
  /\bexplained\b/,
  /\bpregnancy\.(?:state|status)\b/,
  /\bpredictionsPaused\b/,
  /\boverdue(?:Days)?\b/,
];

const READS_STATE =
  /\b(?:vitalShiftContext|pregnancy-store|toCyclePregnancyDTO)\b/;

function blankStrings(source: string): string {
  return source.replace(
    /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
    '""',
  );
}

/** The text between the parentheses of every `annotate(` call. */
function annotateArguments(source: string): string[] {
  const out: string[] = [];
  const opener = /\bannotate\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
    }
    out.push(source.slice(start, i - 1));
  }
  return out;
}

describe("reproductive state in wide events", () => {
  const files = walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/") && !p.includes("__tests__"))
    .filter((p) => !/\.test\.tsx?$/.test(p))
    .filter((p) => {
      if (p.startsWith("app/api/cycle/") || p.startsWith("lib/cycle/")) {
        return true;
      }
      return READS_STATE.test(stripComments(readSourceText(join(SRC, p))));
    });

  const calls = files.flatMap((p) =>
    annotateArguments(
      blankStrings(stripComments(readSourceText(join(SRC, p)))),
    ).map((args) => ({ file: p, args })),
  );

  it("are swept", () => {
    requireFloor("cycle and pregnancy files", files, 20);
    requireFloor("annotate calls in them", calls, 20);
    expect(files).toContain("lib/jobs/measurement-anomaly-check.ts");
  });

  it("carry no state", () => {
    const offenders = calls
      .filter(({ args }) => STATE_EXPRESSIONS.some((re) => re.test(args)))
      .map(({ file, args }) => `${file}: annotate(${args.trim()})`);
    expect(offenders).toEqual([]);
  });
});
