import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { computeGlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import type { DataSummary } from "@/lib/analytics/trends";
import { GlucoseTirBar } from "../glucose-tir-bar";
import { GlucoseAdvancedDisclosure } from "../glucose-advanced-disclosure";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

/** Minimal valid `DataSummary` — the panel + disclosure only read `count`. */
function summary(count: number): DataSummary {
  return {
    count,
    latest: 95,
    min: 60,
    max: 140,
    mean: 100,
    median: 98,
    avg7: null,
    avg30: null,
    slope7: null,
    slope30: null,
    anomalyCount: 0,
  };
}

/**
 * v1.17.0 — glucose clinical panel render tests.
 *
 * Covers the two states the maintainer called out: the calm "still learning"
 * branch (no asserted TIR / GMI off thin spot data) and the asserted branch
 * with the advanced progressive disclosure. The panel leans on `useAuth` +
 * `useAnalyticsQuery`; both are mocked so the branch under test is
 * deterministic. The TIR bar + advanced disclosure are pure props, tested
 * directly.
 */

const authMock = vi.fn();
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => authMock(),
}));

const analyticsMock = vi.fn();
vi.mock("@/lib/queries/use-analytics-query", () => ({
  useAnalyticsQuery: () => analyticsMock(),
}));

// Import after the mocks are registered.
const { GlucoseClinicalPanel } = await import("../glucose-clinical-panel");

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const NOW = new Date("2026-06-14T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  authMock.mockReturnValue({
    user: { glucoseUnit: "mg/dL" },
    isAuthenticated: true,
  });
  analyticsMock.mockReset();
});

describe("<GlucoseClinicalPanel> learning state", () => {
  it("renders the calm still-learning copy and asserts NO TIR/GMI", () => {
    // 5 readings over 4 days — below the 14-reading default floor.
    const readings = [100, 110, 120, 130, 140].map((mgdl, i) => ({
      measuredAt: new Date(NOW.getTime() - (4 - i) * DAY),
      mgdl,
    }));
    const glucoseClinical = computeGlucoseClinicalMetrics(readings, {
      now: NOW,
    });
    expect(glucoseClinical.stillLearning).toBe(true);

    analyticsMock.mockReturnValue({
      isLoading: false,
      data: { glucoseClinical, glucoseByContext: {} },
    });

    const html = render(<GlucoseClinicalPanel />);
    expect(html).toContain('data-state="learning"');
    expect(html).toContain("Still learning your glucose");
    // the asserted blocks must NOT be present in the learning state
    expect(html).not.toContain('data-slot="glucose-tir-bar"');
    expect(html).not.toContain("Glucose Management Indicator");
    // the spot-reading caveat is always carried
    expect(html).toContain("spot-reading estimates");
  });

  it("renders the empty learning copy when there are zero readings", () => {
    const glucoseClinical = computeGlucoseClinicalMetrics([], { now: NOW });
    analyticsMock.mockReturnValue({
      isLoading: false,
      data: { glucoseClinical, glucoseByContext: {} },
    });
    const html = render(<GlucoseClinicalPanel />);
    expect(html).toContain('data-state="learning"');
    expect(html).toContain("Once a handful of readings come in");
  });
});

