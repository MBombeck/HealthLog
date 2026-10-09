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
import { DEFAULT_INSIGHTS_LAYOUT } from "@/lib/insights-layout";

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
    median: null,
    avg7: null,
    avg30: null,
    slope7: null,
    slope30: null,
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
    expect(html).not.toContain(">Blood pressure<");
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
    // Pills that have data stay — pulse and bmi surface through their
    // Heart / Body groups (2026-07-17 UX/IA audit M1).
    expect(html).toContain('data-group="heart"');
    expect(html).toContain(">Weight<");
    expect(html).toContain('data-group="body"');
    // Pills without data drop.
    expect(html).not.toContain(">Blood pressure<");
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

  it("always renders the Recovery pill (composite wearable surface, self-gated page)", () => {
    // v1.18.0 — Recovery left the left-nav for an Insights pill. It is a
    // composite WHOOP / Polar / Oura surface, not a single MeasurementType,
    // so it has no `summaries[METRIC].count` to gate on; the page itself
    // data-gates each block and falls back to a calm empty note, so the
    // pill is always present (like Overview) regardless of availability.
    const noAvailability = render(<InsightsTabStrip />);
    expect(noAvailability).toContain(">Recovery<");
    expect(noAvailability).toContain('href="/insights/recovery"');

    const emptyAvailability: InsightInputs = {
      summaries: {},
      hasMood: false,
      hasMedication: false,
    };
    const html = render(<InsightsTabStrip availability={emptyAvailability} />);
    expect(html).toContain(">Recovery<");
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
    // bmi surfaces through the Body group (2026-07-17 UX/IA audit M1).
    expect(html).toContain('data-group="body"');
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

  // Steps live behind the "Activity" parent pill (the activity cluster).
  // A regression had Steps absent from the metric registry entirely, so
  // step data never surfaced the Activity group in Insights nav even
  // though the dashboard tile read `summaries.ACTIVITY_STEPS`. This pins
  // that ACTIVITY_STEPS data lights up the Activity parent pill.
  it("surfaces the Activity parent pill when only ACTIVITY_STEPS has data", () => {
    const availability: InsightInputs = {
      summaries: { ACTIVITY_STEPS: fakeSummary(4200) },
      hasMood: false,
      hasMedication: false,
    };
    const html = render(<InsightsTabStrip availability={availability} />);
    expect(html).toContain('data-group="activity"');
    expect(html).toContain(">Activity<");
  });

  it("hides the parent pill when no wave-A metric has data", () => {
    const availability: InsightInputs = {
      summaries: { WEIGHT: fakeSummary(2) },
      hasMood: false,
      hasMedication: false,
    };
    const html = render(<InsightsTabStrip availability={availability} />);
    expect(html).not.toContain(">Vitals<");
    expect(html).not.toContain('data-group="vitals"');
  });

  it("renders the parent pill as a popover trigger (button, not link)", () => {
    const html = render(<InsightsTabStrip availability={fullAvailability} />);
    expect(html).toContain('data-slot="insights-tab-strip-group"');
    expect(html).toContain('data-group="vitals"');
  });

  it("preserves the pinned flat pills inline", () => {
    const html = render(<InsightsTabStrip availability={fullAvailability} />);
    // Pinned pills must still be reachable directly.
    expect(html).toContain(">Blood pressure<");
    expect(html).toContain(">Weight<");
    expect(html).toContain(">Sleep<");
    expect(html).toContain(">Mood<");
    expect(html).toContain(">Medication<");
  });
});

describe("<InsightsTabStrip> — heart group collapse (2026-07-17 UX/IA audit H2)", () => {
  // Pulse, resting HR, HRV and cardio recovery used to be scattered across
  // a flat "Pulse" pill and the "Vitals" popover; they now share one
  // "Heart" group. Blood pressure stays pinned flat (see the pinned-pills
  // test above).
  const heartAvailability: InsightInputs = {
    summaries: {
      PULSE: fakeSummary(5),
      HEART_RATE_VARIABILITY: fakeSummary(5),
      RESTING_HEART_RATE: fakeSummary(5),
      CARDIO_RECOVERY: fakeSummary(5),
    },
    hasMood: false,
    hasMedication: false,
  };

  it("renders a single 'Heart' parent pill instead of flat Pulse / HRV / Resting HR / Cardio recovery pills", () => {
    const html = render(<InsightsTabStrip availability={heartAvailability} />);
    const parentMatches = html.match(/>Heart</g);
    expect(parentMatches).not.toBeNull();
    expect(parentMatches!.length).toBe(1);
    expect(html).toContain('data-group="heart"');
    expect(html).not.toContain(">Pulse<");
    expect(html).not.toContain(">HRV<");
    expect(html).not.toContain(">Resting HR<");
    expect(html).not.toContain(">Cardio Recovery<");
  });

  it("hides the Heart parent pill when no heart metric has data", () => {
    const availability: InsightInputs = {
      summaries: { WEIGHT: fakeSummary(2) },
      hasMood: false,
      hasMedication: false,
    };
    const html = render(<InsightsTabStrip availability={availability} />);
    expect(html).not.toContain(">Heart<");
    expect(html).not.toContain('data-group="heart"');
  });
});

