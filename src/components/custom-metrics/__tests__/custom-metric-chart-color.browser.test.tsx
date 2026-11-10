import { describe, expect, it } from "vitest";

import { renderWithApp } from "../../../../tests/browser/render";
import { CustomMetricChart } from "../custom-metric-chart";

/**
 * The line takes the series colour it is given (the GKI draws in a chart
 * token beside the ketone series) and keeps primary when it is given none,
 * so a custom metric's chart looks as it always has.
 */

const NOW = Date.now();
const ENTRIES = [3, 2, 1].map((daysAgo, i) => ({
  id: `e${i}`,
  customMetricId: "",
  value: 2 + i,
  unit: "",
  measuredAt: new Date(NOW - daysAgo * 86_400_000).toISOString(),
  note: null,
}));

async function lineStroke(color?: string): Promise<string | null> {
  const { screen } = await renderWithApp(
    <div style={{ width: 600 }}>
      <CustomMetricChart
        name="Index"
        unit=""
        targetLow={null}
        targetHigh={null}
        decimals={1}
        entries={ENTRIES as never}
        {...(color ? { color } : {})}
      />
    </div>,
  );
  const curve = () => screen.container.querySelector(".recharts-line-curve");
  await expect.poll(curve).not.toBeNull();
  return curve()!.getAttribute("stroke");
}

describe("<CustomMetricChart> series colour", () => {
  it("draws the line in the colour it is given", async () => {
    expect(await lineStroke("var(--chart-4)")).toBe("var(--chart-4)");
  });

  it("keeps primary by default", async () => {
    expect(await lineStroke()).toBe("var(--primary)");
  });
});
