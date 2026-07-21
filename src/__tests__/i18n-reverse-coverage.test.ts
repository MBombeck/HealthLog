/**
 * v1.18.6 — reverse i18n coverage guard.
 *
 * The forward `i18n-call-site-coverage.test.ts` asserts every `t("ns.key")`
 * call site resolves to a leaf in `messages/en.json`. This test asserts the
 * REVERSE: every leaf in `messages/en.json` is reachable from at least one
 * call site, so orphan keys can't accumulate in the bundle unnoticed.
 *
 * "Reachable" recognises the key-construction patterns the codebase actually
 * uses:
 *   - a literal `t("a.b.c")` (hyphens allowed — admin section slugs use them);
 *   - a `t("a.b")` that returns a subtree, covering every descendant leaf;
 *   - a dynamic key built inside a `t(`…`)` template, e.g. the per-metric
 *     `${i18nPrefix}.title` insight pages, `cycle.calendar.flow${LEVEL}`, or
 *     the `medications.site${Suffix}` label keys — captured by the static
 *     leading-literal prefix and/or trailing-literal suffix of the template;
 *   - a key string assembled outside the call (`return `medications.site${s}``
 *     in `describeInjectionSite`) and passed to `t()`, recognised when the
 *     template's leading literal is rooted at a real top-level namespace;
 *   - an explicit allowlist for keys resolved through a DB column.
 *
 * Dynamic detection is scoped to `t(`…`)` and to namespace-rooted key
 * templates only — NOT to every backtick string — so a cache key or
 * wide-event action name that happens to start with a namespace word doesn't
 * mask a genuinely dead key.
 *
 * If this fails after adding a key, either wire a call site, or — for a key
 * resolved through a runtime value the static scan can't see — add its prefix
 * to `DYNAMIC_ALLOWLIST_PREFIXES` with a one-line note on why.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "../..");
const SRC = join(ROOT, "src");
const EN_BUNDLE_PATH = join(ROOT, "messages/en.json");

const SKIP_DIRS = new Set(["__tests__", "node_modules", ".next", "generated"]);

/**
 * Keys resolved through a runtime value no static scan can see. Each entry is
 * a leaf or a namespace prefix that is always live.
 *  - `mood.tag` / `mood.tagCategory`: the catalogue is DB-driven; the label key
 *    is built from a `MoodTag.messageKey` / `MoodTagCategory.messageKey` column,
 *    so the leaf never appears as a string literal in the tree.
 */
const DYNAMIC_ALLOWLIST_PREFIXES = ["mood.tag", "mood.tagCategory"] as const;

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

function leafPaths(obj: unknown, prefix: string, out: string[]): void {
  if (!obj || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      leafPaths(v, path, out);
    } else {
      out.push(path);
    }
  }
}

function nodePaths(obj: unknown, prefix: string, out: Set<string>): void {
  if (!obj || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.add(path);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      nodePaths(v, path, out);
    }
  }
}

interface Reference {
  /** Literal `t("…")` keys. */
  literalKeys: Set<string>;
  /** Dotted bases (`base.${…}` / a full string-literal node path): cover the subtree. */
  dottedBases: Set<string>;
  /** Dot-less concat prefixes (`medications.site${…}`): cover any leaf that string-starts with them. */
  concatPrefixes: Set<string>;
  /** Trailing static suffixes of a template key (`${…}.title`). */
  dynamicSuffixes: Set<string>;
}