describe("<InsightsTabStrip> — bmi / workouts collapse into their groups (2026-07-17 UX/IA audit M1)", () => {
  it("bmi renders inside the 'Body' popover, not as a flat pill", () => {
    const availability: InsightInputs = {
      summaries: { WEIGHT: fakeSummary(5) },
      hasMood: false,
      hasMedication: false,
    };
    const html = render(<InsightsTabStrip availability={availability} />);
    expect(html).toContain(">Weight<");
    expect(html).not.toContain(">BMI<");
    expect(html).toContain('data-group="body"');
  });

  it("workouts renders inside the 'Activity' popover, not as a flat pill", () => {
    const availability: InsightInputs = {
      summaries: {},
      hasMood: false,
      hasMedication: false,
      hasWorkouts: true,
    };
    const html = render(<InsightsTabStrip availability={availability} />);
    expect(html).not.toContain(">Workouts<");
    expect(html).toContain('data-group="activity"');
  });
});

describe("<InsightsTabStrip> — saved-layout visibility gate (v1.15.14 W2)", () => {
  const dataAvailability: InsightInputs = {
    summaries: {
      PULSE: fakeSummary(5),
      WEIGHT: fakeSummary(3),
    },
    hasMood: false,
    hasMedication: false,
  };

  it("hides a pill whose slug is layout-hidden even though it has data", () => {
    // `pulse` has data but is NOT in the visible set ⇒ its Heart group
    // never emits. `weight` has data AND is visible ⇒ pill shows. `bmi`
    // has data (derived from WEIGHT) AND is visible ⇒ its Body group
    // emits (2026-07-17 UX/IA audit M1 — bmi collapsed out of the flat row).
    const visibleTileIds = new Set(["overview", "weight", "bmi"]);
    const html = render(
      <InsightsTabStrip
        availability={dataAvailability}
        visibleTileIds={visibleTileIds}
      />,
    );
    expect(html).toContain(">Weight<");
    expect(html).toContain('data-group="body"');
    expect(html).not.toContain('data-group="heart"');
  });

  it("shows a group parent pill when its slug is layout-visible AND has data", () => {
    const visibleTileIds = new Set(["overview", "pulse", "weight", "bmi"]);
    const html = render(
      <InsightsTabStrip
        availability={dataAvailability}
        visibleTileIds={visibleTileIds}
      />,
    );
    expect(html).toContain('data-group="heart"');
    expect(html).toContain(">Weight<");
  });

  it("keeps data-availability as the FLOOR — a layout-visible metric with zero data stays hidden", () => {
    // `blood-pressure` is layout-visible but has no data ⇒ still no pill.
    const visibleTileIds = new Set([
      "overview",
      "blood-pressure",
      "weight",
      "bmi",
    ]);
    const html = render(
      <InsightsTabStrip
        availability={dataAvailability}
        visibleTileIds={visibleTileIds}
      />,
    );
    expect(html).not.toContain(">Blood pressure<");
    expect(html).toContain(">Weight<");
  });

  it("falls back to the data-only gate when no layout is loaded (visibleTileIds undefined)", () => {
    // No visibleTileIds prop ⇒ pre-W2 behaviour: every data-having pill shows.
    const html = render(<InsightsTabStrip availability={dataAvailability} />);
    expect(html).toContain('data-group="heart"');
    expect(html).toContain(">Weight<");
    expect(html).toContain('data-group="body"');
  });

  it("always shows the Overview pill regardless of layout visibility", () => {
    const visibleTileIds = new Set<string>(); // nothing visible
    const html = render(
      <InsightsTabStrip
        availability={dataAvailability}
        visibleTileIds={visibleTileIds}
      />,
    );
    expect(html).toContain(">Overview<");
    expect(html).not.toContain('data-group="heart"');
    expect(html).not.toContain(">Weight<");
  });

  it("hides a group parent pill when every child is layout-hidden", () => {
    // Activity group: ACTIVITY_STEPS has data, but `steps` is not visible.
    const availability: InsightInputs = {
      summaries: { ACTIVITY_STEPS: fakeSummary(4200) },
      hasMood: false,
      hasMedication: false,
    };
    const visibleTileIds = new Set(["overview"]); // steps hidden
    const html = render(
      <InsightsTabStrip
        availability={availability}
        visibleTileIds={visibleTileIds}
      />,
    );
    expect(html).not.toContain('data-group="activity"');
    expect(html).not.toContain(">Activity<");
  });

  it("shows a group parent pill when at least one child is visible + has data", () => {
    const availability: InsightInputs = {
      summaries: { ACTIVITY_STEPS: fakeSummary(4200) },
      hasMood: false,
      hasMedication: false,
    };
    const visibleTileIds = new Set(["overview", "steps"]);
    const html = render(
      <InsightsTabStrip
        availability={availability}
        visibleTileIds={visibleTileIds}
      />,
    );
    expect(html).toContain('data-group="activity"');
    expect(html).toContain(">Activity<");
  });

  // v1.15.14 — regression guard: the DEFAULT layout's visible set must equal
  // the data-only nav set. The v1.15.11 curated default dropped ~20 pills once
  // the strip began gating on the layout; making the default all-visible
  // restores everything-with-data. Derive `visibleTileIds` straight from
  // `DEFAULT_INSIGHTS_LAYOUT` (what a fresh / never-customized account
  // resolves to) and assert the long-tail pills + group parents still show
  // when their data is present.
  it("default layout shows every data-having pill (nav-pill regression guard)", () => {
    const visibleTileIds = new Set(
      DEFAULT_INSIGHTS_LAYOUT.tiles.filter((t) => t.visible).map((t) => t.id),
    );
    const availability: InsightInputs = {
      summaries: {
        SLEEP_DURATION: fakeSummary(20),
        ACTIVITY_STEPS: fakeSummary(4200),
        ACTIVE_ENERGY_BURNED: fakeSummary(30),
        FAT_MASS: fakeSummary(12),
        MUSCLE_MASS: fakeSummary(12),
        AUDIO_EXPOSURE_ENV: fakeSummary(40),
        TIME_IN_DAYLIGHT: fakeSummary(15),
      },
      hasMood: false,
      hasMedication: false,
    };
    const html = render(
      <InsightsTabStrip
        availability={availability}
        visibleTileIds={visibleTileIds}
      />,
    );
    // Flat pill that previously regressed out of the default nav.
    expect(html).toContain(">Sleep<");
    // Group parents that the curated default suppressed: Activity (steps /
    // active-energy), Body (fat-mass / muscle-mass), Hearing (audio),
    // Environment (daylight).
    expect(html).toContain('data-group="activity"');
    expect(html).toContain(">Activity<");
    expect(html).toContain('data-group="body"');
    expect(html).toContain(">Body<");
    expect(html).toContain('data-group="hearing"');
    expect(html).toContain(">Hearing<");
    expect(html).toContain('data-group="environment"');
    expect(html).toContain(">Environment<");
  });
});

