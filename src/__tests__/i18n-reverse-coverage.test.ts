/**
 * v1.18.6 — reverse i18n coverage guard.
 *
 * The forward `i18n-call-site-coverage.test.ts` asserts every `t("ns.key")`
 * call site resolves to a leaf in `messages/en.json`. This test asserts the
 * REVERSE: every leaf in `messages/en.json` is reachable from at least one
 * call site, so orphan keys can't accumulate in the bundle unnoticed.
 *
 * v1.32.36 — the matcher moved to `helpers/i18n-reference.ts` (unit-tested in
 * `helpers/__tests__/i18n-reference.test.ts`) and stopped accepting a bare
 * top-level namespace as a subtree base. See that file's header for the
 * recognised construction patterns and for why the bare-namespace case is a
 * loud failure rather than a silent accept.
 *
 * Dynamic detection is scoped to `t(`…`)` and to namespace-rooted key
 * templates only — NOT to every backtick string — so a cache key or
 * wide-event action name that happens to start with a namespace word doesn't
 * mask a genuinely dead key.
 *
 * If this fails after adding a key, either wire a call site, or — for a key
 * resolved through a runtime value the static scan can't see — add its prefix
 * to `DYNAMIC_ALLOWLIST_PREFIXES` with a one-line note on why.
 *
 * Mutation check: change any `t(`ns.sub.${x}`)` call site to `t(`ns.${x}`)`
 * and the collector-violation assertion goes red; delete a live call site and
 * its keys report as orphans.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { collectReferences, isReferenced } from "./helpers/i18n-reference";

const ROOT = join(__dirname, "../..");
const SRC = join(ROOT, "src");
const EN_BUNDLE_PATH = join(ROOT, "messages/en.json");

/**
 * Pruned on purpose: the generated Prisma client, build output, vendored
 * dependencies, and the suites themselves are not the tree under audit. Note
 * what is NOT pruned — this walk descends into dot-prefixed directories, so
 * `src/app/.well-known` is inside the sweep. `fs.globSync` would drop it.
 */
const SKIP_DIRS = new Set(["__tests__", "node_modules", ".next", "generated"]);

/**
 * Keys resolved through a runtime value no static scan can see. Each entry is
 * a leaf or a namespace prefix that is always live.
 *  - `mood.tag` / `mood.tagCategory`: the catalogue is DB-driven; the label key
 *    is built from a `MoodTag.messageKey` / `MoodTagCategory.messageKey` column,
 *    so the leaf never appears as a string literal in the tree.
 */
const DYNAMIC_ALLOWLIST_PREFIXES = [
  "mood.tag",
  "mood.tagCategory",
  // `mood.dimension`: the five level-A dimensions are a table
  // (`src/lib/mood/dimensions.ts`) whose rows carry their own label and anchor
  // keys, so every leaf is resolved from a value rather than written as a
  // literal. The table is the reason the keys cannot drift apart from the
  // columns they describe.
  "mood.dimension",
  // The whole namespace is a runtime lookup table: the client resolves an
  // error envelope's `meta.errorCode` through it (`localizedApiError`), so no
  // leaf ever appears as a literal at a call site. Adding a key here is only
  // useful together with a server code that emits it.
  "apiErrors",
] as const;

/**
 * Keys a release lands ahead of their call sites, so that the packages built
 * in parallel on the release branch share one bundle and never edit it
 * themselves. Each entry names the package that wires the call sites and the
 * issue it serves.
 *
 * This list expires by construction: the companion test fails as soon as an
 * entry no longer covers a single orphan, so a prefix whose call sites have
 * all landed must be dropped in the same change, and the list is empty again
 * before the release is tagged. It is NOT a place for keys nobody will wire.
 */
