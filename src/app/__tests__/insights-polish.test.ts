import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.4.19 A3 — guards for the polish pass on `/insights` and the
 * dashboard:
 *
 *   1. The dashboard page does NOT mount `<CompareToggle />`. The
 *      comparison-baseline switch belongs on `/insights` only — the
 *      dashboard tile-strip is too tight for it (maintainer probe 2026-05-10).
 *      The underlying `compareBaseline` value is still consumed by
 *      every dashboard chart; only the on-surface affordance is gone.
 *   2. The `/insights` page renders exactly ONE page-level refresh
 *      affordance — the hero's regenerate button. The advisor card
 *      no longer carries its own onRegenerate handler that
 *      duplicated the hero one and again surfaced "Analyse starten"
 *      in the empty-state CTA. The per-recommendation Regenerate
 *      stays — that's per-card, not page-level.
 *   3. The `/insights` page does NOT render the small BP / Weight /
 *      Pulse trend tiles — those duplicate the dashboard tile-strip.
 *   4. The `/insights` page does NOT pass the `aiOverviewTitle`
 *      ("Persönlicher Berater") subtitle into `<InsightAdvisorCard>`.
 *      The CardTitle ("KI-Gesundheitsanalyse") is sufficient framing;
 *      the second subtitle was an empty-section placeholder the maintainer
 *      called "Titel da aber NICHTS PASSIERT".
 *   5. The `stripChartTokens()` matcher catches lowercase + mixed-
 *      case AI-emitted tokens (`metric:blood_pressure_sweet_spot`),
 *      so the literal token text never reaches the DOM. The
 *      *render-side* parse matcher stays uppercase-only — only the
 *      *strip* is permissive.
 *
 * Lives under `src/app/__tests__` (next to quick-add-labels.test.ts)
 * because the consumers are the dashboard + insights page sources.
 */

const ROOT = join(__dirname, "../../..");
const DASHBOARD_PATH = join(ROOT, "src/app/page.tsx");
const INSIGHTS_PATH = join(ROOT, "src/app/insights/page.tsx");

function load(path: string): string {
  return readFileSync(path, "utf8");
}

