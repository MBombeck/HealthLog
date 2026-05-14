import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  HealthScoreCard,
  type HealthScoreCardProps,
} from "../health-score-card";

/**
 * v1.4.25 W8e — Health-Score provenance accordion.
 *
 * The card now grows a tap-to-expand accordion under the four
 * component sub-bars. The accordion surfaces:
 *   - per-component value-bar + numeric value
 *   - effective weight share (second, narrower bar)
 *   - source pill (manual / withings / appleHealth / mixed / none)
 *   - a "mixed sources" `role="status"` banner when at least one row
 *     has `source === "mixed"`
 *   - a "Provisional" badge in the header when < 50% of inputs are
 *     present
 *
 * SSR is the test convention in this project (no `@testing-library/react`
 * dependency). The card exposes `initiallyExpanded` so the markup of
 * the expanded panel renders inside `renderToStaticMarkup`. Interactive
 * behaviour (click toggles `aria-expanded`) is verified at the contract
 * level: collapsed state pins `aria-expanded="false"`, expanded state
 * (via `initiallyExpanded`) pins `aria-expanded="true"` + renders the
 * panel.
 */

const componentsAllPresent: HealthScoreCardProps["components"] = {
  bp: {
    value: 82,
    weight: 0.3,
    source: "withings",
    asOf: "2026-05-14T08:00:00.000Z",
  },
  weight: {
    value: 75,
    weight: 0.2,
    source: "manual",
    asOf: "2026-05-13T18:00:00.000Z",
  },
  mood: {
    value: 90,
    weight: 0.2,
    source: "manual",
    asOf: "2026-05-14T07:00:00.000Z",
  },
  compliance: {
    value: 95,
    weight: 0.3,
    source: "manual",
    asOf: "2026-05-14T00:00:00.000Z",
  },
};

