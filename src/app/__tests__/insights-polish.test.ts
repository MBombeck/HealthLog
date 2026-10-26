import type { ReactElement } from "react";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { dashboardSource } from "@/__tests__/helpers/dashboard-source";
import { STRIP_TILES } from "@/components/dashboard/tiles/strip-tiles";
import type { DashboardTileContext } from "@/components/dashboard/tiles/tile-context";

/**
 * v1.4.19 — guards for the polish pass on `/insights` and the
 * dashboard:
 *
 *   1. The dashboard page does NOT mount `<CompareToggle />`. The
 *      comparison-baseline switch belongs on `/insights` only — the
 *      dashboard tile-strip is too tight for it (maintainer probe 2026-05-10).
 *      The underlying `compareBaseline` value is still consumed by
 *      every dashboard chart; only the on-surface affordance is gone.
 *   2. The `/insights` page renders exactly ONE page-level refresh
 *      affordance — the regenerate icon on `<InsightsTabStrip>`. The
 *      hero strip no longer takes an onRegenerate prop. v1.4.28 retired
 *      the InsightAdvisorCard surface entirely.
 *   3. The `/insights` page does NOT render the small BP / Weight /
 *      Pulse trend tiles — those duplicate the dashboard tile-strip.
 *   4. The `stripChartTokens()` matcher catches lowercase + mixed-
 *      case AI-emitted tokens (`metric:blood_pressure_sweet_spot`),
 *      so the literal token text never reaches the DOM. The
 *      *render-side* parse matcher stays uppercase-only — only the
 *      *strip* is permissive.
 *
 * Lives under `src/app/__tests__` (next to quick-add-labels.test.ts)
 * because the consumers are the dashboard + insights page sources.
 */

const ROOT = join(__dirname, "../../..");
const INSIGHTS_PATH = join(ROOT, "src/app/insights/page-client.tsx");
const INSIGHTS_LAYOUT_PATH = join(ROOT, "src/app/insights/layout.tsx");

function load(path: string): string {
  return readFileSync(path, "utf8");
}

describe("v1.4.19 A3 — dashboard polish", () => {
  it("dashboard page does NOT render <CompareToggle />", () => {
    const src = dashboardSource();
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
    const src = dashboardSource();
    expect(src).toContain("layout.comparisonBaseline");
    expect(src).toContain("compareBaseline={ctx.compareBaseline}");
  });
});

