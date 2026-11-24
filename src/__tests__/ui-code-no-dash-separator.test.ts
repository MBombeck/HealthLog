import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The code-side twin of `i18n-no-dot-separator.test.ts`: a string the code
 * composes itself (an aria-label `${action} — ${name}`, a meta line
 * `parts.join(" · ")`, a JSX run `{name} · {email}`) carries no spaced middle
 * dot, em dash or en dash either. The bundles say "Move up: Ramipril" and
 * "No connection: changes can't be saved", so a line put together in a
 * component joins its facts with a comma, a colon or a real phrase too.
 *
 * Two matchers, both on one line outside comments:
 *
 * - a string or template literal holding a space, U+00B7 / U+2014 / U+2013,
 *   a space (`" · "`, `` `${a} — ${b}` ``);
 * - JSX text that opens with the glyph (`· {email}`, `— {nextLine}`,
 *   `—{" "}`), the shape a separator takes between two elements.
 *
 * A range written in code ("10–12", `${from}–${to}`) and a dot inside a unit
 * ("mL/(kg·min)") have no spaces around the glyph and are not matched. A
 * template literal broken across lines escapes the one-line matcher, which is
 * this guard's known limit.
 */

const ROOT = join(__dirname, "..");
const DIRS = ["components", "app", "lib/doctor-report-pdf"].map((d) =>
  join(ROOT, d),
);
const LITERAL = /(["'`])[^"'`]* [—–·] [^"'`]*\1/;
const JSX_TEXT = /(^|>)\s*[—–·](\s|\{)/;

/**
 * File -> why a separator glyph is right there. The privacy notice is legal
 * prose: its definition lists set each term against its explanation with a
 * dash, the way the published notice reads, and it is not composed UI copy.
 */
const ALLOWED: Record<string, string> = {
  "app/privacy/page.tsx": "legal prose, term — definition lists",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "__tests__") continue;
      walk(path, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/** Lines of code with line comments, block comments and JSX comments blanked. */
function codeLines(source: string): string[] {
  let inBlock = false;
  return source.split("\n").map((line) => {
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) return "";
      inBlock = false;
      line = line.slice(end + 2);
    }
    if (/^\s*\/\//.test(line)) return "";
    line = line.replace(/\/\*.*?\*\//g, "");
    const open = line.indexOf("/*");
    if (open !== -1) {
      inBlock = true;
      line = line.slice(0, open);
    }
    return line.replace(/\s\/\/\s.*$/, "");
  });
}

function offendersIn(source: string): number[] {
  const hits: number[] = [];
  codeLines(source).forEach((code, i) => {
    if (LITERAL.test(code) || JSX_TEXT.test(code)) hits.push(i + 1);
  });
  return hits;
}

describe("composed UI strings carry no spaced dot or dash", () => {
  const files = DIRS.flatMap((d) => walk(d));

  it("walks the component, app and report trees", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("has no ' · ', ' — ' or ' – ' separator outside the allowlist", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file);
      if (rel in ALLOWED) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      for (const n of offendersIn(lines.join("\n"))) {
        offenders.push(`${rel}:${n}: ${lines[n - 1].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps every allowlisted file in the walk and still needing it", () => {
    for (const rel of Object.keys(ALLOWED)) {
      const source = readFileSync(join(ROOT, rel), "utf8");
      expect(offendersIn(source).length).toBeGreaterThan(0);
    }
  });

  it("catches the patterns it is written for", () => {
    expect(offendersIn("aria-label={`${a} — ${b}`}")).toEqual([1]);
    expect(offendersIn('title: "About – HealthLog"')).toEqual([1]);
    expect(offendersIn('parts.join(" · ")')).toEqual([1]);
    expect(offendersIn('{" "}\n  · {entry.user.email}')).toEqual([2]);
    expect(offendersIn("<span>— {nextLine}</span>")).toEqual([1]);
    expect(offendersIn('      —{" "}')).toEqual([1]);
  });

  it("leaves ranges, units and comments alone", () => {
    expect(offendersIn("`${from}–${to}`")).toEqual([]);
    expect(offendersIn('unit: "mL/(kg·min)"')).toEqual([]);
    expect(offendersIn("// a — b")).toEqual([]);
    expect(offendersIn("{/* one\n   — two */}")).toEqual([]);
  });
});
