/**
 * v1.4.49.3 — call-site i18n coverage guard.
 *
 * Marc surfaced raw `insights.relativeHoursAgo`, `notifications.event
 * MoodReminder`, and `notifications.eventMoodReminderDesc` strings
 * leaking into the UI in v1.4.49. Audit found 28 keys called from real
 * code that never existed in any locale bundle — silent regressions
 * that accumulated across v1.4.41 (notifications matrix), v1.4.44
 * (measurements.loadError), and v1.4.45 (onboarding.welcome.*).
 *
 * This test walks every TypeScript / TSX file under `src/` (excluding
 * tests + generated code), extracts every literal `t("namespace.key")`
 * call, and asserts that each key resolves to a string leaf in
 * `messages/en.json`. JSDoc-block matches and known dynamic patterns
 * are filtered explicitly.
 *
 * The existing `i18n-drift-guard.test.ts` pins specific groups; this
 * test catches drift on every other call site. The
 * `i18n-locale-integrity.test.ts` test then propagates the EN guarantee
 * to every other locale via key-set parity.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "../..");
const SRC = join(ROOT, "src");
const EN_BUNDLE_PATH = join(ROOT, "messages/en.json");

const SKIP_DIRS = new Set([
  "__tests__",
  "node_modules",
  ".next",
  "generated",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const stat = statSync(p);
    if (stat.isDirectory()) {
      walk(p, out);
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      out.push(p);
    }
  }
  return out;
}

const KEY_PATTERN =
  /(?<![a-zA-Z0-9_])t\(\s*["']([a-zA-Z][a-zA-Z0-9_.]+)["']/g;

interface CallSite {
  key: string;
  file: string;
  line: number;
}

function stripCommentLine(line: string): string {
  // Strip line comments: `//` at start (after whitespace) OR inline
  // (preceded by whitespace), but not inside a string literal. Cheap
  // heuristic — find the FIRST `//` that isn't preceded by a quote.
  // The audit cares about real `t(…)` calls, not docstring examples.
  const slashIdx = line.indexOf("//");
  if (slashIdx === -1) return line;
  const before = line.slice(0, slashIdx);
  const dq = (before.match(/"/g) ?? []).length;
  const sq = (before.match(/'/g) ?? []).length;
  if (dq % 2 === 1 || sq % 2 === 1) return line; // inside a string
  return before;
}

function extractKeys(): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      // Skip `/** ... */` JSDoc + `/* ... */` block comments. They
      // routinely carry example `t("ns.key")` strings that are NOT
      // runtime calls (see `src/components/ui/empty-state.tsx`'s
      // docstring as the canonical example).
      if (inBlockComment) {
        const end = line.indexOf("*/");
        if (end === -1) continue;
        line = line.slice(end + 2);
        inBlockComment = false;
      }
      while (true) {
        const start = line.indexOf("/*");
        if (start === -1) break;
        const end = line.indexOf("*/", start + 2);
        if (end === -1) {
          line = line.slice(0, start);
          inBlockComment = true;
          break;
        }
        line = line.slice(0, start) + " ".repeat(end - start + 2) + line.slice(end + 2);
      }
      line = stripCommentLine(line);
      let m: RegExpExecArray | null;
      KEY_PATTERN.lastIndex = 0;
      while ((m = KEY_PATTERN.exec(line)) !== null) {
        sites.push({
          key: m[1],
          file: file.slice(ROOT.length + 1),
          line: i + 1,
        });
      }
    }
  }
  return sites;
}

function resolveLeaf(obj: unknown, dotted: string): string | null {
  const parts = dotted.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return null;
    }
  }
  return typeof cur === "string" ? cur : null;
}

describe("i18n call-site coverage", () => {
  it("every literal t() key has a matching leaf in messages/en.json", () => {
    const en = JSON.parse(readFileSync(EN_BUNDLE_PATH, "utf8"));
    const sites = extractKeys();
    expect(sites.length).toBeGreaterThan(100);

    const missing: CallSite[] = [];
    for (const site of sites) {
      if (resolveLeaf(en, site.key) === null) {
        missing.push(site);
      }
    }

    if (missing.length > 0) {
      const report = missing
        .map((m) => `  ❌ ${m.key}  (${m.file}:${m.line})`)
        .join("\n");
      // v1.4.49.3 — these 28 keys were the gap that reached production.
      // The list below stays empty once the audit passes; future
      // regressions print as a structured punch list so the offender
      // can fix every site in one commit.
      throw new Error(
        `Found ${missing.length} t() call sites referencing keys that are missing from messages/en.json:\n${report}`,
      );
    }
  });
});
