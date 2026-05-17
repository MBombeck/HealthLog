import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

// `usePathname` is consulted to mark the active pill; SSR has no
// Next.js router, so we stub it.
vi.mock("next/navigation", () => ({
  usePathname: () => "/insights",
}));

// `toast` is consulted from a falling-edge effect; renderToStaticMarkup
// doesn't fire effects, but we stub it for completeness.
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

import { InsightsTabStrip } from "../insights-tab-strip";
import type { InsightInputs } from "@/lib/insights/metric-availability";
import type { DataSummary } from "@/lib/analytics/trends";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

function fakeSummary(count: number): DataSummary {
  return {
    count,
    latest: count > 0 ? 1 : null,
    min: null,
    max: null,
    mean: null,
    avg7: null,
    avg30: null,
    slope7: null,
    slope30: null,
    slope90: null,
    anomalyCount: 0,
  };
}

describe("<InsightsTabStrip> — availability gating (v1.4.27 F19)", () => {
  it("renders only the Overview pill when availability is omitted (v1.4.36 W4d strict gate)", () => {
    // v1.4.36 W4d — the pre-v1.4.36 fallback used to render every
    // metric pill while the analytics fetch was in flight. Users with
    // zero observations on a metric briefly saw nav targets they
    // couldn't act on, and on a failed fetch the pills stayed up
    // forever. The strict gate flips the contract: no availability =>
    // only Overview, then pills light up as data arrives.
    const html = render(<InsightsTabStrip />);
    expect(html).toContain(">Overview<");
    expect(html).not.toContain(">Blood Pressure<");
    expect(html).not.toContain(">Weight<");
    expect(html).not.toContain(">Pulse<");
    expect(html).not.toContain(">Mood<");
    expect(html).not.toContain(">Medication<");
    expect(html).not.toContain(">BMI<");
    expect(html).not.toContain(">Sleep<");
  });

  it("drops pills for metrics with zero observations", () => {
    const availability: InsightInputs = {
      summaries: {
        PULSE: fakeSummary(5),
        WEIGHT: fakeSummary(3),
      },
      hasMood: false,
      hasMedication: false,
    };
    const html = render(<InsightsTabStrip availability={availability} />);
    // Pills that have data stay.
    expect(html).toContain(">Pulse<");
    expect(html).toContain(">Weight<");
    expect(html).toContain(">BMI<");
    // Pills without data drop.
    expect(html).not.toContain(">Blood Pressure<");
    expect(html).not.toContain(">Mood<");
    expect(html).not.toContain(">Medication<");
    expect(html).not.toContain(">Sleep<");
    // v1.4.34 IW-D — the parent "Vitals" pill stays out when no
    // wave-A HealthKit metric has data (none in this availability).
    expect(html).not.toContain(">Vitals<");
  });

  it("keeps the overview pill regardless of availability", () => {
    const availability: InsightInputs = {
      summaries: {},
      hasMood: false,
      hasMedication: false,
    };
    const html = render(<InsightsTabStrip availability={availability} />);
    expect(html).toContain(">Overview<");
  });

  it("lights up Mood when hasMood flips to true", () => {
    const availability: InsightInputs = {
      summaries: {},
      hasMood: true,
      hasMedication: false,
    };
    const html = render(<InsightsTabStrip availability={availability} />);
    expect(html).toContain(">Mood<");
    expect(html).not.toContain(">Medication<");
  });

  it("lights up Medication when hasMedication flips to true", () => {
    const availability: InsightInputs = {
      summaries: {},
      hasMood: false,
      hasMedication: true,
    };
    const html = render(<InsightsTabStrip availability={availability} />);
    expect(html).toContain(">Medication<");
    expect(html).not.toContain(">Mood<");
  });

  it("derives BMI from WEIGHT count", () => {
    const availability: InsightInputs = {
      summaries: { WEIGHT: fakeSummary(2) },
      hasMood: false,
      hasMedication: false,
    };
    const html = render(<InsightsTabStrip availability={availability} />);
    expect(html).toContain(">Weight<");
    expect(html).toContain(">BMI<");
  });
});

