/**
 * v1.16.8 — the in-header "adjust targets" link is gone from the chart
 * card. The affordance duplicated the page-level target-adjust control
 * in the insights sub-page header (`<TargetAdjustButton>`); the chart
 * stays a read surface. Pinned at the source level (same convention as
 * the auth-shell hoist contract) so the link doesn't quietly return on
 * a future header rework.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { readSource, readSourceFolder } from "@/__tests__/helpers/source-files";

const WEIGHT_PAGE_PATH = resolve(
  __dirname,
  "../../../app/insights/weight/page.tsx",
);
const BP_PAGE_PATH = resolve(
  __dirname,
  "../../../app/insights/blood-pressure/page.tsx",
);
const EN_BUNDLE_PATH = resolve(__dirname, "../../../../messages/en.json");

describe("v1.16.8 — chart-card target-adjust link removed", () => {
  it("ships no targetSettingsHref prop or header link in the chart", () => {
    // The component and every part it is built from (header included).
    const source = [
      readSource("src/components/charts/health-chart.tsx", "HealthChart"),
      ...readSourceFolder("src/components/charts/health-chart", {
        floor: 9,
      }).map(([, text]) => text),
    ].join("\n");
    expect(source).not.toContain("targetSettingsHref");
    expect(source).not.toContain("chart-target-settings-link");
    expect(source).not.toContain("charts.adjustTargets");
  });

  it("weight and blood-pressure pages no longer pass the link href", () => {
    for (const path of [WEIGHT_PAGE_PATH, BP_PAGE_PATH]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toContain("targetSettingsHref");
    }
  });

  it("the orphaned locale key is gone", () => {
    const bundle = JSON.parse(readFileSync(EN_BUNDLE_PATH, "utf8")) as {
      charts: Record<string, unknown>;
    };
    expect(bundle.charts.adjustTargets).toBeUndefined();
  });
});