describe("v1.4.27 R3d MB4 — the layout mounts the Coach drawer", () => {
  // v1.4.34 — `<CoachLaunchProvider>` + `<LayoutCoachMount>` moved
  // up to the global `<AuthShell>` so the dashboard hero (and every
  // other authed surface) can call `askCoach()` from the same context.
  // The insights layout keeps the FAB but no longer wraps the provider
  // or mounts the drawer.
  it("the global auth-shell wraps the authenticated tree in <CoachLaunchProvider> and mounts the drawer", () => {
    const shellSource = load(
      `${process.cwd()}/src/components/layout/auth-shell.tsx`,
    );
    expect(shellSource).toContain('from "@/lib/insights/coach-launch-context"');
    expect(shellSource).toMatch(/<CoachLaunchProvider>/);
    expect(shellSource).toMatch(/<LayoutCoachMount \/>/);
  });

  it("the insights layout no longer double-mounts the provider or drawer", () => {
    const layout = load(INSIGHTS_LAYOUT_PATH);
    expect(layout).not.toContain('from "@/lib/insights/coach-launch-context"');
    expect(layout).not.toContain("import { LayoutCoachMount }");
    // FAB stays scoped to `/insights/**` because the floating button
    // would distract on surfaces with a contextual inline CTA.
    expect(layout).toContain("LayoutCoachFab");
  });

  it("the overview no longer wires the inline ask-the-Coach affordance", () => {
    const src = load(INSIGHTS_PATH);
    // v1.18.7 — the inline "ask the Coach / suggested questions" block was
    // removed from the overview hero. The Coach is reached via the FAB +
    // bottom-right drawer, so the hero no longer carries onAskCoach/onPickPrompt
    // and the page no longer pulls the launch context.
    expect(src).not.toMatch(/<HeroStrip[\s\S]*?onAskCoach=\{/);
    expect(src).not.toMatch(/<HeroStrip[\s\S]*?onPickPrompt=\{/);
    expect(src).not.toContain("useCoachLaunch");
  });

  it("the page no longer owns coachOpen + coachPrefill local state", () => {
    const src = load(INSIGHTS_PATH);
    // The local useState pair retired with MB4. The launch context
    // (mounted by the layout) now owns the open + prefill lifecycle.
    expect(src).not.toContain("setCoachOpen");
    expect(src).not.toContain("setCoachPrefill");
  });
});

describe("v1.4.19 A3 — /insights polish", () => {
  it("does NOT mount <InsightAdvisorCard> anywhere (v1.4.28 retire)", () => {
    const src = load(INSIGHTS_PATH);
    // v1.4.28 retired the InsightAdvisorCard surface. The component
    // file, every test fixture and the page-level mount are gone;
    // Coach drawer is the sole conversational entry point on /insights.
    expect(src).not.toContain("InsightAdvisorCard");
    expect(src).not.toContain("insight-advisor-card");
  });

  it("tab strip owns the always-visible page-level refresh affordance (v1.4.25 W4)", () => {
    // v1.4.25 — the regenerate handler moved out of the mother page
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
    // The tile is built from the registry with a 30-day share of 80 % and
    // prior periods of 70 % (month), 50 % (year) and 40 % (all time): the
    // delta follows the chosen baseline and never the all-time share.
    const tile = STRIP_TILES.find((t) => t.widget === "bpInTarget");
    const deltaFor = (compareBaseline: string) => {
      const ctx = {
        t: (key: string) => key,
        compareBaseline,
        directionOf: () => "neutral",
        data: {
          bpInTargetPct: 75,
          bpInTargetPct7d: 78,
          bpInTargetPct30d: 80,
          bpInTargetPctAllTime: 40,
          bpInTargetPctPriorMonth: 70,
          bpInTargetPctPriorYear: 50,
          bpInTargetCount90: 200,
          bpInTargetSpanDays90: 90,
        },
      } as unknown as DashboardTileContext;
      expect(tile?.visible(ctx)).toBe(true);
      const [card] = tile?.cards(ctx) ?? [];
      return (card.node as ReactElement<{ compareDelta: number | null }>).props
        .compareDelta;
    };
    expect(deltaFor("lastMonth")).toBe(10);
    expect(deltaFor("lastYear")).toBe(30);
    expect(deltaFor("none")).toBeNull();
  });

  it("ships priorMonth + priorYear pcts in the analytics envelope", () => {
    // The default body is built outside the route.
    const ROUTE_SRC = readFileSync(
      join(ROOT, "src/lib/analytics/response/default-body.ts"),
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

describe("v1.16.8 — insights overview cold paint", () => {
  it("fires every overview query in parallel — none gated on another query's data", () => {
    const src = load(INSIGHTS_PATH);
    // The derived batch + analytics + comprehensive reads all gate on
    // auth alone. Chaining any of them behind another query's resolved
    // payload re-introduces the sequential reveal.
    expect(src).toMatch(/useDashboardDerived\(isAuthenticated\)/);
    expect(src).toMatch(/const analyticsQuery = useAnalyticsQuery\(\);/);
    expect(src).toMatch(/enabled:\s*isAuthenticated/);
    expect(src).not.toMatch(/useDashboardDerived\([^)]*data/);
  });

  it("reserves the score column's footprint while the payload is pending", () => {
    const src = load(INSIGHTS_PATH);
    // The reserve holds the column from first paint, so the resolved panel is
    // a swap rather than a push.
    expect(src).toMatch(
      /scorePending=\{analyticsQuery\.isPending && !analytics\}/,
    );
  });

  it("mounts the health score once, in the hero, outside the section registry", () => {
    const src = load(INSIGHTS_PATH);
    // An id a saved layout has never seen merges in as default-INVISIBLE, so
    // registering the score would delete it for every customised page. It is
    // also outside the briefing branch, which used to take the whole
    // breakdown down with the flag.
    // The JSX mount, not the `<HeroStrip>` mentioned in the file's header
    // comment — matching the comment would have made the slice below read a
    // block of prose and pass on nothing.
    const hero = src.search(/\n\s*<HeroStrip\n/);
    expect(hero).toBeGreaterThan(-1);
    expect(src).not.toMatch(/"health-score":/);

    // Exactly one score surface on the page, and it is the hero's prop.
    expect(src.match(/healthScore=\{/g) ?? []).toHaveLength(1);
    expect(src).not.toContain("<HealthScoreCard");
    expect(src).not.toContain("<HealthScoreCardSkeleton");

    const briefingBranch = src.slice(
      src.indexOf('"daily-briefing": flags.briefing'),
      src.indexOf("vitals: <VitalsDashboard"),
    );
    expect(briefingBranch).not.toContain("healthScore");
    // The band itself is not gated on the briefing flag either.
    const heroCall = src.slice(hero, src.indexOf("/>", hero));
    expect(heroCall).toContain("healthScore={analytics?.healthScore ?? null}");
    expect(heroCall).not.toContain("flags.briefing");
  });

  it("hero strip owns the one score surface", () => {
    const heroSrc = readFileSync(
      join(ROOT, "src/components/insights/hero-strip.tsx"),
      "utf8",
    );
    expect(heroSrc).toContain("<HealthScoreCard");
    expect(heroSrc).toContain("<HealthScoreCardSkeleton");
    // The split appears only when the column has something in it.
    expect(heroSrc).toContain("md:flex-row md:items-stretch");
    expect(heroSrc).toMatch(
      /\(healthScore \|\| scorePending\) &&\s*"md:flex-row/,
    );
  });
});
