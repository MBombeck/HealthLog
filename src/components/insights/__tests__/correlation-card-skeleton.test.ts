import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.4.43 W11 — correlation-card scatter skeleton class guard.
 *
 * The skeleton must mirror the loaded chart's responsive aspect-
 * ratio classes (`scatter-correlation-chart.tsx:100`) so the
 * placeholder reserves the same space across breakpoints. A simple
 * substring check is enough — the only way to break this is to
 * remove the `aspect-square` / `sm:aspect-[3/2]` / `sm:h-auto` /
 * `min-h-[180px]` quartet, which the audit recommended pinning.
 */
describe("correlation-card scatter skeleton mirrors loaded chart", () => {
  const cardSrc = readFileSync(
    join(process.cwd(), "src/components/insights/correlation-card.tsx"),
    "utf8",
  );
  const chartSrc = readFileSync(
    join(
      process.cwd(),
      "src/components/charts/scatter-correlation-chart.tsx",
    ),
    "utf8",
  );

  it("skeleton declares the chart's aspect-ratio quartet", () => {
    // Capture only the dynamic-loader block so the assertion can't
    // accidentally match a class somewhere else in the file.
    const dynamicBlock = cardSrc.match(/loading: \(\) => \([\s\S]*?\),/);
    expect(dynamicBlock).not.toBeNull();
    const block = dynamicBlock?.[0] ?? "";
    expect(block).toContain("aspect-square");
    expect(block).toContain("min-h-[180px]");
    expect(block).toContain("sm:aspect-[3/2]");
    expect(block).toContain("sm:h-auto");
    expect(block).toContain("motion-reduce:animate-none");
  });

  it("loaded scatter chart still owns the same aspect-ratio quartet", () => {
    // If this regression ever silently flips on the loaded chart, the
    // skeleton mirror loses its purpose. Pin both sides.
    expect(chartSrc).toContain("aspect-square");
    expect(chartSrc).toContain("min-h-[180px]");
    expect(chartSrc).toContain("sm:aspect-[3/2]");
    expect(chartSrc).toContain("sm:h-auto");
  });
});
