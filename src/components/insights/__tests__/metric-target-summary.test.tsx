import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.8.0 → v1.8.5 — `<MetricTargetSummary>` unit tests.
 *
 * The panel surfaces the canonical "Target" tile header, the verbal
 * status pill, the guideline source, the 30-day average (BP only), the
 * range bar (whose axis labels carry the band endpoints) and the 7-day
 * consistency strip on each insights category page, reading the same
 * `/api/insights/targets` payload that powers `/targets`. The component
 * depends on `useAuth` (gate) and TanStack Query (`useQuery`) for the
 * payload, so both are mocked here and the assertions run through SSR —
 * the load-bearing behaviour is the header/bar/source rendering + the
 * slug→type mapping (including the blood-glucose per-context split + unit
 * conversion), not the live fetch.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: vi.fn(() => ({ isAuthenticated: true, user: null })),
}));

const useQueryMock = vi.fn();
// The inline <TargetEditSheet> (mounted by the panel once the
// adjust-target button is clicked) also pulls `useMutation` +
// `useQueryClient`, so stub those alongside `useQuery`.
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: unknown) => useQueryMock(opts),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const { MetricTargetSummary } = await import("../metric-target-summary");

interface TargetFixtureItem {
  type: string;
  label: string;
  current: number | null;
  average30: number | null;
  unit: string;
  range: { min: number; max: number } | null;
  classification: { category: string; color: string } | null;
  source: string;
  daysInRange7d: number;
  daysLogged7d: number;
  daysInRange30d: number;
  daysLogged30d: number;
  insufficientData: boolean;
  consistency7d: ReadonlyArray<"in" | "near" | "out" | null>;
}

interface TargetsFixture {
  targets: TargetFixtureItem[];
  bpDiastolic: {
    current: number | null;
    average30: number | null;
    range: { min: number; max: number } | null;
  };
  profile?: { glucoseUnit?: string | null };
}

function renderWith(slug: string, data: TargetsFixture | undefined) {
  useQueryMock.mockReturnValue({ data });
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MetricTargetSummary slug={slug} />
    </I18nProvider>,
  );
}

const WEIGHT_ITEM: TargetFixtureItem = {
  type: "WEIGHT",
  label: "Weight",
  current: 72,
  average30: 71.4,
  unit: "kg",
  range: { min: 60.1, max: 80.9 },
  classification: { category: "Normal", color: "#50fa7b" },
  source: "WHO BMI",
  daysInRange7d: 5,
  daysLogged7d: 7,
  daysInRange30d: 18,
  daysLogged30d: 24,
  insufficientData: false,
  consistency7d: ["in", "in", "near", "in", "out", "in", "in"],
};

const WEIGHT_DATA: TargetsFixture = {
  targets: [WEIGHT_ITEM],
  bpDiastolic: { current: null, average30: null, range: null },
};

const BP_DATA: TargetsFixture = {
  targets: [
    {
      type: "BLOOD_PRESSURE",
      label: "Blood pressure",
      current: 124,
      average30: 122,
      unit: "mmHg",
      range: { min: 120, max: 129 },
      classification: { category: "Optimal", color: "#50fa7b" },
      source: "ESH 2023",
      daysInRange7d: 3,
      daysLogged7d: 6,
      daysInRange30d: 10,
      daysLogged30d: 20,
      insufficientData: false,
      consistency7d: ["in", "near", "in", "out", "in", "near", "in"],
    },
  ],
  bpDiastolic: { current: 78, average30: 76, range: { min: 70, max: 79 } },
};

