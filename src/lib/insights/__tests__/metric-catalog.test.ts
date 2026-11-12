import { describe, expect, it } from "vitest";

import { METRIC_CATALOG_ENTRIES } from "../metric-catalog";

/**
 * The metric catalog offers "Connect a source" for a metric without readings
 * and the metric's own entry action for one only a person can log. Ketones
 * shipped without joining the manual list, so their row sent people to the
 * integrations page, where nothing delivers ketones.
 */
describe("metric catalog", () => {
  it("offers ketones as a manual entry, not a source to connect", () => {
    const ketones = METRIC_CATALOG_ENTRIES.find((e) => e.id === "ketones");
    expect(ketones).toBeDefined();
    expect(ketones?.connectable).toBe(false);
    expect(ketones?.manualHref).toBe("/measurements?add=BLOOD_KETONES");
    expect(ketones?.manualCtaKey).toBe("insights.bloodKetones.emptyState.cta");
  });

  it("gives every metric that cannot be connected a way to log it", () => {
    const manualOnly = METRIC_CATALOG_ENTRIES.filter(
      (e) => e.kind === "metric" && !e.connectable,
    );
    expect(manualOnly.length).toBeGreaterThan(0);
    for (const entry of manualOnly) {
      expect(entry.manualHref, entry.id).toBeTruthy();
      expect(entry.manualCtaKey, entry.id).toBeTruthy();
    }
  });
});
