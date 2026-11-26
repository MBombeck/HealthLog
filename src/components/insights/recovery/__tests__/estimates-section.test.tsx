import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * Stress and strain, HealthLog's two estimates, close the Device scores
 * page under their own heading. A load reads as a load (a heavy stress is
 * "high", never "low"), and a strain the device served is the device's
 * number, not an estimate.
 */

const reads: Record<string, unknown> = {};
vi.mock("@/components/insights/derived/use-derived-metric", () => ({
  useDerivedMetric: (metric: string) => ({ data: reads[metric] }),
}));

import { EstimatesSection } from "../estimates-section";

function ok(value: Record<string, unknown>) {
  return {
    status: "ok",
    value,
    provenance: { windowDays: 14 },
  };
}

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <EstimatesSection />
    </I18nProvider>,
  );
}

describe("<EstimatesSection>", () => {
  it("names both as estimates and reads a heavy load as high", () => {
    reads.STRESS_SCORE = ok({ score: 80, band: "red", series: [] });
    reads.STRAIN_SCORE = ok({ score: 30, band: "green", series: [] });
    const html = render();
    expect(html).toContain("Estimates from HealthLog");
    expect(html).toContain("Stress (estimate)");
    expect(html).toContain("Strain (estimate)");
    const stress = html.slice(
      html.indexOf('data-metric="STRESS_SCORE"'),
      html.indexOf('data-metric="STRAIN_SCORE"'),
    );
    expect(stress).toContain(">high<");
    expect(stress).not.toContain(">low<");
    expect(stress).toContain('aria-label="Stress (estimate): 80, high"');
    expect(stress).toContain('href="/insights/scores/stress"');
    const strain = html.slice(html.indexOf('data-metric="STRAIN_SCORE"'));
    expect(strain).toContain(">low<");
  });

  it("leaves out a strain the device served", () => {
    reads.STRESS_SCORE = undefined;
    reads.STRAIN_SCORE = ok({
      score: 97,
      band: "red",
      series: [],
      device: { value: 20.3, scaleMax: 21 },
    });
    expect(render()).toBe("");
  });
});
