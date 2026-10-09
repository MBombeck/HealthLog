import { describe, expect, it } from "vitest";

import {
  SERIES_PALETTE,
  assignSeriesColors,
  preferredSeriesColor,
} from "../series-colors";
import { VALUE_OPTIONS } from "../timeline-view";

/**
 * A value line takes the colour its type carries in the measurement list,
 * no two of the first five chosen lines share one, and from the sixth on
 * the five data tokens repeat in palette order.
 */
describe("assignSeriesColors", () => {
  it("gives a type on its own the colour it has in the list", () => {
    expect(assignSeriesColors(["WEIGHT"]).get("WEIGHT")).toBe("var(--chart-1)");
    expect(assignSeriesColors(["PULSE"]).get("PULSE")).toBe("var(--chart-5)");
    expect(assignSeriesColors(["SLEEP_DURATION"]).get("SLEEP_DURATION")).toBe(
      "var(--chart-2)",
    );
    for (const key of VALUE_OPTIONS) {
      const own = preferredSeriesColor(key);
      const alone = assignSeriesColors([key]).get(key);
      expect(alone).toBe(own ?? SERIES_PALETTE[0]);
    }
  });

  it("only ever hands out data tokens", () => {
    for (const key of VALUE_OPTIONS) {
      const own = preferredSeriesColor(key);
      if (own) expect(SERIES_PALETTE).toContain(own);
    }
  });

  it("never repeats a colour among five chosen lines", () => {
    // Every five-line choice from the selector's options.
    const options = [...VALUE_OPTIONS];
    const pick = (from: number, chosen: string[]): string[][] =>
      chosen.length === 5
        ? [chosen]
        : options
            .slice(from)
            .flatMap((key, i) => pick(from + i + 1, [...chosen, key]));
    const choices = pick(0, []);
    expect(choices.length).toBeGreaterThan(100);
    for (const keys of choices) {
      const colours = assignSeriesColors(keys, VALUE_OPTIONS);
      expect(colours.size).toBe(5);
      expect(new Set(colours.values()).size).toBe(5);
    }
  });

  it("repeats the five data tokens in order past the fifth line, never the foreground", () => {
    const keys = [
      ...VALUE_OPTIONS,
      "BODY_TEMPERATURE",
      "VO2_MAX",
      "OXYGEN_SATURATION",
      "RESPIRATORY_RATE",
    ];
    expect(keys.length).toBe(15);
    const colours = assignSeriesColors(keys, keys);
    expect(colours.size).toBe(15);
    const used = [...colours.values()];
    for (const colour of used) expect(SERIES_PALETTE).toContain(colour);
    // Every token is used before any is used again, and none more than
    // three times across fifteen lines.
    for (const token of SERIES_PALETTE) {
      expect(used.filter((c) => c === token).length).toBe(3);
    }
  });

  it("is the same whatever order the lines were picked in", () => {
    const keys = [
      "BLOOD_PRESSURE_SYS",
      "WEIGHT",
      "RESTING_HEART_RATE",
      "BLOOD_PRESSURE_DIA",
      "MOOD",
    ];
    const forward = assignSeriesColors(keys, VALUE_OPTIONS);
    const backward = assignSeriesColors([...keys].reverse(), VALUE_OPTIONS);
    expect(Object.fromEntries(backward)).toEqual(Object.fromEntries(forward));
    // Systolic keeps its own colour; diastolic, resting pulse and mood
    // move to free ones.
    expect(forward.get("BLOOD_PRESSURE_SYS")).toBe("var(--chart-3)");
    expect(forward.get("WEIGHT")).toBe("var(--chart-1)");
    expect(forward.get("BLOOD_PRESSURE_DIA")).not.toBe("var(--chart-3)");
  });
});
