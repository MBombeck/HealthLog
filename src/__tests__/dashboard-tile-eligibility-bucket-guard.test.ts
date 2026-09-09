/**
 * Structural guard — a dashboard tile may not be gated on a closed enum
 * whose column is nullable.
 *
 * The Blood Glucose tile decided whether to paint by filtering the four
 * `GlucoseContext` members against a per-context summary record and asking
 * whether any of them held readings. Every named context is a legal value of
 * the column, so the list read as exhaustive — but `glucose_context` is
 * nullable, and a meter synced through Apple Health writes no meal-time
 * metadata at all. An account with one hundred percent untagged readings
 * therefore matched no bucket, and the tile was omitted with the module on,
 * the layout toggle on, and a reading from today. Nothing warned: every
 * behavioural test in the suite seeded a tagged reading, so the missing arm
 * was invisible from the outside (#943).
 *
 * What the guard asserts: wherever a dashboard tile surface derives presence
 * from a list of enum buckets, the list must carry a null / unknown arm — or
 * the call site must write down why it cannot. It matches on the list
 * EXPRESSION, following one hop through a named constant, because the fix for
 * this class is always the same: the untagged bucket joins the list the
 * eligibility loop already walks.
 *
 * Its limits, written down so a later reader does not over-trust it: it sees
 * presence tests spelled with `count`, and a bucket list that is either an
 * inline literal or a single named constant. An eligibility gate that counted
 * rows some other way, or assembled its bucket list at runtime, would slip
 * past. The `detect()` self-controls below exist so a refactor that silently
 * stops matching anything fails here rather than going quiet.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A bucket list that carries one of these tokens has an arm for rows the
 * enum cannot name. Matched against the list expression's source text, so a
 * shared constant (`GLUCOSE_CONTEXT_BUCKETS = [...NAMED, UNSPECIFIED]`)
 * satisfies it through its own name.
 */
const UNTAGGED_ARM = /UNSPECIFIED|UNKNOWN|UNTAGGED|OTHER|NONE/;

/** The written-reason escape hatch, with a non-empty reason after it. */
const WRITTEN_REASON = /tile-eligibility-exempt:\s*\S/;

/** Dashboard surfaces that decide whether a tile paints. */
const SURFACES = [
  "src/app/page-client.tsx",
  ...listSourceFiles("src/components/dashboard"),
  ...listSourceFiles("src/lib/dashboard"),
];

function listSourceFiles(dir: string): string[] {
  const abs = join(process.cwd(), dir);
  return readdirSync(abs)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => join(dir, name))
    .filter((rel) => statSync(join(process.cwd(), rel)).isFile());
}

interface Finding {
  /** The bucket-list expression as written at the eligibility site. */
  list: string;
  /** 1-based line of the eligibility site. */
  line: number;
}

/**
 * Iteration over a bucket list: `for (const x of LIST)` or
 * `LIST.filter(…)` / `.some(…)`. The list is either an inline array literal
 * or an identifier.
 */
const ITERATION =
  /(?:for\s*\(\s*(?:const|let)\s+[^)]*?\bof\s+(\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*\))|(?:(\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*\.\s*(?:filter|some|flatMap)\s*\()/g;

/** A presence test — "does this bucket hold any readings". */
const PRESENCE = /\bcount\b/;

/** How far past the iteration head a presence test still belongs to it. */
const BODY_WINDOW = 500;

/**
 * Every eligibility site in `source` whose bucket list has no untagged arm
 * and no written reason. `resolve` supplies the initializer text of a named
 * constant so the guard can follow one hop out of the file.
 */
export function detect(
  source: string,
  resolve: (name: string) => string | null,
): Finding[] {
  const findings: Finding[] = [];
  ITERATION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ITERATION.exec(source)) !== null) {
    const list = match[1] ?? match[2];
    if (!list) continue;
    const body = source.slice(match.index, match.index + BODY_WINDOW);
    if (!PRESENCE.test(body)) continue;
    // Only enum-shaped lists are in scope: an inline literal of UPPER_SNAKE
    // members, or an UPPER_SNAKE constant name.
    const inline = list.startsWith("[");
    const members = inline ? list.match(/"[A-Z][A-Z0-9_]*"/g) : null;
    if (inline && (members?.length ?? 0) < 2) continue;
    if (!inline && !/^[A-Z][A-Z0-9_]*$/.test(list)) continue;
    const expression = inline ? list : (resolve(list) ?? list);
    if (UNTAGGED_ARM.test(expression)) continue;
    const before = source.slice(Math.max(0, match.index - 400), match.index);
    if (WRITTEN_REASON.test(before)) continue;
    findings.push({
      list,
      line: source.slice(0, match.index).split("\n").length,
    });
  }
  return findings;
}

