/**
 * Two claims the Health Score panel used to make about its own coverage
 * that were not true, held down structurally so a tidy-up cannot bring
 * either back.
 *
 * **1. `composite.coverage.presentInputs` counts DOMAINS, not pillars.**
 * `computeComposite` builds it from `eligibleDomains.size`. The panel fed
 * it into a sentence reading "{count} eligible pillars", so someone
 * recording blood pressure, glycaemia and lipids was told they had one
 * eligible pillar while looking at three. The count was right; the noun
 * was wrong, and a noun is exactly the thing a later cleanup restores
 * without noticing. The guard reads the call sites out of the AST, so it
 * fails on the value AND on the copy — passing the domain count into a
 * pillar-shaped string is caught wherever the string lives.
 *
 * **2. The composite's coverage fraction was a floor, not a proportion.**
 * `requiredInputs` is the three-domain recommendation and `deriveCoverage`
 * clamps `presentInputs` to it. Until v1.38 three domains were also the
 * price of a score, so every scored account rendered "3/3" forever,
 * whatever it recorded: a met floor presented as full coverage of the
 * person's own data. The composite's meter therefore names its axis, and
 * the guard fails if that override is dropped.
 *
 * **3. Since v1.38 the fraction is a real moving number, and the axis has
 * to move with it.** Two domains now score, so a scored account no longer
 * clears the recommendation by definition and the override cannot branch
 * on "is there a score" any more — that would tell a two-domain account it
 * covers the three areas the score recommends, which is claim 2 rebuilt one
 * floor higher. The branch is the breadth TIER: `full` states the
 * recommendation, everything narrower shows the fraction it can actually
 * count. The last block below renders the real panel at each tier rather
 * than reading the branch out of the source, because a branch that reads
 * correctly and renders the other arm is the failure this pair of claims
 * keeps producing.
 *
 * The first two are AST matchers rather than text searches, and both carry
 * a counter-test proving they stay quiet on the neighbouring call sites
 * that are legitimately about pillars.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";
import type { ScoreBreadthTier } from "@/lib/analytics/score/breadth";
import type { HealthScoreReport } from "@/lib/analytics/score/types";
import { SCORE_VERSION } from "@/lib/analytics/score/types";
import { CoverageMeter } from "../derived/coverage-meter";
import { HealthScoreCard } from "../health-score-card";
import en from "../../../../messages/en.json";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { unitPreference: "metric", glucoseUnit: "mg/dL" } }),
}));

const CARD_FILE = join(
  process.cwd(),
  "src/components/insights/health-score-card.tsx",
);

function parse(path: string, text?: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    text ?? readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

/** Dotted access path of an expression, or null when it is not one. */
function accessPath(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const base = accessPath(node.expression);
    return base === null ? null : `${base}.${node.name.text}`;
  }
  return null;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** Look a dotted i18n key up in the English bundle. */
function message(key: string): string | undefined {
  let cursor: unknown = en;
  for (const segment of key.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === "string" ? cursor : undefined;
}

/**
 * Every `t("some.key", { … })` in `file` that interpolates a value read
 * off `composite.coverage`, paired with the access paths it passed.
 */
function coverageBackedMessages(
  file: ts.SourceFile,
): { key: string; paths: string[] }[] {
  const found: { key: string; paths: string[] }[] = [];
  walk(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!ts.isIdentifier(node.expression) || node.expression.text !== "t") {
      return;
    }
    const [keyArg, valuesArg] = node.arguments;
    if (!keyArg || !ts.isStringLiteral(keyArg)) return;
    if (!valuesArg || !ts.isObjectLiteralExpression(valuesArg)) return;
    const paths: string[] = [];
    for (const property of valuesArg.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const path = accessPath(property.initializer);
      if (path && path.startsWith("composite.coverage.")) paths.push(path);
    }
    if (paths.length > 0) found.push({ key: keyArg.text, paths });
  });
  return found;
}