describe("<InsightsTabStrip> — vitals group collapse (v1.4.34 IW-D)", () => {
  // v1.4.36 W4d — strict gate: every test here passes an explicit
  // `availability` that lights up the wave-A metrics so the popover
  // parent pill renders. Pre-v1.4.36 the no-availability fallback
  // lit up every pill by default; under the strict gate the same
  // intent is expressed by passing the right summaries.
  const fullAvailability: InsightInputs = {
    summaries: {
      BLOOD_PRESSURE_SYS: fakeSummary(5),
      BLOOD_PRESSURE_DIA: fakeSummary(5),
      PULSE: fakeSummary(5),
      WEIGHT: fakeSummary(5),
      SLEEP_DURATION: fakeSummary(5),
      VO2_MAX: fakeSummary(5),
      STEPS: fakeSummary(5),
      ACTIVE_ENERGY: fakeSummary(5),
      ACTIVE_ENERGY_BURNED: fakeSummary(5),
      HEART_RATE_VARIABILITY: fakeSummary(5),
      RESTING_HEART_RATE: fakeSummary(5),
      OXYGEN_SATURATION: fakeSummary(5),
      BODY_TEMPERATURE: fakeSummary(5),
    },
    hasMood: true,
    hasMedication: true,
    hasWorkouts: true,
  };

  it("renders a single 'Vitals' parent pill instead of five wave-A pills in the strip row", () => {
    // Every wave-A pill has data ⇒ the parent pill appears once. The
    // five sub-pages still render in the popover body but that lives
    // in a Radix Portal which `renderToStaticMarkup` does not serialise
    // (no portal target in SSR) — so we assert on the strip-row only.
    // Behaviour test for the popover body sits in a Playwright spec
    // when the dev server runs.
    const html = render(<InsightsTabStrip availability={fullAvailability} />);
    // Parent pill — there is exactly one.
    const parentMatches = html.match(/>Vitals</g);
    expect(parentMatches).not.toBeNull();
    expect(parentMatches!.length).toBe(1);
    // The flat strip-row should NOT carry the five individual labels —
    // they live behind the parent pill now.
    expect(html).not.toContain(">HRV<");
    expect(html).not.toContain(">Resting HR<");
    expect(html).not.toContain(">Oxygen<");
    expect(html).not.toContain(">Temperature<");
    // "Active energy" overlaps with no other label in en/de so we can
    // assert the exact match.
    expect(html).not.toContain(">Active energy<");
  });

  it("hides the parent pill when no wave-A metric has data", () => {
    const availability: InsightInputs = {
      summaries: { WEIGHT: fakeSummary(2) },
      hasMood: false,
      hasMedication: false,
    };
    const html = render(<InsightsTabStrip availability={availability} />);
    expect(html).not.toContain(">Vitals<");
    expect(html).not.toContain('data-slot="insights-tab-strip-group"');
  });

  it("renders the parent pill as a popover trigger (button, not link)", () => {
    const html = render(<InsightsTabStrip availability={fullAvailability} />);
    expect(html).toContain('data-slot="insights-tab-strip-group"');
    expect(html).toContain('data-group="vitals"');
  });

  it("preserves the non-grouped pills inline", () => {
    const html = render(<InsightsTabStrip availability={fullAvailability} />);
    // Flat (non-grouped) pills must still be reachable directly.
    expect(html).toContain(">Blood Pressure<");
    expect(html).toContain(">Pulse<");
    expect(html).toContain(">Weight<");
    expect(html).toContain(">BMI<");
    expect(html).toContain(">Sleep<");
    expect(html).toContain(">Mood<");
    expect(html).toContain(">Medication<");
    expect(html).toContain(">Workouts<");
  });
});