function collectReferences(
  allNodes: Set<string>,
  topNamespaces: Set<string>,
): Reference {
  const allText = walk(SRC)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  const literalKeys = new Set<string>();
  const literalKeyRe =
    /(?<![a-zA-Z0-9_])t\(\s*["']([a-zA-Z][a-zA-Z0-9_.-]+)["']/g;
  for (const m of allText.matchAll(literalKeyRe)) literalKeys.add(m[1]);

  // Plural-tier composition: `tCount("dashboard.staleHintWeeks", n)` and the
  // underlying `pluralKey("…", n, locale)` both resolve to `<base>One` /
  // `<base>Few` / `<base>Other` at runtime, so the base literal accounts for
  // exactly those three leaves and no others. Kept as an explicit tier list
  // rather than a prefix match so a stray sibling key under the same base still
  // reports as an orphan.
  const pluralKeyRe =
    /(?:pluralKey|tCount)\(\s*["']([a-zA-Z][a-zA-Z0-9_.-]+)["']/g;
  for (const m of allText.matchAll(pluralKeyRe)) {
    for (const tier of ["One", "Few", "Other"])
      literalKeys.add(`${m[1]}${tier}`);
  }

  const dottedBases = new Set<string>();
  const concatPrefixes = new Set<string>();
  const dynamicSuffixes = new Set<string>();

  const ingestTemplate = (content: string) => {
    const open = content.indexOf("${");
    if (open > 0) {
      const lit = content.slice(0, open);
      if (lit.includes(".")) {
        if (lit.endsWith(".")) dottedBases.add(lit.slice(0, -1));
        else concatPrefixes.add(lit);
      }
    }
    const close = content.lastIndexOf("}");
    if (close !== -1 && close < content.length - 1) {
      const tail = content.slice(close + 1).replace(/^\./, "");
      if (tail) dynamicSuffixes.add(tail);
    }
  };

  // Templates passed directly to t(`…`).
  const tTemplateRe = /(?<![a-zA-Z0-9_])t\(\s*`([^`]*)`/g;
  for (const m of allText.matchAll(tTemplateRe)) ingestTemplate(m[1]);

  // Key strings assembled outside the call and handed to t() (the
  // `describeInjectionSite` pattern). Recognised only when the template's
  // leading literal is rooted at a real top-level i18n namespace, so a cache
  // key / action name that interpolates can't mask a dead key.
  const assignTemplateRe = /`([a-zA-Z][a-zA-Z0-9_.-]*)\$\{/g;
  for (const m of allText.matchAll(assignTemplateRe)) {
    const lit = m[1];
    if (!lit.includes(".")) continue;
    if (!topNamespaces.has(lit.split(".")[0])) continue;
    if (lit.endsWith(".")) dottedBases.add(lit.slice(0, -1));
    else concatPrefixes.add(lit);
  }

  // String-concatenation prefixes: `"notifications.event" + eventType…`
  // builds keys like `notifications.eventMoodReminder`. Recognised only when
  // the literal is rooted at a real top-level namespace.
  const plusConcatRe = /["']([a-zA-Z][a-zA-Z0-9_.]*)["']\s*\+/g;
  for (const m of allText.matchAll(plusConcatRe)) {
    const lit = m[1];
    if (!lit.includes(".")) continue;
    if (!topNamespaces.has(lit.split(".")[0])) continue;
    if (lit.endsWith(".")) dottedBases.add(lit.slice(0, -1));
    else concatPrefixes.add(lit);
  }

  // Full string-literal node paths (covers map values returned to t()).
  const litPathRe = /["']([a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)+)["']/g;
  for (const m of allText.matchAll(litPathRe)) {
    if (allNodes.has(m[1])) dottedBases.add(m[1]);
  }

  return { literalKeys, dottedBases, concatPrefixes, dynamicSuffixes };
}

function isReferenced(leaf: string, ref: Reference): boolean {
  if (ref.literalKeys.has(leaf)) return true;
  for (const ck of ref.literalKeys) {
    if (leaf.startsWith(`${ck}.`)) return true;
  }
  for (const base of ref.dottedBases) {
    if (leaf === base || leaf.startsWith(`${base}.`)) return true;
  }
  for (const pre of ref.concatPrefixes) {
    if (leaf.startsWith(pre)) return true;
  }
  for (const suffix of ref.dynamicSuffixes) {
    if (leaf !== suffix && !leaf.endsWith(`.${suffix}`)) continue;
    const base = leaf.slice(0, leaf.length - suffix.length).replace(/\.$/, "");
    for (const b of ref.dottedBases) {
      if (base === b || base.startsWith(`${b}.`) || b.startsWith(`${base}.`)) {
        return true;
      }
    }
    for (const ck of ref.literalKeys) {
      if (
        base === ck ||
        base.startsWith(`${ck}.`) ||
        ck.startsWith(`${base}.`)
      ) {
        return true;
      }
    }
    for (const pre of ref.concatPrefixes) {
      if (base.startsWith(pre)) return true;
    }
  }
  return false;
}

function isAllowlisted(leaf: string): boolean {
  return DYNAMIC_ALLOWLIST_PREFIXES.some(
    (p) => leaf === p || leaf.startsWith(`${p}.`),
  );
}

describe("i18n reverse coverage", () => {
  it("every key in messages/en.json has a call site or is allowlisted", () => {
    const en = JSON.parse(readFileSync(EN_BUNDLE_PATH, "utf8"));
    const leaves: string[] = [];
    leafPaths(en, "", leaves);
    expect(leaves.length).toBeGreaterThan(1000);

    const allNodes = new Set<string>();
    nodePaths(en, "", allNodes);
    const topNamespaces = new Set<string>(Object.keys(en));
    const ref = collectReferences(allNodes, topNamespaces);
    // Sanity: the static scan must see the bulk of the bundle.
    expect(ref.literalKeys.size).toBeGreaterThan(1000);

    const orphans = leaves.filter(
      (leaf) => !isAllowlisted(leaf) && !isReferenced(leaf, ref),
    );

    if (orphans.length > 0) {
      const report = orphans.map((k) => `  ❌ ${k}`).join("\n");
      throw new Error(
        `Found ${orphans.length} key(s) in messages/en.json with no call site:\n${report}\n\n` +
          "Wire a call site, or add a DB-driven prefix to DYNAMIC_ALLOWLIST_PREFIXES.",
      );
    }
  }, 15_000);
});