describe("v1.4.19 A3 — dashboard polish", () => {
  it("dashboard page does NOT render <CompareToggle />", () => {
    const src = load(DASHBOARD_PATH);
    // The component import + JSX use are both gone. The toggle still
    // lives on /insights via a separate import there.
    expect(src).not.toMatch(/<CompareToggle\b/);
    expect(src).not.toMatch(
      /from\s+["']@\/components\/comparison\/compare-toggle["']/,
    );
  });

  it("dashboard page still consumes layout.comparisonBaseline (only the UI is gone)", () => {
    // Drift guard — if a future refactor accidentally drops the
    // baseline plumbing along with the toggle, every chart on the
    // dashboard would lose its comparison overlay silently. The
    // resolved layout still carries the value to each chart.
    const src = load(DASHBOARD_PATH);
    expect(src).toContain("comparisonBaseline");
    expect(src).toContain("compareBaseline");
  });
});

describe("v1.4.20 B2b — /insights wires the Coach drawer", () => {
  it("imports <CoachDrawer> and mounts it at the bottom of the page", () => {
    const src = load(INSIGHTS_PATH);
    expect(src).toContain(
      'from "@/components/insights/coach-panel/coach-drawer"',
    );
    expect(src).toMatch(/<CoachDrawer\b[\s\S]*?\/>/);
  });

  it("hero strip's onAskCoach handler opens the drawer with no prefill", () => {
    const src = load(INSIGHTS_PATH);
    // The hero supplies onAskCoach which sets coachPrefill to null and
    // flips coachOpen.
    expect(src).toMatch(/<HeroStrip[\s\S]*?onAskCoach=\{/);
    expect(src).toMatch(/<HeroStrip[\s\S]*?onPickPrompt=\{/);
  });

  it("page owns coachOpen + coachPrefill state", () => {
    const src = load(INSIGHTS_PATH);
    expect(src).toContain("setCoachOpen");
    expect(src).toContain("setCoachPrefill");
  });
});

describe("v1.4.19 A3 — /insights polish", () => {
  it("does NOT mount the legacy advisor-card regenerate handler", () => {
    const src = load(INSIGHTS_PATH);
    // The advisor card no longer carries its own onRegenerate handler
    // that duplicated the hero one. v1.4.20 phase B1 added a second
    // wiring (the <DailyBriefing> empty-state CTA), which only renders
    // while the briefing payload is null — its purpose is "generate
    // today's briefing" rather than "refresh", and it disappears the
    // moment a briefing exists. The original v1.4.19 ratchet was the
    // advisor-card duplication; that one stays banned.
    //
    // We extract the InsightAdvisorCard JSX block (everything up to
    // the closing `/>`) and assert no `onRegenerate` prop appears
    // inside it.
    const advisorBlock = src.match(/<InsightAdvisorCard\b[^>]*\/>/);
    expect(advisorBlock).not.toBeNull();
    expect(advisorBlock?.[0]).not.toContain("onRegenerate");
  });

  it("tab strip owns the always-visible page-level refresh affordance (v1.4.25 W4)", () => {
    // v1.4.25 W4 — the regenerate handler moved out of the mother page
    // body entirely and now lives on the layout-mounted
    // `<InsightsLayoutShell>` (which renders `<InsightsTabStrip>` with
    // the advisor query's regenerate wired in). The mother-page hero
    // no longer takes an `onRegenerate` prop, mirroring the v1.4.25 W3
    // contract while accommodating the new routed sub-page layout.
    const shellSrc = readFileSync(
      join(ROOT, "src/components/insights/insights-layout-shell.tsx"),
      "utf8",
    );
    expect(shellSrc).toMatch(
      /<InsightsTabStrip[\s\S]*?onRegenerate=[\s\S]*?advisor\.regenerate[\s\S]*?\/>/,
    );
    const insightsSrc = load(INSIGHTS_PATH);
    const heroBlock = insightsSrc.match(/<HeroStrip[\s\S]*?\/>/);
    expect(heroBlock).not.toBeNull();
    expect(heroBlock?.[0]).not.toContain("onRegenerate");
  });

  it("does NOT render the duplicate <TrendCard> tile strip on /insights", () => {
    const src = load(INSIGHTS_PATH);
    // The /insights tile strip used the same TrendCard component the
    // dashboard does — duplicating numbers without any extra context.
    // The import being gone is the load-bearing assertion; the
    // leave-behind comment explaining the removal references
    // `<TrendCard>` in backtick-quoted prose, so we don't grep for
    // the JSX literal itself.
    expect(src).not.toContain('from "@/components/charts/trend-card"');
    // Also verify no JSX-style mount survives (`<TrendCard ` + space
    // for an attribute, or `<TrendCard\n` for a multi-line element).
    expect(src).not.toMatch(/<TrendCard[\s\n]/);
  });

  it("does NOT pass the `aiOverviewTitle` placeholder subtitle to <InsightAdvisorCard>", () => {
    const src = load(INSIGHTS_PATH);
    // The "Persönlicher Berater" / "Personal advisor" string was a
    // dead title above an empty-state body when the user had no
    // provider configured. Removed; the CardTitle inside the advisor
    // card already says "KI-Gesundheitsanalyse".
    expect(src).not.toContain('t("insights.aiOverviewTitle")');
  });

  it("does NOT contain raw `metric:<name>` template strings in static prose", () => {
    const src = load(INSIGHTS_PATH);
    // The chart-token pattern (`metric:WEIGHT`) is reserved for AI
    // prose and is stripped via `stripChartTokens()` before render.
    // The page source itself must not hand-write the token string
    // between JSX delimiters.
    expect(src).not.toMatch(/>\s*metric:[A-Za-z_]+\s*</);
  });
});

describe("v1.4.19 A3 — chart-token leak hardening", () => {
  // The visible "metric: blood_pressure_sweet" leak the maintainer saw at the
  // bottom of /insights was a model-emitted lowercase chart token
  // that the v1.4.16 strip regex (`/metric:[A-Z_]+/g`) didn't catch
  // because the character class only matches uppercase. The widened
  // matcher in `chart-tokens.ts` strips ANY case so the literal
  // string can no longer reach the DOM. Allowlisted *render* paths
  // remain uppercase-only — only the strip is permissive.
  it("the strip matcher catches lowercase model output", async () => {
    const { stripChartTokens } = await import("@/lib/insights/chart-tokens");
    expect(
      stripChartTokens("BP plateau metric:blood_pressure_sweet today"),
    ).toBe("BP plateau today");
  });

  it("the strip matcher catches mixed-case model output", async () => {
    const { stripChartTokens } = await import("@/lib/insights/chart-tokens");
    expect(stripChartTokens("note metric:BloodPressureSys then")).toBe(
      "note then",
    );
  });

  it("the parse matcher still returns ONLY uppercase allowlisted tokens", async () => {
    const { parseChartTokens } = await import("@/lib/insights/chart-tokens");
    // Lowercase / mixed-case tokens are stripped from prose but never
    // mounted as a chart — render path stays strict.
    expect(parseChartTokens("metric:blood_pressure_sweet")).toEqual([]);
    expect(parseChartTokens("metric:BloodPressureSys")).toEqual([]);
    expect(parseChartTokens("metric:WEIGHT")).toEqual(["metric:WEIGHT"]);
  });
});

describe("v1.4.22 W5 reconcile (Code-H2) — BD-Zielbereich tile compareDelta uses period-aligned baseline", () => {
  /**
   * Up to v1.4.22 W4 the BD tile computed `bp30 - bpAll`
   * (last-30-days minus all-time) regardless of which window the user
   * picked under Settings → Dashboard. The caption still rendered "vs.
   * last month" / "vs. last year" via `comparison.captionLastMonth` /
   * `comparison.captionLastYear`, so the user read a sentence whose
   * numerator was actually a 30d-vs-all-time delta. Every other tile
   * routes through `tileCompareDelta()` with `summary.avg30LastMonth`
   * / `summary.avg30LastYear` for honest period-aligned math.
   *
   * This test pins that the dashboard now subtracts the prior-period
   * window (priorMonth / priorYear) instead of all-time.
   */
  it("subtracts bpInTargetPctPriorMonth when comparisonBaseline=lastMonth", () => {
    const src = load(DASHBOARD_PATH);
    // The fix introduces `bpComparePrior` keyed by `compareBaseline`.
    expect(src).toContain("bpInTargetPctPriorMonth");
    expect(src).toContain("bpInTargetPctPriorYear");
    // The all-time shortcut from v1.4.22 A2 must not subtract `bpAll`
    // for the comparison delta any more.
    expect(src).not.toMatch(/bp30\s*-\s*bpAll/);
  });

  it("ships priorMonth + priorYear pcts in the analytics envelope", () => {
    const ROUTE_SRC = readFileSync(
      join(ROOT, "src/app/api/analytics/route.ts"),
      "utf8",
    );
    expect(ROUTE_SRC).toContain("bpInTargetPctPriorMonth");
    expect(ROUTE_SRC).toContain("bpInTargetPctPriorYear");
  });
});

describe("v1.4.22 A3 — comparison toggle is global Settings only", () => {
  /**
   * The comparison-overlay toggle is a global preference. Up to v1.4.21
   * the toggle existed both in `/settings/dashboard` (canonical) and
   * `/insights` (via `<DailyBriefing metaSlot={<CompareToggle />} />`).
   * Per `feedback_settings_no_split.md` the toggle now lives in
   * Settings only — the on-surface affordance is gone from `/insights`.
   * Every chart still consumes the resolved `comparisonBaseline` value
   * the same way it did before, so flipping the Settings toggle still
   * propagates to the page on next refetch.
   */
  it("/insights does NOT mount <CompareToggle /> anywhere", () => {
    const src = load(INSIGHTS_PATH);
    expect(src).not.toMatch(/<CompareToggle\b/);
    expect(src).not.toMatch(
      /from\s+["']@\/components\/comparison\/compare-toggle["']/,
    );
  });

  it("/insights still consumes the resolved comparisonBaseline (only the UI is gone)", () => {
    // Drift guard — v1.4.25 W4 split each metric onto its own sub-route
    // under `/insights/<slug>`, and `compareBaseline` propagation now
    // happens via `useInsightsLayoutPrefs()` on every sub-page. The
    // central hook is the load-bearing surface; assert it carries both
    // the resolved value and the persisted preference key.
    const hookSrc = readFileSync(
      join(ROOT, "src/hooks/use-insights-layout-prefs.ts"),
      "utf8",
    );
    expect(hookSrc).toContain("comparisonBaseline");
    expect(hookSrc).toContain("compareBaseline");
  });
});