/** Initializer text of `export const NAME = …` / `const NAME = …` in `src/`. */
function resolveConstant(name: string): string | null {
  for (const file of CONSTANT_SOURCES) {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    const declaration = new RegExp(
      `(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*(\\[[\\s\\S]*?\\])`,
    ).exec(source);
    if (declaration) return declaration[1];
  }
  return null;
}

/** Files a dashboard surface may import a bucket list from. */
const CONSTANT_SOURCES = ["src/lib/glucose.ts", ...SURFACES];

describe("detect() — the matcher itself", () => {
  it("flags the shape that shipped: four enum members, no null arm", () => {
    const shipped = `
      const contexts = ["FASTING", "POSTPRANDIAL", "RANDOM", "BEDTIME"];
      const present = ["FASTING", "POSTPRANDIAL", "RANDOM", "BEDTIME"].filter(
        (ctx) => (byContext[ctx]?.count ?? 0) > 0,
      );
    `;
    const findings = detect(shipped, () => null);
    expect(findings).toHaveLength(1);
    expect(findings[0].list).toContain("FASTING");
  });

  it("accepts a list that carries an untagged arm", () => {
    const fixed = `
      for (const bucket of GLUCOSE_CONTEXT_BUCKETS) {
        const summary = byContext?.[bucket];
        if (!summary || summary.count <= 0) continue;
      }
    `;
    const resolve = () => '["FASTING", "BEDTIME", GLUCOSE_CONTEXT_UNSPECIFIED]';
    expect(detect(fixed, resolve)).toEqual([]);
    // …and rejects the same site when the constant has no arm, so the pass
    // above is the arm's doing and not the resolver's.
    expect(detect(fixed, () => '["FASTING", "BEDTIME"]')).toHaveLength(1);
  });

  it("accepts a written reason", () => {
    const exempt = `
      // tile-eligibility-exempt: sleep stages are never null on this path.
      for (const stage of ["DEEP", "REM"]) {
        if (byStage[stage].count > 0) return true;
      }
    `;
    expect(detect(exempt, () => null)).toEqual([]);
  });

  it("ignores lists that are not presence tests", () => {
    const unrelated = `
      const labels = ["WEIGHT", "PULSE"].map((type) => LABELS[type]);
    `;
    expect(detect(unrelated, () => null)).toEqual([]);
  });
});

describe("dashboard tile eligibility", () => {
  it("scans the surfaces it claims to scan", () => {
    // An empty match set must fail rather than read as clean: the guard is
    // worthless the day its matchers stop finding the real call sites.
    expect(SURFACES.length).toBeGreaterThan(5);
    const sited = SURFACES.filter((file) =>
      PRESENCE.test(readFileSync(join(process.cwd(), file), "utf8")),
    );
    expect(sited.length).toBeGreaterThan(0);
  });

  it("computes no tile's eligibility from an enum without a null arm", () => {
    const offenders: string[] = [];
    for (const file of SURFACES) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      for (const finding of detect(source, resolveConstant)) {
        offenders.push(`${file}:${finding.line} — ${finding.list}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
