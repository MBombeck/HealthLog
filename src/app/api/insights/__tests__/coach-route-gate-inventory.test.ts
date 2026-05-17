import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * v1.4.38 W-C M6 — Coach API route gate inventory.
 *
 * The web surfaces are protected by the `flags.coach` short-circuit in
 * every Coach-bearing component (see
 * `src/lib/feature-flags/__tests__/coach-cascade.test.tsx`). The
 * server-side mirror is `requireAssistantSurface("coach")` in every
 * Coach-only route handler. Without a discovery test, a future
 * contributor who lands a new `/api/insights/<foo>/route.ts` whose body
 * touches the Coach stack would have to remember the gate by hand — a
 * silent miss leaks the surface even when the operator turned the
 * Coach matrix off.
 *
 * The walk below scans every `route.ts` under `src/app/api/insights/`
 * and groups each handler into one of three buckets:
 *
 *   1. Coach-gated   — file imports + invokes
 *                      `requireAssistantSurface("coach")`.
 *   2. Other-gated   — file invokes `requireAssistantSurface()` with a
 *                      different surface (`insightStatus`,
 *                      `correlations`, `briefing`, `healthScoreExplainer`).
 *   3. Allowlisted   — non-Coach Insights routes that don't gate on
 *                      the matrix at all (provider chain, settings,
 *                      targets, glp1-timeline, feedback). Allowlist
 *                      lives alongside the test for easy review.
 *
 * Anything that doesn't fit one of the three buckets is an orphan and
 * fails the test by name so the fix is one search-and-add.
 */

const NON_COACH_GATED_ROUTES: ReadonlyArray<string> = [
  // Non-Coach assistant surfaces — gated on a sibling sub-flag.
  "src/app/api/insights/blood-pressure-status/route.ts",
  "src/app/api/insights/bmi-status/route.ts",
  "src/app/api/insights/cards/route.ts",
  "src/app/api/insights/correlations/route.ts",
  "src/app/api/insights/medication-compliance-status/route.ts",
  "src/app/api/insights/mood-status/route.ts",
  "src/app/api/insights/pulse-status/route.ts",
  "src/app/api/insights/weight-status/route.ts",
];

const NOT_COACH_OWNED_ROUTES: ReadonlyArray<string> = [
  // Settings + chain inventory — surface-agnostic infra reads. The
  // settings UI itself is server-rendered and the chain page hides
  // when no provider is configured; neither one carries assistant
  // prose. Disabling Coach must not break these reads — the user can
  // still inspect and reconfigure the chain that gets re-enabled.
  "src/app/api/insights/provider-chain/route.ts",
  "src/app/api/insights/settings/route.ts",
  // Read-only data feeds — `/targets` is a non-assistant Zielwerte
  // page driven by classifications, not LLM prose; the GLP-1 timeline
  // is the same data the medication page paints whether the assistant
  // is on or off. Recommendation feedback (`/feedback`) records a
  // thumbs-up/-down on a NON-Coach recommendation row that was
  // produced before the operator flipped the flag; gating it would
  // mean the operator's mid-flight toggle erases the user's
  // ability to dispose of stale recommendations.
  "src/app/api/insights/feedback/route.ts",
  "src/app/api/insights/glp1-timeline/route.ts",
  "src/app/api/insights/targets/route.ts",
];

const COACH_GATE_NEEDLE = 'requireAssistantSurface("coach")';
const ANY_GATE_NEEDLE = "requireAssistantSurface(";

/**
 * Return true when the file contains the needle on a line that is NOT
 * a pure comment. A documentation comment that mentions the gate
 * (`// requireAssistantSurface("coach") protects this surface`) must
 * not satisfy the gate-presence check — otherwise a contributor who
 * deletes the actual call but leaves the docstring would slip through.
 */
function fileHasGateCall(text: string, needle: string): boolean {
  return text.split("\n").some((line) => {
    if (!line.includes(needle)) return false;
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) return false;
    if (trimmed.startsWith("*")) return false;
    return true;
  });
}

/**
 * Walk every `route.ts` under `src/app/api/insights/` (including
 * dynamic segments under `[id]`). Returns POSIX-style paths relative
 * to the repo root.
 */
function findInsightsRouteFiles(): string[] {
  // __dirname here is `src/app/api/insights/__tests__/`, so the
  // insights root is one directory up.
  const insightsRoot = resolve(__dirname, "..");
  const repoRoot = resolve(insightsRoot, "..", "..", "..", "..");
  const hits: string[] = [];

  function walk(dir: string): void {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (entry === "__tests__") continue;
        if (entry === "node_modules") continue;
        walk(full);
        continue;
      }
      if (entry !== "route.ts") continue;
      hits.push(relative(repoRoot, full).split(/[\\/]/).join("/"));
    }
  }

  walk(insightsRoot);
  return hits.sort();
}

describe("Coach API route gate inventory", () => {
  it("every Coach-bearing insights route imports requireAssistantSurface('coach')", () => {
    const repoRoot = resolve(__dirname, "..", "..", "..", "..", "..");
    const routes = findInsightsRouteFiles();
    expect(routes.length).toBeGreaterThan(0);

    const allowlistOther = new Set(NON_COACH_GATED_ROUTES);
    const allowlistNone = new Set(NOT_COACH_OWNED_ROUTES);

    const orphans: Array<{ path: string; reason: string }> = [];

    for (const path of routes) {
      const full = resolve(repoRoot, path);
      const text = readFileSync(full, "utf8");
      const hasCoachGate = fileHasGateCall(text, COACH_GATE_NEEDLE);
      const hasAnyGate = fileHasGateCall(text, ANY_GATE_NEEDLE);

      if (hasCoachGate) continue;

      if (allowlistOther.has(path)) {
        // Sanity — the file should still gate on SOME assistant
        // surface. A stale entry on this allowlist is misleading
        // documentation; flip the failure mode so the orphan is
        // reported with the right diagnosis.
        if (!hasAnyGate) {
          orphans.push({
            path,
            reason:
              "listed in NON_COACH_GATED_ROUTES but has no requireAssistantSurface() call at all",
          });
        }
        continue;
      }

      if (allowlistNone.has(path)) continue;

      orphans.push({
        path,
        reason: `missing requireAssistantSurface("coach"); add the gate or move the route onto an allowlist (NON_COACH_GATED_ROUTES / NOT_COACH_OWNED_ROUTES)`,
      });
    }

    expect(
      orphans,
      [
        "Coach API route gate inventory found unaccounted-for handler(s):",
        ...orphans.map((o) => `  - ${o.path}: ${o.reason}`),
      ].join("\n"),
    ).toEqual([]);
  });

  it("allowlists do not reference deleted route files", () => {
    const known = new Set(findInsightsRouteFiles());

    const stale = [...NON_COACH_GATED_ROUTES, ...NOT_COACH_OWNED_ROUTES].filter(
      (path) => !known.has(path),
    );

    expect(
      stale,
      [
        "Allowlist entries point to files that no longer exist —",
        "delete the stale entries from",
        "`src/app/api/insights/__tests__/coach-route-gate-inventory.test.ts`:",
        ...stale.map((p) => `  - ${p}`),
      ].join("\n"),
    ).toEqual([]);
  });
});