describe("<InsightsTabStrip> — module enable/disable gate (v1.18.0)", () => {
  // A pill belonging to a toggleable module (mood / sleep / glucose /
  // workouts) is hidden when that module is disabled in the account's
  // resolved module map — on TOP of the data + layout gates. Core metric
  // pills (BP, pulse, weight, BMI …) carry no module key and ignore it —
  // pulse and bmi now surface through their Heart / Body group instead of
  // a flat pill, but the module gate still never touches them.
  const moduleAvailability: InsightInputs = {
    summaries: {
      PULSE: fakeSummary(5),
      WEIGHT: fakeSummary(3),
      SLEEP_DURATION: fakeSummary(8),
      BLOOD_GLUCOSE: fakeSummary(6),
    },
    hasMood: true,
    hasMedication: false,
    hasWorkouts: true,
  };

  it("hides the Mood / Sleep / Activity(workouts) pills/groups + the glucose (Metabolic) group when their modules are disabled", () => {
    // `blood-glucose` is the sole metabolic metric with data here, so its
    // module gate collapses the whole "Metabolic" group parent pill —
    // mood / sleep are flat pills that drop directly; workouts is the
    // sole Activity-group member here, so disabling it collapses Activity.
    const html = render(
      <InsightsTabStrip
        availability={moduleAvailability}
        modules={{
          mood: false,
          sleep: false,
          glucose: false,
          workouts: false,
        }}
      />,
    );
    expect(html).not.toContain(">Mood<");
    expect(html).not.toContain(">Sleep<");
    expect(html).not.toContain('data-group="activity"');
    expect(html).not.toContain('data-group="metabolic"');
    // Core metric pills are unaffected by the module map — pulse and bmi
    // carry no module key and still surface through their Heart / Body
    // groups (2026-07-17 UX/IA audit — both collapsed out of the flat row).
    expect(html).toContain('data-group="heart"');
    expect(html).toContain(">Weight<");
    expect(html).toContain('data-group="body"');
    expect(html).toContain(">Overview<");
  });

  it("shows the module pills + the glucose (Metabolic) group when their modules are enabled", () => {
    const html = render(
      <InsightsTabStrip
        availability={moduleAvailability}
        modules={{
          mood: true,
          sleep: true,
          glucose: true,
          workouts: true,
        }}
      />,
    );
    expect(html).toContain(">Mood<");
    expect(html).toContain(">Sleep<");
    // Workouts collapses into the Activity group (2026-07-17 UX/IA audit M1).
    expect(html).toContain('data-group="activity"');
    expect(html).toContain('data-group="metabolic"');
  });

  it("hides the Recovery pill when the recovery module is disabled, keeps it when enabled", () => {
    const disabled = render(<InsightsTabStrip modules={{ recovery: false }} />);
    expect(disabled).not.toContain(">Recovery<");
    expect(disabled).not.toContain('href="/insights/recovery"');
    // Overview still anchors the strip.
    expect(disabled).toContain(">Overview<");

    const enabled = render(<InsightsTabStrip modules={{ recovery: true }} />);
    expect(enabled).toContain(">Recovery<");
    expect(enabled).toContain('href="/insights/recovery"');
  });

  it("hides the Medications pill with the medications module off", () => {
    const withMeds: InsightInputs = {
      ...moduleAvailability,
      hasMedication: true,
    };
    const on = render(
      <InsightsTabStrip
        availability={withMeds}
        modules={{ medications: true }}
      />,
    );
    expect(on).toContain('href="/insights/medications"');
    const off = render(
      <InsightsTabStrip
        availability={withMeds}
        modules={{ medications: false }}
      />,
    );
    expect(off).not.toContain('href="/insights/medications"');
    expect(off).toContain(">Overview<");
  });

  it("fails open: an empty / omitted module map keeps every module pill", () => {
    // Default-on contract — a stale /me payload (no module map) must not
    // blank the strip. An empty map and an omitted prop both keep pills.
    for (const modules of [{}, undefined]) {
      const html = render(
        <InsightsTabStrip
          availability={moduleAvailability}
          modules={modules}
        />,
      );
      expect(html).toContain(">Mood<");
      expect(html).toContain(">Sleep<");
      expect(html).toContain('data-group="activity"');
      expect(html).toContain('data-group="metabolic"');
      expect(html).toContain(">Recovery<");
    }
  });
});

