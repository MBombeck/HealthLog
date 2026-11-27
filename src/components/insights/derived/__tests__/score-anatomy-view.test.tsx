import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ScoreAnatomyView,
  type AnatomyContributor,
} from "../score-anatomy-view";
import { I18nProvider } from "@/lib/i18n/context";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const COVERAGE = {
  requiredInputs: 5,
  presentInputs: 4,
  historyDays: 21,
  missing: ["respiratory"],
};
const CONFIDENCE = { score: 72, band: "medium" as const };
const PROVENANCE = {
  inputs: ["RESTING_HEART_RATE", "HEART_RATE_VARIABILITY"],
  source: "DAY" as const,
  windowDays: 30,
  computedAt: "2026-06-02T07:00:00+02:00",
};
const CONTRIBUTORS: AnatomyContributor[] = [
  { key: "rhr", label: "Resting heart rate", value: 80, weight: 0.3 },
  { key: "hrv", label: "HRV (SDNN)", value: 60, weight: 0.3 },
  { key: "respiratory", label: "Respiratory rate", value: null, weight: 0 },
];

describe("<ScoreAnatomyView>", () => {
  it("renders the ok state: ring + contributor rows + provenance", () => {
    const html = render(
      <ScoreAnatomyView
        title="Readiness"
        score={74}
        contributors={CONTRIBUTORS}
        coverage={COVERAGE}
        confidence={CONFIDENCE}
        provenance={PROVENANCE}
        method="A blend of deviation components."
        standard={{ name: "Plews 2013", url: "https://example.org" }}
      />,
    );
    expect(html).toContain('data-slot="score-anatomy-view"');
    expect(html).toContain('data-status="ok"');
    expect(html).toContain('data-slot="score-ring"');
    // Each contributor renders a row with its stable key attr.
    expect(html).toContain('data-contributor="rhr"');
    expect(html).toContain('data-contributor="hrv"');
    // The missing contributor renders present=false (dropped, not blank).
    expect(html).toContain('data-contributor="respiratory"');
    expect(html).toContain('data-present="false"');
    expect(html).toContain('data-slot="provenance-explainer-method"');
    expect(html).toContain("A blend of deviation components.");
    // v1.15.12 — the "keine klinische Bewertung" footer line is removed;
    // the non-clinical framing now lives in the inline provenance method.
    expect(html).not.toContain('data-slot="score-anatomy-disclaimer"');
    // Regression guard: `ProvenanceExplainer` renders its full method body
    // inline (the v1.22 refactor dropped the ⓘ glyph), so it must sit in
    // normal flow — never pulled out via `absolute top-3 right-3`, which
    // painted the whole paragraph over the title, ring and contributor rows.
    expect(html).not.toContain("absolute top-3 right-3");
  });

  it("names why a contributor is missing when the caller knows", () => {
    const html = render(
      <ScoreAnatomyView
        title="Sleep score"
        score={70}
        contributors={[
          { key: "sufficiency", label: "Sufficiency", value: 90, weight: 1 },
          {
            key: "consistency",
            label: "Consistency",
            value: null,
            weight: 0,
            missingLabel: "not enough nights yet (2 of 3)",
          },
          { key: "composition", label: "Composition", value: null, weight: 0 },
        ]}
        coverage={COVERAGE}
        confidence={CONFIDENCE}
        provenance={PROVENANCE}
        method="m"
      />,
    );
    expect(html).toContain("not enough nights yet (2 of 3)");
    // A missing contributor without a reason keeps the general note.
    expect(html).toContain("no data");
    // Neither reads as a 0 score.
    expect(html).not.toMatch(/>0, weighted/);
  });

  it("tints the card + leans the ring hue when a hue is passed (F1)", () => {
    const html = render(
      <ScoreAnatomyView
        title="Readiness"
        score={74}
        hue="readiness"
        contributors={CONTRIBUTORS}
        coverage={COVERAGE}
        confidence={CONFIDENCE}
        provenance={PROVENANCE}
        method="A blend of deviation components."
      />,
    );
    expect(html).toContain('data-tinted="true"');
    expect(html).toContain("wellness-detail-card");
    expect(html).toContain("--tile-hue");
  });

  it("renders the insufficient state with the provisional ring + nudge", () => {
    const html = render(
      <ScoreAnatomyView
        title="Sleep score"
        score={null}
        contributors={[]}
        coverage={{
          requiredInputs: 1,
          presentInputs: 0,
          historyDays: 0,
          missing: [],
        }}
        confidence={null}
        provenance={{
          inputs: [],
          source: "none",
          windowDays: 0,
          computedAt: "2026-06-02T07:00:00+02:00",
        }}
        method="A transparent blend."
        insufficient
      />,
    );
    expect(html).toContain('data-status="insufficient"');
    expect(html).toContain('data-provisional="true"'); // the ring's empty state
    expect(html).toContain('data-slot="score-anatomy-insufficient"');
    // No contributor rows in the insufficient state.
    expect(html).not.toContain('data-slot="anatomy-contributor-row"');
  });

  it("puts the one no-factors sentence under the same heading, with the origin beside the title", () => {
    const html = render(
      <ScoreAnatomyView
        title="Stress"
        score={71}
        load
        contributors={[]}
        noFactorsNote="Worked out from your heart data, not reported by a device."
        originLabel="Estimate"
        coverage={COVERAGE}
        provenance={PROVENANCE}
        method="A nightly proxy."
      />,
    );
    const block = html.slice(
      html.indexOf('data-slot="score-anatomy-contributors"'),
    );
    expect(block).toContain("Contributors");
    expect(block).toContain('data-slot="score-anatomy-no-factors"');
    expect(block).toContain("not reported by a device");
    expect(html).toContain('data-slot="score-anatomy-origin"');
    // The sentence stands before the method, where the rows would.
    expect(html.indexOf("score-anatomy-no-factors")).toBeLessThan(
      html.indexOf("A nightly proxy."),
    );
  });

  it("shows no sentence and no heading for a score that has neither", () => {
    const html = render(
      <ScoreAnatomyView
        title="Recovery"
        score={64}
        contributors={[]}
        coverage={COVERAGE}
        provenance={PROVENANCE}
        method="A blend."
      />,
    );
    expect(html).not.toContain('data-slot="score-anatomy-contributors"');
  });
});
