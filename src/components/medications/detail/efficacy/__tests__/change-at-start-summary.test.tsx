import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import enMessages from "../../../../../../messages/en.json";
import type { EfficacySegmented } from "@/lib/medications/efficacy/segmented-effect";
import { ChangeAtStartSummary } from "../change-at-start-summary";

function est(estimate: number, se: number) {
  const ciLow = estimate - 2 * se;
  const ciHigh = estimate + 2 * se;
  return {
    estimate,
    ciLow,
    ciHigh,
    standardError: se,
    includesZero: ciLow <= 0 && ciHigh >= 0,
  };
}

const present: EfficacySegmented = {
  present: true,
  level: 0.95,
  window: { from: "2026-01-01", to: "2026-05-30", endReason: "dose_change" },
  days: {
    before: 80,
    after: 70,
    excludedLowAdherence: 6,
    excludedNotTaking: 0,
  },
  adherence: { status: "tracked", floorPct: 80, lookbackDays: 14 },
  levelChange: est(-7.34, 0.6),
  slopeChangePerWeek: est(-0.26, 0.16),
  preSlopePerWeek: est(0.05, 0.1),
  fit: {
    n: 150,
    df: 146,
    rSquared: 0.6,
    residualAutocorrelation: 0.3,
    hacLag: 7,
    autocorrelationCaveat: false,
  },
  confounders: [
    { medicationName: "Example B", event: "started", date: "2026-02-10" },
  ],
};

function render(segmented: EfficacySegmented) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en" initialMessages={enMessages as never}>
      <ChangeAtStartSummary
        segmented={segmented}
        unit="mmHg"
        minDays={14}
        minSpanDays={21}
      />
    </I18nProvider>,
  );
}

describe("ChangeAtStartSummary", () => {
  it("states the level and trend change with their ranges in plain words", () => {
    const html = render(present);
    expect(html).toContain("the level moved by -7.3\u00a0mmHg");
    expect(html).toContain("95\u00a0% range -8.5 to -6.1");
    expect(html).toContain("changed by -0.3\u00a0mmHg per week");
    // The slope interval spans zero, so the no-change reading is said aloud.
    expect(html).toContain("also consistent with no change");
    expect(html).toContain("Based on 80 days before and 70 days after");
    expect(html).toContain("6 days after the start were left out");
    expect(html).toContain("describes the starting dose");
    expect(html).toContain("Example B started on");
    expect(html).not.toMatch(/work(s|ing)|effective|successful/i);
    expect(html).not.toContain("medication-wirkung-autocorrelation");
  });

  it("warns when the daily values carry over strongly", () => {
    const html = render({
      ...present,
      fit: {
        ...present.fit!,
        residualAutocorrelation: 0.7,
        autocorrelationCaveat: true,
      },
    });
    expect(html).toContain("medication-wirkung-autocorrelation");
    expect(html).toContain("even these ranges may be too narrow");
  });

  it("names the missing floor instead of a number", () => {
    const html = render({
      ...present,
      present: false,
      reason: "insufficient_before",
      levelChange: null,
      slopeChangePerWeek: null,
      preSlopePerWeek: null,
      fit: null,
    });
    expect(html).toContain("at least 14 days spread over 21 days before");
    expect(html).not.toContain("level moved");
  });
});