describe("<InsightsTabStrip> — pill row clip box (v1.16.8)", () => {
  it("keeps vertical paint room inside the horizontal scroller", () => {
    // `overflow-x-auto` clips vertically too (overflow-y computes to
    // auto), so a pill border or focus ring sitting exactly on the
    // content-box edge lost its bottom pixel at fractional zoom levels.
    // The scroller reserves 4 px of inner padding (`py-1`) and hands the
    // height back with `-my-1` — pinned here so a class cleanup doesn't
    // resurrect the clipped borders.
    const html = render(<InsightsTabStrip />);
    const scroller = html.match(
      /<div[^>]*data-slot="insights-tab-strip-scroller"[^>]*>/,
    )?.[0];
    expect(scroller).toBeTruthy();
    expect(scroller).toContain("overflow-x-auto");
    expect(scroller).toContain("py-1");
    expect(scroller).toContain("-my-1");
  });

  it("keeps horizontal paint room so edge pills' focus rings survive", () => {
    // Same clip mechanics sideways: without inner `px-1` the first/last
    // pill's focus ring was cut at the scroller's horizontal edges. The
    // matching `-mx-1` hands the width back to the layout.
    const html = render(<InsightsTabStrip />);
    const scroller = html.match(
      /<div[^>]*data-slot="insights-tab-strip-scroller"[^>]*>/,
    )?.[0];
    expect(scroller).toBeTruthy();
    expect(scroller).toContain("px-1");
    expect(scroller).toContain("-mx-1");
  });
});

describe("<InsightsTabStrip> — scroll arrows hold their slot", () => {
  it("renders both arrows before the row is measured, hidden but in place", () => {
    // Mounting the arrows only once the row measured as overflowing shifted
    // every pill sideways right after first paint (a layout shift on every
    // insights page). They render from the start and only hide.
    const html = render(<InsightsTabStrip />);
    for (const slot of [
      "insights-tab-strip-scroll-left",
      "insights-tab-strip-scroll-right",
    ]) {
      const tag = html.match(
        new RegExp(`<button[^>]*data-slot="${slot}"[^>]*>`),
      );
      expect(tag?.[0]).toBeDefined();
      expect(tag?.[0]).toContain("invisible");
      expect(tag?.[0]).toContain('tabindex="-1"');
    }
  });
});