/** `<CoverageMeter …>` elements, with the attribute names each carries. */
function coverageMeters(
  file: ts.SourceFile,
): { coverage: string | null; attributes: string[] }[] {
  const found: { coverage: string | null; attributes: string[] }[] = [];
  walk(file, (node) => {
    let opening: ts.JsxOpeningLikeElement | null = null;
    if (ts.isJsxSelfClosingElement(node)) opening = node;
    else if (ts.isJsxElement(node)) opening = node.openingElement;
    if (!opening) return;
    if (opening.tagName.getText(file) !== "CoverageMeter") return;

    const attributes: string[] = [];
    let coverage: string | null = null;
    for (const attribute of opening.attributes.properties) {
      if (!ts.isJsxAttribute(attribute)) continue;
      const name = attribute.name.getText(file);
      attributes.push(name);
      if (name !== "coverage") continue;
      const initializer = attribute.initializer;
      if (
        initializer &&
        ts.isJsxExpression(initializer) &&
        initializer.expression
      ) {
        coverage = accessPath(initializer.expression);
      }
    }
    found.push({ coverage, attributes });
  });
  return found;
}

/**
 * The check itself, lifted out so the regression case below runs the very
 * assertions the guard runs rather than an imitation of them.
 */
function checkDomainNoun(site: { key: string; paths: string[] }): void {
  const copy = message(site.key);
  expect(copy, `missing English copy for ${site.key}`).toBeTypeOf("string");
  expect(
    copy,
    `${site.key} interpolates ${site.paths.join(", ")} (a domain count) but reads as pillars`,
  ).not.toMatch(/pillar/i);
  expect(copy, `${site.key} should name the areas it counts`).toMatch(/area/i);
}

describe("the domain count is never described as a pillar count", () => {
  const sites = coverageBackedMessages(parse(CARD_FILE));

  it("finds the call site at all", () => {
    // A matcher that matches nothing passes every assertion below it.
    // The named example is the axis fraction since v1.38: the refusal
    // sentence stopped counting areas when it stopped being reachable
    // above zero, and the meter a few lines below renders the same
    // fraction anyway.
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.map((site) => site.key)).toContain(
      "insights.healthScore.coverage.areas",
    );
  });

  it("gives every composite-coverage sentence a domain-shaped noun", () => {
    for (const site of sites) checkDomainNoun(site);
  });

  it("stays quiet on a count that really is a count of pillars", () => {
    // The neighbouring `notScored` line passes `notScored.length`, a real
    // pillar count, into copy that says "pillars" and must keep saying so.
    const counterExample = parse(
      "counter-example.tsx",
      `export function X() {
         return <p>{t("insights.healthScore.notScored", { count: notScored.length })}</p>;
       }`,
    );
    expect(coverageBackedMessages(counterExample)).toEqual([]);
    expect(message("insights.healthScore.notScored")).toMatch(/not scored/i);
  });

  it("catches the mislabel when it is reintroduced", () => {
    // The guard's own failure mode, driven through the guard's own check:
    // a domain count fed into a pillar-shaped key is collected, and the
    // check on it throws. `reason.unavailable` is a real shipped string
    // that says "pillar" for a good reason, which is what makes it the
    // right stand-in for the copy this defect produces.
    const regression = parse(
      "regression.tsx",
      `export function X() {
         return <p>{t("insights.healthScore.reason.unavailable", { count: composite.coverage.presentInputs })}</p>;
       }`,
    );
    const collected = coverageBackedMessages(regression);
    expect(collected).toHaveLength(1);
    expect(() => checkDomainNoun(collected[0])).toThrow(/pillar/i);
  });
});

describe("the composite's coverage meter names its own axis", () => {
  const meters = coverageMeters(parse(CARD_FILE));

  it("finds every meter on the panel", () => {
    // Three: the composite's, each scored pillar's, and the weight goal's.
    expect(meters).toHaveLength(3);
  });

  it("overrides the fraction on the composite's meter", () => {
    const composite = meters.filter(
      (meter) => meter.coverage === "composite.coverage",
    );
    expect(composite).toHaveLength(1);
    expect(composite[0].attributes).toContain("axisLabel");
  });

  it("leaves the per-pillar and weight-goal meters alone", () => {
    // Their fractions are real: a pillar's coverage moves with its own
    // inputs, so the default `{present}/{required}` is honest there. The
    // guard must not spread the override to them.
    const others = meters.filter(
      (meter) => meter.coverage !== "composite.coverage",
    );
    expect(others).toHaveLength(2);
    for (const meter of others) {
      expect(meter.attributes).not.toContain("axisLabel");
    }
  });

  it("has copy for both axis labels", () => {
    const met = message("insights.healthScore.coverage.recommendedMet");
    expect(met).toMatch(/area/i);
    // The recommendation arm may not describe the breadth as something
    // the score needs: needing three is the rule v1.38 removed, and this
    // sentence is the last place in the panel that still spelled it.
    expect(met).not.toMatch(/\bneeds?\b|\brequire/i);
    expect(message("insights.healthScore.coverage.areas")).toContain(
      "{present}",
    );
  });
});

