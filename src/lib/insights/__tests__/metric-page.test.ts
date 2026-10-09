/**
 * One map from a kind of value to its page, read by the day view's value
 * tiles and the timeline's value-line names alike.
 */
import { describe, expect, it } from "vitest";

import { metricPageHref } from "../metric-page";

describe("metricPageHref", () => {
  it("leads a value with a page of its own to that page", () => {
    expect(metricPageHref("WEIGHT")).toBe("/insights/weight");
    expect(metricPageHref("PULSE")).toBe("/insights/pulse");
    expect(metricPageHref("SLEEP_DURATION")).toBe("/insights/sleep");
    expect(metricPageHref("BODY_FAT")).toMatch(/^\/insights\/body-fat/);
    expect(metricPageHref("BLOOD_PRESSURE")).toBe("/insights/blood-pressure");
    expect(metricPageHref("BLOOD_PRESSURE_SYS")).toBe(
      "/insights/blood-pressure",
    );
    expect(metricPageHref("MOOD")).toBe("/insights/mood");
  });

  it("gives a kind without a page no link", () => {
    expect(metricPageHref("NOT_A_TYPE")).toBeNull();
  });
});