const GLUCOSE_DATA: TargetsFixture = {
  targets: [
    {
      type: "BLOOD_GLUCOSE_FASTING",
      label: "targets.glucoseFasting",
      current: 95,
      average30: 92,
      unit: "mg/dL",
      range: { min: 70, max: 100 },
      classification: { category: "Optimal", color: "#50fa7b" },
      source: "ADA 2024 / DDG",
      daysInRange7d: 4,
      daysLogged7d: 5,
      daysInRange30d: 12,
      daysLogged30d: 15,
      insufficientData: false,
      consistency7d: ["in", "in", "near", "in", "in", "in", "in"],
    },
    {
      type: "BLOOD_GLUCOSE_POSTPRANDIAL",
      label: "targets.glucosePostprandial",
      current: 140,
      average30: 138,
      unit: "mg/dL",
      range: { min: 70, max: 140 },
      classification: { category: "Optimal", color: "#50fa7b" },
      source: "ADA 2024 / DDG",
      daysInRange7d: 3,
      daysLogged7d: 4,
      daysInRange30d: 9,
      daysLogged30d: 12,
      insufficientData: false,
      consistency7d: ["in", "near", "in", "in", null, "in", "in"],
    },
  ],
  bpDiastolic: { current: null, average30: null, range: null },
  profile: { glucoseUnit: "mg/dL" },
};