/**
 * The attribute guard above proves the override is written down. This
 * proves it does something: a prop that is declared and then ignored is
 * exactly the shape of a check that cannot fail.
 */
describe("the axis override reaches the markup", () => {
  const coverage = {
    requiredInputs: 3,
    presentInputs: 3,
    historyDays: 20,
    missing: [],
  };

  function render(axisLabel?: string): string {
    return renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <CoverageMeter coverage={coverage} axisLabel={axisLabel} />
      </I18nProvider>,
    );
  }

  it("replaces the fraction in the label and the accessible name", () => {
    const html = render("Covers the three areas the score needs");

    expect(html).toContain("Covers the three areas the score needs");
    expect(html).not.toContain(">3/3<");
    expect(html).toMatch(
      /class="sr-only">Covers the three areas the score needs/,
    );
  });

  it("keeps the fraction for every caller that does not override it", () => {
    const html = render();

    expect(html).toContain("3/3");
    expect(html).toContain("3 of 3 inputs");
  });
});

/**
 * Claim 3, rendered. The three tiers the composite can carry, each put
 * through the real panel, so the axis is judged on what a person reads
 * rather than on which branch the source appears to take.
 */
describe("the axis states the recommendation only where it is met", () => {
  const provenance = {
    inputs: ["BLOOD_PRESSURE"],
    source: "live" as const,
    windowDays: 90,
    computedAt: "2026-07-28T12:00:00.000Z",
  };

  /** An ok composite spanning `domains` of the three recommended. */
  function scoredReport(
    domains: number,
    tier: ScoreBreadthTier,
  ): HealthScoreReport {
    return {
      composite: {
        status: "ok",
        value: {
          score: 78,
          band: "green",
          numberBand: "green",
          bandSetter: null,
          composition: ["BLOOD_PRESSURE"],
          configured: false,
          scoreBasis: {
            domains,
            recommended: 3,
            tier,
            physiological: true,
          },
          noiseFloor: 2,
          scoreVersion: SCORE_VERSION,
        },
        coverage: {
          requiredInputs: 3,
          presentInputs: domains,
          historyDays: 28,
          missing: [],
        },
        confidence: { score: 70, band: "medium" },
        provenance,
      },
      pillars: [],
      delta: null,
      deltaReason: null,
      scoreVersion: SCORE_VERSION,
      weightGoal: {
        status: "insufficient",
        coverage: {
          requiredInputs: 2,
          presentInputs: 0,
          historyDays: 0,
          missing: [],
        },
        provenance: { ...provenance, inputs: ["WEIGHT"] },
        reason: "no_personal_goal",
      },
      algorithmNotice: null,
    } as HealthScoreReport;
  }

  /** The refusal: not one pillar has usable data. */
  function refusedReport(): HealthScoreReport {
    return {
      ...scoredReport(0, "minimal"),
      composite: {
        status: "insufficient",
        coverage: {
          requiredInputs: 3,
          presentInputs: 0,
          historyDays: 0,
          missing: [],
        },
        provenance,
        reason: "no_usable_data",
      },
    } as HealthScoreReport;
  }

  function axisOf(report: HealthScoreReport): string {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <HealthScoreCard report={report} />
      </I18nProvider>,
    );
    // The composite's meter is the panel's first; the pillar meters live
    // behind popovers and the weight-goal meter comes after it.
    const match = html.match(/data-slot="coverage-meter-label"[^>]*>([^<]*)</);
    expect(match, "the composite meter rendered no axis label").not.toBeNull();
    return match![1];
  }

  it("states the recommendation for a full-breadth score", () => {
    expect(axisOf(scoredReport(3, "full"))).toBe(
      "Covers the three areas the score recommends",
    );
  });

  it("shows the moving fraction for a two-area score", () => {
    // The arm that used to be unreachable for a scored account: before
    // v1.38 two domains had no score at all, so this sentence could only
    // ever appear beside a dash.
    expect(axisOf(scoredReport(2, "partial"))).toBe("2 of 3 areas of health");
  });

  it("shows the moving fraction for a one-area score", () => {
    expect(axisOf(scoredReport(1, "minimal"))).toBe("1 of 3 areas of health");
  });

  it("shows the moving fraction when there is no score at all", () => {
    expect(axisOf(refusedReport())).toBe("0 of 3 areas of health");
  });
});