describe("<GlucoseClinicalPanel> asserted state", () => {
  function assertedClinical() {
    // 20 readings, one per day → clears the gate; a spread that lands in all
    // three TIR bands so the bar has real segments and CV% is non-trivial.
    const values = [
      60, 90, 120, 150, 180, 200, 100, 110, 95, 130, 170, 220, 80, 140, 160,
      105, 115, 125, 135, 145,
    ];
    const readings = values.map((mgdl, i) => ({
      measuredAt: new Date(NOW.getTime() - (values.length - 1 - i) * DAY),
      mgdl,
    }));
    return computeGlucoseClinicalMetrics(readings, {
      now: NOW,
      windowDays: 30,
    });
  }

  it("renders TIR bar, GMI, eA1C, a CV badge, and the advanced disclosure", () => {
    const glucoseClinical = assertedClinical();
    expect(glucoseClinical.stillLearning).toBe(false);

    analyticsMock.mockReturnValue({
      isLoading: false,
      data: {
        glucoseClinical,
        glucoseByContext: {
          FASTING: summary(8),
        },
      },
    });

    const html = render(<GlucoseClinicalPanel />);
    expect(html).toContain('data-state="asserted"');
    expect(html).toContain('data-slot="glucose-tir-bar"');
    expect(html).toContain("Glucose Management Indicator");
    expect(html).toContain("Estimated A1C");
    expect(html).toContain('data-slot="glucose-cv-badge"');
    // advanced disclosure trigger is present (region collapsed by default in SSR)
    expect(html).toContain('data-slot="glucose-advanced-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("J-index");
  });

  it("states the target band in the reader's unit and number format", () => {
    // The caption used to print "70–180 mg/dL" to every reader, beside
    // values the panel had already converted to mmol/L.
    authMock.mockReturnValue({
      user: { glucoseUnit: "mmol/L" },
      isAuthenticated: true,
    });
    analyticsMock.mockReturnValue({
      isLoading: false,
      data: { glucoseClinical: assertedClinical(), glucoseByContext: {} },
    });
    const de = render(<GlucoseClinicalPanel />, "de");
    expect(de).toContain("(3,9–10,0\u00a0mmol/L ist das Ziel)");
    expect(de).not.toMatch(/mg\/dl/i);
    // Mean, GMI and eA1C read with the German decimal comma.
    expect(de).not.toMatch(/>\d+\.\d+</);
    expect(de).toMatch(
      />\d+,\d<\/span><span class="text-muted-foreground text-xs">mmol\/L/,
    );

    authMock.mockReturnValue({
      user: { glucoseUnit: "mg/dL" },
      isAuthenticated: true,
    });
    expect(render(<GlucoseClinicalPanel />)).toContain(
      "(70–180\u00a0mg/dL is the target)",
    );
  });

  it("flags the CV badge unstable at CV% >= 36", () => {
    // wide spread → CV well above 36
    const values = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? 60 : 260,
    );
    const readings = values.map((mgdl, i) => ({
      measuredAt: new Date(NOW.getTime() - (values.length - 1 - i) * DAY),
      mgdl,
    }));
    const glucoseClinical = computeGlucoseClinicalMetrics(readings, {
      now: NOW,
      windowDays: 30,
    });
    expect(glucoseClinical.variability?.unstable).toBe(true);

    analyticsMock.mockReturnValue({
      isLoading: false,
      data: { glucoseClinical, glucoseByContext: {} },
    });
    const html = render(<GlucoseClinicalPanel />);
    expect(html).toContain('data-unstable="true"');
    expect(html).toContain("Unstable");
  });

  it("renders nothing when the thick slice carries no glucoseClinical", () => {
    analyticsMock.mockReturnValue({
      isLoading: false,
      data: { summaries: {} },
    });
    const html = render(<GlucoseClinicalPanel />);
    expect(html).toBe("");
  });
});

describe("<GlucoseTirBar>", () => {
  it("renders one segment per non-empty Battelino band summing to 100%", () => {
    const dist = computeGlucoseClinicalMetrics(
      [40, 60, 120, 200, 300].map((mgdl, i) => ({
        measuredAt: new Date(NOW.getTime() - i * DAY),
        mgdl,
      })),
      { now: NOW, minReadings: 1, minSpanDays: 1 },
    ).distribution!;
    const html = render(<GlucoseTirBar distribution={dist} />);
    // very-low (40), low (60), in-range (120), high (200), very-high (300)
    expect(html).toContain("glucose-tir-segment-veryLow");
    expect(html).toContain("glucose-tir-segment-low");
    expect(html).toContain("glucose-tir-segment-inRange");
    expect(html).toContain("glucose-tir-segment-high");
    expect(html).toContain("glucose-tir-segment-veryHigh");
    // aria summary present
    expect(html).toContain('role="img"');
  });
});

describe("<GlucoseAdvancedDisclosure>", () => {
  it("is collapsed by default and exposes a toggle + the three indices", () => {
    const html = render(
      <GlucoseAdvancedDisclosure
        advanced={{ jIndex: 23.7, lbgi: 1.2, hbgi: 6.8 }}
        byContext={{
          FASTING: summary(1),
        }}
      />,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("hidden"); // region hidden in initial SSR state
    expect(html).toContain("J-index");
    expect(html).toContain("LBGI");
    expect(html).toContain("HBGI");
    // singular reading label for a single-reading context
    expect(html).toContain("1 reading");
  });
});
