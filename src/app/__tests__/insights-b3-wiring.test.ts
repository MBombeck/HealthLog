import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.4.20 — guards for the `/insights` wiring of the
 * Trends row + the analytics correlations payload.
 *
 * The page-source scan pattern mirrors `insights-polish.test.ts` —
 * each test pins one load-bearing import / JSX mount so a future
 * refactor can't accidentally drop a wave of features without
 * breaking a CI lane.
 *
 * v1.12.0 — the on-overview correlation row was removed: the per-metric
 * correlation cards moved onto the metric pages they belong to (Weight
 * owns weight × weekday, Pulse owns mood × pulse), so the overview no
 * longer duplicates them. The analytics route still surfaces the
 * `correlations` block (the per-metric `MetricCorrelationCard` reads it),
 * so those backend guards stay; the overview-mount guards were dropped.
 */

const ROOT = join(__dirname, "../../..");
const INSIGHTS_PATH = join(ROOT, "src/app/insights/page-client.tsx");
/** The analytics default body, built outside its route. */
const ANALYTICS_BODY_PATHS = [
  join(ROOT, "src/lib/analytics/response/default-body.ts"),
  join(ROOT, "src/lib/analytics/response/correlations.ts"),
];
const ADVISOR_HOOK_PATH = join(
  ROOT,
  "src/components/insights/use-insights-advisor.ts",
);

function load(path: string): string {
  return readFileSync(path, "utf8");
}

describe("v1.4.20 B3 — /insights mounts TrendsRow", () => {
  it("imports the trends-row component", () => {
    // v1.4.33 IW2 deferred below-the-fold blocks behind `next/dynamic`,
    // so the static `from "..."` import-string was replaced with a
    // `dynamic(() => import("..."))` call. Either spelling counts as
    // a load-bearing reference to the module path.
    const src = load(INSIGHTS_PATH);
    expect(src).toMatch(
      /(?:from\s+"@\/components\/insights\/trends-row"|import\("@\/components\/insights\/trends-row"\))/,
    );
  });

  it("no longer mounts an on-overview correlation row (relocated to the metric pages)", () => {
    // v1.12.0 — the correlation cards live on the per-metric pages now.
    // The overview must not duplicate them: neither the module import
    // nor the JSX mount may reappear here.
    const src = load(INSIGHTS_PATH);
    expect(src).not.toMatch(/components\/insights\/correlation-row/);
    expect(src).not.toMatch(/<CorrelationRow\b/);
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
  // v1.4.37 — the inline correlation builder relocated to
  // `src/lib/analytics/correlations-fast-path.ts`. The route now
  // delegates through `computeCorrelationHypothesesFastPath`; the
  // three Pearson runner imports live alongside the new dispatcher.
  // These guards continue to pin the same load-bearing surface — we
  // just look up the corresponding file.
  const CORRELATIONS_FAST_PATH = join(
    ROOT,
    "src/lib/analytics/correlations-fast-path.ts",
  );

  it("imports the three correlation runners", () => {
    const src = load(CORRELATIONS_FAST_PATH);
    expect(src).toContain("correlateBpCompliance");
    expect(src).toContain("correlateMoodPulse");
    expect(src).toContain("correlateWeightWeekday");
  });

  it("returns a `correlations` block on the success payload", () => {
    const src = ANALYTICS_BODY_PATHS.map(load).join("\n");
    expect(src).toMatch(/correlations:\s*correlationsWithPatterns,/);
    expect(src).toMatch(/computeCorrelationHypotheses/);
  });

  it("annotates the wide event with per-hypothesis status", () => {
    const src = load(CORRELATIONS_FAST_PATH);
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
