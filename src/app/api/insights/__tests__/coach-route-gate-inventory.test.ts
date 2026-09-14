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
 *                      `correlations`, `briefing`).
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
  // Per-biomarker assessment. Gated on the same `insightStatus` sub-flag as
  // the metric-status + specialised status routes (no Coach prose).
  "src/app/api/insights/biomarker-assessment/route.ts",
  "src/app/api/insights/blood-pressure-status/route.ts",
  "src/app/api/insights/bmi-status/route.ts",
  "src/app/api/insights/cards/route.ts",
  "src/app/api/insights/correlations/route.ts",
  "src/app/api/insights/medication-compliance-status/route.ts",
  // v1.8.7.1 — generic per-HealthKit-metric assessment. Gated on the
  // same `insightStatus` sub-flag as the seven specialised status routes.
  "src/app/api/insights/metric-status/route.ts",
  "src/app/api/insights/mood-status/route.ts",
  // v1.11.0 — period-narrative read route. Gates on the same `insightStatus`
  // sub-flag as the assessment routes (no Coach prose).
  "src/app/api/insights/narrative/route.ts",
  // v1.9.0 — on-demand full assessment warm. Warms the same assessment
  // cards the status routes serve, so it gates on `insightStatus`, not
  // `coach`: a user with assessments enabled but Coach disabled can warm.
  "src/app/api/insights/pregenerate/route.ts",
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
  // Deterministic GLP-1 plateau detector read (no assistant prose) — same
  // medications-domain posture as glp1-timeline directly above.
  "src/app/api/insights/glp1-plateau/route.ts",
  // v1.5.5 — per-user tile layout for the `/insights` surface. The
  // endpoint persists tile visibility + ordering only; it carries no
  // assistant prose and is the mirror of `/api/dashboard/widgets`,
  // which also sits outside the Coach gate. Disabling Coach must not
  // wedge the user's ability to reorder the insights tile strip.
  "src/app/api/insights/layout/route.ts",
  "src/app/api/insights/targets/route.ts",
  // v1.25 — read-only awareness cards for the overview. Each is pure compute
  // over the rollup / lab tier (baseline-drift, sleep-breathing screening,
  // last-panel lab deltas) and carries no assistant prose; they gate on the
  // `insights` module, not on the Coach surface. Disabling Coach must not
  // wedge these factual reads.
  "src/app/api/insights/health-status/route.ts",
  "src/app/api/insights/breathing-screening/route.ts",
  "src/app/api/insights/labs-changes/route.ts",
  // S11 — the intraday pulse / tension read. Deterministic compute over the
  // day's raw PULSE / steps / workouts (10-minute mean shape + the cautious
  // elevated-at-rest window); it carries no assistant prose and gates on the
  // `insights` module, not the Coach surface. Same posture as health-status /
  // labs-changes directly above — disabling Coach must not wedge this read.
  "src/app/api/insights/pulse/intraday/route.ts",
  // Persisted correlation decisions are deterministic Insights data. They
  // gate on the Insights module and remain usable when Coach is disabled.
  "src/app/api/insights/patterns/route.ts",
  "src/app/api/insights/patterns/[id]/route.ts",
  // v1.29.x (S7) — the FENCED multi-document coach chat + its attach/detach
  // mutations. These live under /insights/chat for URL grouping but are
  // DOCUMENT-surface routes: they gate on the `inboundDocuments` module
  // (`requireModuleEnabled`), NOT on the Coach assistant surface — parity with
  // the document-sheet chat (`/api/documents/inbound/[id]/chat`, outside this
  // scan). The security boundary here is the fence (no tools, no snapshot),
  // not the Coach gate; disabling Coach must not wedge a fenced document chat
  // any more than it wedges the document sheet. See the S7 design §3.2 step 1.
  "src/app/api/insights/chat/fenced/route.ts",
  "src/app/api/insights/chat/[id]/attachments/route.ts",
  "src/app/api/insights/chat/[id]/attachments/[documentId]/route.ts",
  // Deterministic reads behind the Insights overview: the comprehensive
  // overview query, the derived-metric tiles, the ECG list, strip and live
  // ingest, and the device-flagged rhythm events. None of them carries
  // assistant prose or calls a provider; they gate on the `insights` module
  // only. Switching the assistant off, the master or a sub-flag, must not
  // refuse them, or the overview fails to load.
  "src/app/api/insights/comprehensive/route.ts",
  "src/app/api/insights/derived/route.ts",
  "src/app/api/insights/derived/batch/route.ts",
  "src/app/api/insights/ecg/route.ts",
  "src/app/api/insights/ecg/[id]/route.ts",
  "src/app/api/insights/rhythm-events/route.ts",
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
