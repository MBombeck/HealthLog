import { describe, expect, it } from "vitest";

import {
  axisValueFormatters,
  gridYear,
  labelsBesidePlot,
  xTickLayout,
} from "../health-chart/series-math";

/**
 * The value axis shows the decimals its tick step needs and no more, a phone
 * keeps the chart's labels inside the plot, and an x label is as wide as a
 * date in the reader's format.
 */

const fmt = {
  number: (value: number, digits: number) => value.toFixed(digits),
  integer: (value: number) => String(Math.round(value)),
};

describe("axis value format", () => {
  it("writes a step of one as whole numbers, not 57.0, 58.0", () => {
    const { formatAxisValue, useDecimalAxis } = axisValueFormatters(
      [57, 62],
      fmt,
      [57, 58, 59, 60, 61, 62],
    );
    expect(useDecimalAxis).toBe(false);
    expect(formatAxisValue(58)).toBe("58");
  });

  it("keeps one decimal for a step of 0.5 or 0.2, two for 0.05", () => {
    expect(
      axisValueFormatters([82, 84], fmt, [82, 82.5, 83]).formatAxisValue(82.5),
    ).toBe("82.5");
    expect(
      axisValueFormatters([82, 83], fmt, [82, 82.2, 82.4]).formatAxisValue(
        82.2,
      ),
    ).toBe("82.2");
    expect(
      axisValueFormatters([1, 1.2], fmt, [1, 1.05, 1.1]).formatAxisValue(1.05),
    ).toBe("1.05");
  });

  it("without ticks, keeps one decimal while the domain spans under six units", () => {
    expect(axisValueFormatters([82, 85], fmt).useDecimalAxis).toBe(true);
    expect(axisValueFormatters([80, 90], fmt).useDecimalAxis).toBe(false);
  });
});

describe("labels beside the plot", () => {
  it("are kept on a tablet or wider and dropped into the plot on a phone", () => {
    expect(labelsBesidePlot(324)).toBe(false);
    expect(labelsBesidePlot(519)).toBe(false);
    expect(labelsBesidePlot(520)).toBe(true);
    expect(labelsBesidePlot(720)).toBe(true);
  });
});

describe("x label width", () => {
  it("follows the length of a date in the reader's format", () => {
    const short = xTickLayout(324, 76, 0, "12/31/2000")!;
    const long = xTickLayout(324, 76, 0, "2000. 12. 31.")!;
    expect(short.labelWidth).toBeLessThan(70);
    expect(long.labelWidth).toBeGreaterThan(short.labelWidth);
    expect(short.plotWidth).toBe(324 - 16 - 76 - 20);
  });
});

describe("yearly grid labels", () => {
  it("name the year the tick marks, also when it sits on a December point", () => {
    expect(gridYear(Date.UTC(2025, 0, 1, 12))).toBe(2025);
    expect(gridYear(Date.UTC(2024, 11, 18, 12))).toBe(2025);
    expect(gridYear(Date.UTC(2025, 1, 10, 12))).toBe(2025);
  });
});