function ssr(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<HealthScoreCard> — provenance accordion (W8e)", () => {
  it("renders the toggle button with aria-expanded=false when collapsed", () => {
    const html = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={componentsAllPresent}
        delta={null}
      />,
    );
    expect(html).toMatch(
      /data-slot="health-score-card-provenance-toggle"[^>]*aria-expanded="false"/,
    );
    // Toggle text uses the localised "Driven by" copy.
    expect(html).toContain("Driven by");
    // Panel is NOT rendered when collapsed.
    expect(html).not.toContain(
      'data-slot="health-score-card-provenance-panel"',
    );
  });

  it("renders the panel + sets aria-expanded=true when initiallyExpanded", () => {
    const html = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={componentsAllPresent}
        delta={null}
        initiallyExpanded
      />,
    );
    expect(html).toMatch(
      /data-slot="health-score-card-provenance-toggle"[^>]*aria-expanded="true"/,
    );
    expect(html).toContain('data-slot="health-score-card-provenance-panel"');
  });

  it("aria-controls on the toggle points at the rendered panel's id", () => {
    const html = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={componentsAllPresent}
        delta={null}
        initiallyExpanded
      />,
    );
    // Extract aria-controls value from the toggle and confirm the
    // panel section uses the same id.
    const controlsMatch = html.match(
      /data-slot="health-score-card-provenance-toggle"[^>]*aria-controls="([^"]+)"/,
    );
    expect(controlsMatch).not.toBeNull();
    const id = controlsMatch![1];
    // The panel section must carry the same id; we don't pin the exact
    // attribute order because additional ARIA attributes (e.g.
    // `aria-labelledby`) may sit between `id` and `data-slot`.
    const panelMatch = html.match(
      new RegExp(`<section[^>]*\\bid="${id}"[^>]*data-slot="health-score-card-provenance-panel"`),
    );
    expect(panelMatch).not.toBeNull();
  });

  it("sorts rows by effective weight descending (null components sink to bottom)", () => {
    const components: HealthScoreCardProps["components"] = {
      bp: { value: null, weight: 0, source: "none" },
      weight: { value: 60, weight: 0.4, source: "manual" },
      mood: { value: 80, weight: 0.3, source: "manual" },
      compliance: { value: 70, weight: 0.3, source: "manual" },
    };
    const html = ssr(
      <HealthScoreCard
        score={60}
        band="yellow"
        components={components}
        delta={null}
        initiallyExpanded
      />,
    );
    // Pull every `data-component=` token from the provenance rows.
    const rowMatches = Array.from(
      html.matchAll(
        /data-slot="health-score-card-provenance-row"[^>]*data-component="([^"]+)"/g,
      ),
    ).map((m) => m[1]);
    // Weight (0.4) > mood (0.3) > compliance (0.3) — mood vs compliance
    // tie-break is the alphabetical key order. BP at weight=0 sinks
    // to the bottom.
    expect(rowMatches).toEqual(["weight", "compliance", "mood", "bp"]);
  });

  it("renders source pills with locale-resolved labels (EN)", () => {
    const html = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={componentsAllPresent}
        delta={null}
        initiallyExpanded
      />,
    );
    // Withings + Manual both present in the data.
    expect(html).toContain("Withings");
    expect(html).toContain("Manual");
  });

  it("renders source pills with locale-resolved labels (DE)", () => {
    const html = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={componentsAllPresent}
        delta={null}
        initiallyExpanded
      />,
      "de",
    );
    // Manuell is the DE label for "manual".
    expect(html).toContain("Manuell");
    expect(html).toContain("Withings");
    expect(html).toContain("Zusammensetzung");
  });

  it("renders the mixed-source banner with role=status when any row is mixed", () => {
    const components: HealthScoreCardProps["components"] = {
      ...componentsAllPresent,
      bp: { value: 82, weight: 0.3, source: "mixed" },
    };
    const html = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={components}
        delta={null}
        initiallyExpanded
      />,
    );
    expect(html).toMatch(
      /data-slot="health-score-card-provenance-mixed-banner"[^>]*role="status"/,
    );
    // The pill on the BP row reads "Mixed" (EN).
    expect(html).toContain("Mixed");
  });

  it("does NOT render the mixed-source banner when no row is mixed", () => {
    const html = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={componentsAllPresent}
        delta={null}
        initiallyExpanded
      />,
    );
    expect(html).not.toContain(
      'data-slot="health-score-card-provenance-mixed-banner"',
    );
  });

  it("dims empty-state rows when source is `none`", () => {
    const components: HealthScoreCardProps["components"] = {
      ...componentsAllPresent,
      mood: { value: null, weight: 0, source: "none" },
    };
    const html = ssr(
      <HealthScoreCard
        score={70}
        band="yellow"
        components={components}
        delta={null}
        initiallyExpanded
      />,
    );
    // The dimmed row carries opacity-50 alongside the `data-source="none"`
    // attribute.
    expect(html).toMatch(
      /data-component="mood"[^>]*data-source="none"[^>]*class="[^"]*opacity-50/,
    );
    // The source pill reads "No data" (EN).
    expect(html).toContain("No data");
  });

  it("renders the provisional badge when fewer than 50% of inputs are present", () => {
    // Three out of four components null → 1 of 4 = 25 % present.
    const components: HealthScoreCardProps["components"] = {
      bp: {
        value: 80,
        weight: 1,
        source: "withings",
        asOf: "2026-05-14T08:00:00.000Z",
      },
      weight: { value: null, weight: 0, source: "none" },
      mood: { value: null, weight: 0, source: "none" },
      compliance: { value: null, weight: 0, source: "none" },
    };
    const html = ssr(
      <HealthScoreCard
        score={80}
        band="green"
        components={components}
        delta={null}
      />,
    );
    expect(html).toContain(
      'data-slot="health-score-card-provisional-badge"',
    );
    // EN badge copy.
    expect(html).toContain("Provisional");
  });

  it("does NOT render the provisional badge when at least 50% of inputs are present", () => {
    // 2 of 4 = 50 % → NOT provisional.
    const components: HealthScoreCardProps["components"] = {
      bp: {
        value: 80,
        weight: 0.6,
        source: "withings",
        asOf: "2026-05-14T08:00:00.000Z",
      },
      weight: {
        value: 70,
        weight: 0.4,
        source: "manual",
        asOf: "2026-05-13T08:00:00.000Z",
      },
      mood: { value: null, weight: 0, source: "none" },
      compliance: { value: null, weight: 0, source: "none" },
    };
    const html = ssr(
      <HealthScoreCard
        score={75}
        band="green"
        components={components}
        delta={null}
      />,
    );
    expect(html).not.toContain(
      'data-slot="health-score-card-provisional-badge"',
    );
  });

  it("renders the source-pill aria-label with localised source name", () => {
    const html = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={componentsAllPresent}
        delta={null}
        initiallyExpanded
      />,
    );
    // BP row uses Withings; the aria-label uses the localised
    // "Source: Withings" form.
    expect(html).toContain('aria-label="Source: Withings"');
  });

  it("renders the value bar at 0% width for empty-state rows", () => {
    const components: HealthScoreCardProps["components"] = {
      ...componentsAllPresent,
      compliance: { value: null, weight: 0, source: "none" },
    };
    const html = ssr(
      <HealthScoreCard
        score={70}
        band="yellow"
        components={components}
        delta={null}
        initiallyExpanded
      />,
    );
    // Every row inside the panel carries an inline-styled width.
    // We confirm the compliance (none) row's value-bar block paints
    // 0% by searching for the matching row.
    const complianceRowMatch = html.match(
      /data-slot="health-score-card-provenance-row"[^>]*data-component="compliance"[\s\S]*?width:\s*([0-9.]+%)/,
    );
    expect(complianceRowMatch).not.toBeNull();
    expect(complianceRowMatch?.[1]).toBe("0%");
  });

  it("forwards the asOf timestamp into the source-pill `title` tooltip", () => {
    const html = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={componentsAllPresent}
        delta={null}
        initiallyExpanded
      />,
    );
    // The BP row's pill carries the title formatted via Intl.DateTimeFormat;
    // we only need to confirm `as of` appears (the exact date depends on
    // the JS engine's locale data).
    expect(html).toContain("as of");
    // The data-as-of attribute carries the raw ISO timestamp.
    expect(html).toContain('data-as-of="2026-05-14T08:00:00.000Z"');
  });

  it("renders the footnote inside the expanded panel", () => {
    const html = ssr(
      <HealthScoreCard
        score={86}
        band="green"
        components={componentsAllPresent}
        delta={null}
        initiallyExpanded
      />,
    );
    expect(html).toContain(
      'data-slot="health-score-card-provenance-footnote"',
    );
  });
});
