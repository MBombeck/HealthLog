import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.8.0 — explainer-metric key guard.
 *
 * `<MetricExplainer>` builds its i18n lookups from a template literal:
 *
 *   t(`insights.subPage.explainer.${metric}Title`)
 *   t(`insights.subPage.explainer.${metric}Body`)
 *
 * The static `i18n-call-site-coverage.test.ts` only sees literal
 * `t("…")` calls, so a typo in an `explainerMetric=` prop would resolve
 * to a missing key and paint the raw key string into the popover — with
 * no CI signal. This test closes that gap the same way the
 * Health-Score provenance key tests pin their dynamic keys: it walks
 * every `explainerMetric="…"` value used under `src/app/insights/**`
 * (plus the shared `healthkit-metric-page` scaffold) and asserts that
 * both the `<value>Title` and `<value>Body` leaves exist in
 * `messages/en.json`. `i18n-locale-integrity.test.ts` then propagates
 * the EN guarantee across the other five locales.
 */

const ROOT = join(__dirname, "../../../..");
const INSIGHTS_DIR = join(ROOT, "src/app/insights");
const HEALTHKIT_PAGE = join(
  ROOT,
  "src/components/insights/healthkit-metric-page.tsx",
);
const EN_BUNDLE_PATH = join(ROOT, "messages/en.json");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      walk(p, out);
    } else if (name.endsWith(".tsx")) {
      out.push(p);
    }
  }
  return out;
}

interface PropSite {
  value: string;
  file: string;
  line: number;
}

// Match `explainerMetric="someValue"` — a string-literal prop. The
// component contract only accepts a static string, so a dynamic
// `explainerMetric={expr}` would be a different (and unverifiable)
// shape; none exist in the tree and we assert that below.
const LITERAL_PATTERN = /explainerMetric="([a-zA-Z][a-zA-Z0-9]*)"/g;
const DYNAMIC_PATTERN = /explainerMetric=\{/;

function collectSites(): { sites: PropSite[]; dynamic: PropSite[] } {
  const files = [...walk(INSIGHTS_DIR), HEALTHKIT_PAGE];
  const sites: PropSite[] = [];
  const dynamic: PropSite[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // The scaffold declares + forwards the prop; ignore the type
      // declaration + the pass-through (`explainerMetric={explainerMetric}`)
      // — those are not call sites that pin a concrete key.
      if (file === HEALTHKIT_PAGE) continue;
      let m: RegExpExecArray | null;
      LITERAL_PATTERN.lastIndex = 0;
      while ((m = LITERAL_PATTERN.exec(line)) !== null) {
        sites.push({ value: m[1], file: file.slice(ROOT.length + 1), line: i + 1 });
      }
      if (DYNAMIC_PATTERN.test(line)) {
        dynamic.push({ value: line.trim(), file: file.slice(ROOT.length + 1), line: i + 1 });
      }
    }
  }
  return { sites, dynamic };
}

function hasLeaf(obj: unknown, dotted: string): boolean {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return false;
    }
  }
  return typeof cur === "string";
}

describe("insights explainerMetric key coverage", () => {
  const en = JSON.parse(readFileSync(EN_BUNDLE_PATH, "utf8"));
  const { sites, dynamic } = collectSites();

  it("finds explainerMetric props across the insights pages", () => {
    // Guards against the walker silently matching nothing (e.g. a refactor
    // that renames the prop). The category surface carries dozens of pages.
    expect(sites.length).toBeGreaterThan(20);
  });

  it("uses only string-literal explainerMetric props (no dynamic expressions)", () => {
    // A dynamic value can't be statically verified against the bundle, so
    // the contract is literal-only. If this ever fails, either inline the
    // literal or extend this guard to resolve the expression.
    expect(dynamic).toEqual([]);
  });

  it("every explainerMetric value resolves a Title + Body leaf in messages/en.json", () => {
    const missing: string[] = [];
    for (const site of sites) {
      const titleKey = `insights.subPage.explainer.${site.value}Title`;
      const bodyKey = `insights.subPage.explainer.${site.value}Body`;
      if (!hasLeaf(en, titleKey)) {
        missing.push(`  ❌ ${titleKey}  (${site.file}:${site.line})`);
      }
      if (!hasLeaf(en, bodyKey)) {
        missing.push(`  ❌ ${bodyKey}  (${site.file}:${site.line})`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Found ${missing.length} explainerMetric key(s) missing from messages/en.json:\n${missing.join("\n")}`,
      );
    }
  });
});
