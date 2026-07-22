import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { SubPageShell } from "../sub-page-shell";

vi.mock("next/navigation", () => ({
  usePathname: () => "/insights/weight",
}));

/**
 * v1.4.25 W4 — `<SubPageShell>` unit tests.
 *
 * The shell renders a focusable `<h1>` (for screen-reader landing on
 * tab navigation) plus an optional description and badge. SSR-rendered
 * markup is enough to assert the heading hierarchy + tabIndex contract.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("<SubPageShell>", () => {
  it("renders the title as a focusable h1", () => {
    const html = render(
      <SubPageShell title="Blood pressure">
        <p>child</p>
      </SubPageShell>,
    );
    expect(html).toMatch(/<h1[^>]*id="insights-subpage-title"/);
    expect(html).toMatch(/tabindex="-1"/);
    expect(html).toContain("Blood pressure");
    expect(html).toContain("<p>child</p>");
  });

  it("renders the description paragraph when supplied", () => {
    const html = render(
      <SubPageShell title="Weight" description="One paragraph">
        <span />
      </SubPageShell>,
    );
    expect(html).toContain("One paragraph");
  });

  it("omits the description block when undefined", () => {
    const html = render(
      <SubPageShell title="Pulse">
        <span />
      </SubPageShell>,
    );
    // The shell uses a `<p>` for the description; no `<p>` appears when
    // neither a description nor an explainer metric is supplied.
    expect(html).not.toMatch(/<p[^>]*class="text-muted-foreground/);
  });

  it("renders the explainer body inline beneath the heading", () => {
    const html = render(
      <SubPageShell title="Blood pressure" explainerMetric="bloodPressure">
        <span />
      </SubPageShell>,
    );
    // The inline caption reuses the same body string the `?` popover reads.
    expect(html).toMatch(/data-slot="metric-explainer-inline"/);
    expect(html).toContain(
      "Blood pressure is the force your blood exerts on the artery walls",
    );
  });

  it("no longer paints the round `?` explainer trigger next to the heading", () => {
    const html = render(
      <SubPageShell title="Blood pressure" explainerMetric="bloodPressure">
        <span />
      </SubPageShell>,
    );
    // v1.8.6 — the `?` popover affordance was dropped; only the inline
    // definition caption remains.
    expect(html).not.toMatch(/data-slot="metric-explainer-trigger"/);
  });

  it("renders the diversity nudge node inside the heading row", () => {
    const html = render(
      <SubPageShell
        title="Weight"
        diversityNudge={<span data-slot="diversity-probe" />}
      >
        <span />
      </SubPageShell>,
    );
    // v1.8.6 — the nudge moved up to the heading row (a `Lightbulb`
    // glyph), no longer an inline block beneath the stat strip.
    const headerEnd = html.indexOf("</header>");
    const probeIdx = html.indexOf('data-slot="diversity-probe"');
    expect(probeIdx).toBeGreaterThan(-1);
    expect(probeIdx).toBeLessThan(headerEnd);
  });

  it("renders the back link above the heading when supplied", () => {
    const html = render(
      <SubPageShell
        title="Weight"
        backLink={<a data-slot="back-probe">back</a>}
      >
        <span />
      </SubPageShell>,
    );
    // v1.8.7.1 — the back-nav leads the page, above the heading.
    const backIdx = html.indexOf('data-slot="back-probe"');
    const headerIdx = html.indexOf("<header");
    expect(backIdx).toBeGreaterThan(-1);
    expect(headerIdx).toBeGreaterThan(-1);
    expect(backIdx).toBeLessThan(headerIdx);
  });

  it("renders the show-all-values entry as an icon button inside the header cluster (v1.16.8)", () => {
    const html = render(
      <SubPageShell title="Weight" showAllValuesType="WEIGHT">
        <span />
      </SubPageShell>,
    );
    const idx = html.indexOf('data-slot="metric-show-all-values"');
    expect(idx).toBeGreaterThan(-1);
    // Lives in the header action cluster, not at the page foot.
    expect(idx).toBeLessThan(html.indexOf("</header>"));
    // Icon-only control: the label travels via aria-label + title.
    expect(html).toContain('aria-label="Show all readings"');
    expect(html).toContain('title="Show all readings"');
    expect(html).toContain("/insights/values/WEIGHT");
    // Exactly one entry — the old foot-of-page button must not return.
    expect(html.indexOf('data-slot="metric-show-all-values"')).toBe(
      html.lastIndexOf('data-slot="metric-show-all-values"'),
    );
    expect(html).not.toContain("w-full sm:w-auto");
    // The cluster gap must clear the siblings' extended hit areas
    // (`before:-inset-1.5` = 6 px per edge → ≥12 px gap): with the old
    // `gap-0.5` the later sibling's invisible halo overlapped its
    // neighbour's clickable edge.
    expect(html).toContain("items-center gap-3");
    expect(html).not.toContain("items-center gap-0.5");
  });

  it("links a populated metric capture action to a preselected one-shot form", () => {
    const html = render(
      <SubPageShell
        title="Weight"
        captureType="WEIGHT"
        showAllValuesType="WEIGHT"
      >
        <span />
      </SubPageShell>,
    );

    const idx = html.indexOf('data-slot="metric-add-reading"');
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(html.indexOf("</header>"));
    expect(html).toContain('aria-label="Add: Weight"');
    expect(html).toContain(
      "/measurements?add=WEIGHT&amp;returnTo=%2Finsights%2Fweight",
    );
  });

  it("omits the populated metric capture action without a capture type", () => {
    const html = render(
      <SubPageShell title="Weight" showAllValuesType="WEIGHT">
        <span />
      </SubPageShell>,
    );

    expect(html).not.toContain('data-slot="metric-add-reading"');
  });

  it("omits the show-all-values control without a type", () => {
    const html = render(
      <SubPageShell title="BMI">
        <span />
      </SubPageShell>,
    );
    expect(html).not.toContain('data-slot="metric-show-all-values"');
  });

  it("no longer renders the duplicate customise cog in the header (v1.16.8)", () => {
    const html = render(
      <SubPageShell title="Weight" showAllValuesType="WEIGHT">
        <span />
      </SubPageShell>,
    );
    // The sticky tab strip above the page body owns the single
    // "customise insights" entry point; the header copy was removed.
    expect(html).not.toContain('data-slot="insights-subpage-customize"');
    expect(html).not.toContain("/settings/insights");
  });

  it("mounts no coach launch surface when coachLaunch is omitted", () => {
    const html = render(
      <SubPageShell title="Pulse">
        <span />
      </SubPageShell>,
    );
    // The coach icon only renders under the launch provider + flags; the
    // shell renders nothing for it on the default path.
    expect(html).not.toContain('data-slot="coach-launch-icon"');
  });
});
