import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { ChartSkeleton } from "../chart-skeleton";

/**
 * v1.4.36 W2 — `<ChartSkeleton>` carries two variants so the loading
 * shell occupies the same visible footprint as the chart that lands
 * after `next/dynamic` resolves.
 *
 *   - Default (dashboard / sub-page hero): rounded-xl card chrome,
 *     full header row, `--chart-height` band.
 *   - `mini` (trends-row 140 px slot): rounded-md, light padding,
 *     140 px band — no header chrome.
 */
function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("<ChartSkeleton>", () => {
  it("renders the default card chrome (rounded-xl + p-4 md:p-6)", () => {
    const html = render(<ChartSkeleton />);
    expect(html).toContain('data-slot="chart-skeleton"');
    expect(html).not.toContain('data-mini="true"');
    expect(html).toMatch(/rounded-xl/);
    expect(html).toMatch(/p-4/);
    expect(html).toMatch(/md:p-6/);
  });

  it("renders the loading announcement for assistive tech", () => {
    const html = render(<ChartSkeleton />);
    expect(html).toMatch(/role="status"/);
    expect(html).toMatch(/aria-busy="true"/);
  });

  it("mini variant uses the lighter rounded-md + p-2 chrome", () => {
    const html = render(<ChartSkeleton mini />);
    expect(html).toContain('data-slot="chart-skeleton"');
    expect(html).toContain('data-mini="true"');
    expect(html).toMatch(/rounded-md/);
    expect(html).toMatch(/p-2/);
    // Default card-chrome classes must NOT appear in the mini variant.
    expect(html).not.toMatch(/rounded-xl/);
  });

  it("mini variant pins the skeleton band at h-[140px] (trends-row slot)", () => {
    const html = render(<ChartSkeleton mini />);
    expect(html).toMatch(/h-\[140px\]/);
  });

  // v1.4.43 QoL (L4) — slow-hint caption appears after a 3 s grace.
  // SSR markup never paints the caption because `useEffect` does not
  // run server-side; this also keeps hydration mismatch-free.
  it("does NOT paint the slow-hint caption in the initial SSR markup", () => {
    const html = render(<ChartSkeleton />);
    expect(html).not.toContain('data-slot="chart-skeleton-slow-hint"');
    expect(html).not.toContain("Computing analytics");
  });

  it("mini variant never sets up the slow-hint timer", () => {
    // Read the component source: the `useEffect` early-returns when
    // `mini` is true, so a `<ChartSkeleton mini />` row in trends
    // never paints the multi-line caption that would overflow it.
    const html = render(<ChartSkeleton mini />);
    expect(html).not.toContain('data-slot="chart-skeleton-slow-hint"');
  });
});