describe("<MetricTargetSummary>", () => {
  it("renders the canonical Target tile header and the band endpoints on the bar", () => {
    const html = renderWith("weight", WEIGHT_DATA);
    // v1.12.6 — the heading is the single-word canonical `<TileHeader>`;
    // the band numbers live on the range bar's axis labels rather than a
    // redundant "Target: 60.1–80.9 kg" string above it.
    expect(html).toContain('data-slot="tile-header"');
    expect(html).toContain("Target");
    // 2026-07-17 a11y audit (M1) — the range-bar marker now carries an
    // `aria-label` that reuses this same string as a text alternative
    // (screen-reader only, not a rendered heading) — strip attribute
    // values before asserting no redundant VISIBLE "Target: …" text node
    // exists above the bar.
    const visibleText = html.replace(/aria-label="[^"]*"/g, "");
    expect(visibleText).not.toContain("Target: 60.1–80.9 kg");
    // The min / max endpoints surface as the range-bar axis labels.
    expect(html).toContain("60.1 kg");
    expect(html).toContain("80.9 kg");
    // v1.12.0 — the in-target share moved up to `<MetricPrimaryTile>`,
    // the canonical home for the headline + 30-day average + in-range
    // bar. The band-reference panel no longer repeats it for non-BP
    // metrics.
    expect(html).not.toContain("of logged days within target");
  });

  it("renders the verbal status pill + the guideline source", () => {
    const html = renderWith("weight", WEIGHT_DATA);
    expect(html).toContain('data-slot="target-status-pill"');
    // EN label for the "Normal" classification category.
    expect(html).toContain("Normal");
    // Source citation + external-link.
    expect(html).toContain("Source: WHO BMI");
    // The WHO obesity fact-sheet URL resolves for WEIGHT.
    expect(html).toContain(
      "who.int/news-room/fact-sheets/detail/obesity-and-overweight",
    );
  });

  it("renders the range bar + the consistency strip", () => {
    const html = renderWith("weight", WEIGHT_DATA);
    expect(html).toContain('data-slot="target-range-bar"');
    expect(html).toContain('data-slot="consistency-strip"');
    // v1.12.0 — the 30-day average moved up to `<MetricPrimaryTile>` for
    // every metric except blood pressure (whose richer panel IS its
    // primary tile and keeps the stitched S/D average inline).
    expect(html).not.toContain("30-day average: 71.4 kg");
  });

  it("renders the systolic + diastolic bands for blood pressure", () => {
    const html = renderWith("blood-pressure", BP_DATA);
    // v1.12.6 — the stitched "Target: 120–129 / 70–79 mmHg" string is gone;
    // the canonical "Target" header leads and each band's endpoints surface
    // on its own range bar.
    expect(html).toContain('data-slot="tile-header"');
    expect(html).not.toContain("Target: 120–129 / 70–79 mmHg");
    // v1.12.0 — the in-target share moved up to the primary tile; the BP
    // panel keeps only the stitched 30-day average inline.
    expect(html).not.toContain("of logged days within target");
    // The diastolic range bar renders alongside the systolic one.
    const barCount = (html.match(/data-slot="target-range-bar"/g) ?? []).length;
    expect(barCount).toBe(2);
    // 30-day average stitches the diastolic pair — kept on the BP panel.
    expect(html).toContain("30-day average: 122/76 mmHg");
  });

  it("keeps the adjust-target affordance out of the card body", () => {
    // The "Adjust target range" affordance moved to the page-header gear
    // (`<TargetAdjustButton>` via `TargetAdjustProvider`); the card is now
    // a read surface, so neither the old in-card button nor a /targets
    // route link appears in its markup.
    const html = renderWith("weight", WEIGHT_DATA);
    expect(html).not.toContain('data-slot="metric-target-adjust"');
    expect(html).not.toContain('href="/targets"');
  });

  it("does not mount the target editor inside the card", () => {
    // The editor sheet is owned by the provider, opened from the header
    // gear — never mounted by the card itself.
    const html = renderWith("weight", WEIGHT_DATA);
    expect(html).not.toContain('data-slot="target-edit-sheet"');
  });

  it("suppresses the share + strip when the route flags insufficient data", () => {
    const html = renderWith("weight", {
      ...WEIGHT_DATA,
      targets: [{ ...WEIGHT_ITEM, insufficientData: true }],
    });
    // v1.12.6 — the canonical Target header still renders; the share +
    // consistency strip suppress on insufficient data.
    expect(html).toContain('data-slot="tile-header"');
    expect(html).not.toContain("of logged days within target");
    expect(html).not.toContain('data-slot="consistency-strip"');
  });

  it("renders nothing for a slug without a numeric target", () => {
    const html = renderWith("hrv", undefined);
    expect(html).toBe("");
  });

  it("renders nothing before the payload resolves", () => {
    const html = renderWith("weight", undefined);
    expect(html).toBe("");
  });

  it("renders nothing when the matching target has no range", () => {
    const html = renderWith("weight", {
      ...WEIGHT_DATA,
      targets: [{ ...WEIGHT_ITEM, range: null }],
    });
    expect(html).toBe("");
  });

  describe("blood-glucose per-context split", () => {
    it("renders one panel per logged glucose context in mg/dL", () => {
      const html = renderWith("blood-glucose", GLUCOSE_DATA);
      const panelCount = (
        html.match(/data-slot="metric-target-summary"/g) ?? []
      ).length;
      expect(panelCount).toBe(2);
      // v1.12.6 — the per-context band numbers live on each panel's range
      // bar (the redundant "Target: 70–100 mg/dL" string was removed). The
      // mg/dL display unit keeps the canonical values unchanged.
      expect(html).toContain("70 mg/dL");
      expect(html).toContain("100 mg/dL");
      expect(html).toContain("140 mg/dL");
      // ADA / DDG source surfaces for each panel.
      expect(html).toContain("Source: ADA 2024 / DDG");
      // The i18n label keys resolve to EN context headings (rendered
      // upper-cased by the heading style but kept as text content).
      expect(html).toContain("Glucose (fasting)");
      expect(html).toContain("Glucose (post-meal)");
    });

    it("converts the glucose bands to mmol/L when the profile prefers it", () => {
      const html = renderWith("blood-glucose", {
        ...GLUCOSE_DATA,
        profile: { glucoseUnit: "mmol/L" },
      });
      // 70 mg/dL → 3.9, 100 mg/dL → 5.5, 140 mg/dL → 7.8 mmol/L
      // (the /targets converter rounds to one decimal). v1.12.6 — the
      // converted endpoints surface on the range bar, not a "Target: …"
      // string.
      expect(html).toContain("3.9 mmol/L");
      expect(html).toContain("5.5 mmol/L");
      expect(html).toContain("7.8 mmol/L");
    });

    it("renders nothing when no glucose context has a band", () => {
      const html = renderWith("blood-glucose", {
        targets: [],
        bpDiastolic: { current: null, average30: null, range: null },
        profile: { glucoseUnit: "mg/dL" },
      });
      expect(html).toBe("");
    });
  });
});