const RELEASE_PENDING_PREFIXES: Record<string, string> = {
  "settings.sections.environment.airQuality":
    "v1.42 environment settings, air quality (#615)",
  "environment.fields.apparentMax": "v1.42 air-quality field label (#615)",
  "environment.fields.pm10": "v1.42 air-quality field label (#615)",
  "environment.fields.no2": "v1.42 air-quality field label (#615)",
  "environment.fields.europeanAqi": "v1.42 air-quality field label (#615)",
  "environment.fields.uvIndexMax": "v1.42 air-quality field label (#615)",
  "environment.fields.dustMax": "v1.42 air-quality field label (#615)",
  "settings.appleHealth.freshness":
    "v1.42 per-type HealthKit freshness list (#1173)",
  "insights.workouts.manual.editTitle": "v1.42 manual workout edit (#1162)",
  "insights.workouts.manual.editAction": "v1.42 manual workout edit (#1162)",
  "insights.workouts.manual.updated": "v1.42 manual workout edit (#1162)",
  "vaccinations.custom": "v1.42 user-defined vaccines (#1005)",
  "labs.convertedFrom": "v1.42 lab unit conversion note (#1095)",
};

/**
 * Interpolating strings that LOOK like key templates and are not. Each entry
 * whitelists nothing — the template still contributes no reachable keys — it
 * only says the collector's bare-namespace complaint has been read and
 * answered. Keep the reason checkable in one line of the cited file.
 */
const EXEMPT_TEMPLATES: Record<string, string> = {
  "insights.${scope}-status.${locale}":
    "the per-metric status note name (statusCacheAction), not an i18n key",
  "insights.${scope}.${locale}":
    "auditLog action name for the previous-insight memory read (getPreviousInsightContext), not an i18n key",
  "apiErrors.${errorCode}":
    "the runtime error-code lookup; its namespace is allowlisted above",
};

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

function underPrefix(leaf: string, prefix: string): boolean {
  return leaf === prefix || leaf.startsWith(`${prefix}.`);
}

function isAllowlisted(leaf: string): boolean {
  return (
    DYNAMIC_ALLOWLIST_PREFIXES.some((p) => underPrefix(leaf, p)) ||
    Object.keys(RELEASE_PENDING_PREFIXES).some((p) => underPrefix(leaf, p))
  );
}

function scan() {
  const en = JSON.parse(readFileSync(EN_BUNDLE_PATH, "utf8"));
  const leaves: string[] = [];
  leafPaths(en, "", leaves);

  const allNodes = new Set<string>();
  nodePaths(en, "", allNodes);
  const topNamespaces = new Set<string>(Object.keys(en));

  const allText = walk(SRC)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  return { leaves, ...collectReferences(allText, allNodes, topNamespaces) };
}

describe("i18n reverse coverage", () => {
  it("no key template widens to a bare top-level namespace", () => {
    const all = scan().violations;
    const violations = all.filter((v) => !(v.literal in EXEMPT_TEMPLATES));

    for (const literal of Object.keys(EXEMPT_TEMPLATES)) {
      expect(
        all.map((v) => v.literal),
        `${literal} is exempted but no longer present — drop the entry`,
      ).toContain(literal);
    }

    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ❌ [${v.arm}] ${v.literal}`)
        .join("\n");
      throw new Error(
        `Found ${violations.length} key template(s) whose only static anchor is a bare ` +
          `top-level namespace:\n${report}\n\n` +
          "Such a template marks the whole namespace as reachable and turns this guard " +
          "into a no-op for it. Either build a fully-qualified key at the call site " +
          "(see the measurement-reminder due helpers), or give the template a literal " +
          "suffix so both ends confine it.",
      );
    }
  }, 15_000);

  it("every key in messages/en.json has a call site or is allowlisted", () => {
    const { leaves, ref } = scan();
    expect(leaves.length).toBeGreaterThan(1000);
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

  it("every release-pending prefix still covers an unwired key", () => {
    const { leaves, ref } = scan();
    const stale = Object.keys(RELEASE_PENDING_PREFIXES).filter(
      (prefix) =>
        !leaves.some(
          (leaf) => underPrefix(leaf, prefix) && !isReferenced(leaf, ref),
        ),
    );
    expect(
      stale,
      "These RELEASE_PENDING_PREFIXES entries have all their call sites now — drop them",
    ).toEqual([]);
  }, 15_000);
});
