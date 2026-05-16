import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.4.20 phase B3 — guards for the `/insights` wiring of the new
 * Trends row + Correlation row.
 *
 * The page-source scan pattern mirrors `insights-polish.test.ts` —
 * each test pins one load-bearing import / JSX mount so a future
 * refactor can't accidentally drop a wave of features without
 * breaking a CI lane.
 */

const ROOT = join(__dirname, "../../..");
const INSIGHTS_PATH = join(ROOT, "src/app/insights/page.tsx");
const ANALYTICS_ROUTE_PATH = join(ROOT, "src/app/api/analytics/route.ts");
const ADVISOR_HOOK_PATH = join(
  ROOT,
  "src/components/insights/use-insights-advisor.ts",
);

function load(path: string): string {
  return readFileSync(path, "utf8");
}

describe("v1.4.20 B3 — /insights mounts CorrelationRow + TrendsRow", () => {
  it("imports both new components", () => {
    // v1.4.33 IW2 deferred below-the-fold blocks behind `next/dynamic`,
    // so the static `from "..."` import-string was replaced with a
    // `dynamic(() => import("..."))` call. Either spelling counts as
    // a load-bearing reference to the module path.
    const src = load(INSIGHTS_PATH);
    expect(src).toMatch(
      /(?:from\s+"@\/components\/insights\/correlation-row"|import\("@\/components\/insights\/correlation-row"\))/,
    );
    expect(src).toMatch(
      /(?:from\s+"@\/components\/insights\/trends-row"|import\("@\/components\/insights\/trends-row"\))/,
    );
  });

  it("mounts <CorrelationRow> behind a non-null analytics.correlations guard", () => {
    const src = load(INSIGHTS_PATH);
    expect(src).toMatch(/analytics\?\.correlations\s*&&\s*\(/);
    expect(src).toMatch(/<CorrelationRow\b/);
  });

  it("mounts <TrendsRow> with annotations from the advisor payload", () => {
    const src = load(INSIGHTS_PATH);
    expect(src).toMatch(/<TrendsRow[\s\S]*?annotations=/);
    expect(src).toMatch(/advisor\.payload\?\.trendAnnotations/);
  });

  it("legacy advisor payload (null trendAnnotations) is handled with `?? null`", () => {
    const src = load(INSIGHTS_PATH);
    expect(src).toMatch(/trendAnnotations\s*\?\?\s*null/);
  });
});

describe("v1.4.20 B3 — /api/analytics surfaces correlations", () => {
  it("imports the three correlation runners", () => {
    const src = load(ANALYTICS_ROUTE_PATH);
    expect(src).toContain("correlateBpCompliance");
    expect(src).toContain("correlateMoodPulse");
    expect(src).toContain("correlateWeightWeekday");
  });

  it("returns a `correlations` block on the success payload", () => {
    const src = load(ANALYTICS_ROUTE_PATH);
    expect(src).toMatch(/correlations,/);
    expect(src).toMatch(/computeCorrelationHypotheses/);
  });

  it("annotates the wide event with per-hypothesis status", () => {
    const src = load(ANALYTICS_ROUTE_PATH);
    expect(src).toMatch(
      /annotate\(\{[\s\S]*correlations:[\s\S]*bpCompliance:[\s\S]*moodPulse:[\s\S]*weightWeekday:/,
    );
  });
});

describe("v1.4.20 B3 — useInsightsAdvisorQuery lifts trendAnnotations", () => {
  it("imports trendAnnotationsSchema for client-side validation", () => {
    const src = load(ADVISOR_HOOK_PATH);
    expect(src).toContain("trendAnnotationsSchema");
  });

  it("the lifted payload exposes `trendAnnotations`", () => {
    const src = load(ADVISOR_HOOK_PATH);
    expect(src).toMatch(/trendAnnotations\?:/);
    expect(src).toMatch(/payload\.trendAnnotations\s*=/);
  });

  it("malformed cached annotations resolve to null (not a half-render)", () => {
    const src = load(ADVISOR_HOOK_PATH);
    expect(src).toMatch(/parsed\.success\s*\?\s*parsed\.data\s*:\s*null/);
  });
});
