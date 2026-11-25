import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The vitals tiles read the unit preference through `useUnitDisplay`, which
// hangs off `useAuth` (a react-query hook). These are static SSR renders with
// no QueryClient, so mock the hook to a real metric-preference implementation
// — metric is the identity on values and yields the canonical display symbols
// (e.g. °C), matching the pre-fix render the assertions expect.
vi.mock("@/hooks/use-unit-display", async () => {
  const dt = await import("@/lib/measurements/display-transform");
  const forType = (t: string) => dt.getDisplayTransform(t, "metric");
  return {
    useUnitDisplay: () => ({
      preference: "metric" as const,
      transformFor: forType,
      toDisplay: (t: string, v: number) =>
        dt.applyDisplayTransform(v, forType(t)),
      fromDisplay: (t: string, v: number) =>
        dt.invertDisplayTransform(v, forType(t)),
      toDisplayDelta: (t: string, v: number) =>
        dt.applyDisplayTransformDelta(v, forType(t)),
      unitFor: (t: string) => forType(t).displayUnit,
      decimalsFor: (t: string) => forType(t).decimals,
      isTransformed: (t: string) => dt.hasDisplayTransform(t),
    }),
  };
});

import { I18nProvider } from "@/lib/i18n/context";
import type {
  DerivedMetricResponse,
  DerivedBatchToken,
} from "../use-derived-metric";
import type { DashboardDerived } from "../use-dashboard-derived";

import { VitalsDashboard } from "../vitals-dashboard";
import { SECTION_VITALS } from "../use-dashboard-derived";
import { headlineValue } from "@/lib/dashboard/headline-value";
import { readSource } from "@/__tests__/helpers/source-files";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

type Resp = DerivedMetricResponse<Record<string, unknown>>;

function ok(value: Record<string, unknown>): Resp {
  return {
    metric: "X",
    status: "ok",
    value,
    coverage: {
      requiredInputs: 1,
      presentInputs: 1,
      historyDays: 30,
      missing: [],
    },
    confidence: { score: 90, band: "high" },
    provenance: { inputs: [], source: "DAY", windowDays: 30, computedAt: "x" },
    reason: null,
  };
}
function insufficient(reason: string, historyDays = 0): Resp {
  return {
    metric: "X",
    status: "insufficient",
    value: null,
    coverage: {
      requiredInputs: 1,
      presentInputs: reason === "no_readings_in_window" ? 0 : 1,
      historyDays,
      missing: [],
    },
    confidence: null,
    provenance: { inputs: [], source: "none", windowDays: 30, computedAt: "x" },
    reason,
  };
}

/**
 * Build a shared-batch handle that resolves each requested token from
 * `resolve`, defaulting unmatched tokens to the absent state so a scenario
 * only has to name the tiles it cares about. The page owns this batch in
 * production; the dashboard now receives it via the `batch` prop, so the test
 * passes a stub handle directly instead of mocking the query hook.
 */
function mockBatch(
  resolve: (token: DerivedBatchToken) => Resp,
  extra: { isLoading?: boolean; isError?: boolean; refetch?: () => void } = {},
): DashboardDerived {
  return {
    isLoading: extra.isLoading ?? false,
    isError: extra.isError ?? false,
    refetch: extra.refetch ?? (() => {}),
    read: <T,>(token: DerivedBatchToken) =>
      resolve(token) as unknown as DerivedMetricResponse<T>,
  } as unknown as DashboardDerived;
}

/** No snapshot summaries: the headline-free renders the layout tests need. */
const NO_SNAPSHOT = { data: { tiles: { summaries: {} } }, isLoading: false };

beforeEach(() => vi.clearAllMocks());

describe("<VitalsDashboard>", () => {
  it("renders an available baseline vital as an ok tile", () => {
    const batch = mockBatch((token) => {
      if (
        token.metric === "VITALS_BASELINE" &&
        token.type === "RESTING_HEART_RATE"
      ) {
        return ok({
          type: "RESTING_HEART_RATE",
          center: 55,
          low: 48,
          high: 62,
          spread: 7,
          sampleDays: 30,
          k: 3,
        });
      }
      return insufficient("no_readings_in_window");
    });
    const html = render(
      <VitalsDashboard batch={batch} snapshot={NO_SNAPSHOT} />,
    );
    expect(html).toContain('data-slot="vitals-dashboard"');
    expect(html).toContain('data-metric="RESTING_HEART_RATE"');
    expect(html).toContain('data-state="ok"');
    // Typical-range framing rendered.
    expect(html).toContain("Typical for you");
  });

  it("hides the whole section (heading + grid) when no vital has content", () => {
    const batch = mockBatch(() => insufficient("no_readings_in_window"));
    const html = render(
      <VitalsDashboard batch={batch} snapshot={NO_SNAPSHOT} />,
    );
    // No content under the heading → the heading must not strand over blank
    // space. The whole section un-mounts.
    expect(html).not.toContain('data-slot="vitals-dashboard"');
    expect(html).not.toContain('data-slot="vitals-dashboard-grid"');
    expect(html).not.toContain("Your vitals");
    expect(html).not.toContain('data-state="ok"');
  });

  it("renders a skeleton row (no tiles, no heading strand) while loading", () => {
    const batch = mockBatch(() => insufficient("no_readings_in_window"), {
      isLoading: true,
    });
    const html = render(
      <VitalsDashboard batch={batch} snapshot={NO_SNAPSHOT} />,
    );
    // Heading + grid present so the section reserves its final height, with a
    // busy/live region and skeleton placeholders — but no real tiles yet.
    expect(html).toContain('data-slot="vitals-dashboard"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-slot="vitals-tile-skeleton"');
    expect(html).not.toContain('data-slot="vitals-tile"');
  });

  it("shows an inline error + retry when the batch fails", () => {
    const batch = mockBatch(() => insufficient("no_readings_in_window"), {
      isError: true,
    });
    const html = render(
      <VitalsDashboard batch={batch} snapshot={NO_SNAPSHOT} />,
    );
    // The surface must not silently vanish — a compact error + a Retry button.
    expect(html).toContain('data-slot="vitals-dashboard-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-slot="vitals-dashboard-retry"');
    expect(html).toContain("Could not load your vitals");
    expect(html).toContain("Retry");
  });

  it("shows a provisional baseline tile with the coverage meter, not a headline", () => {
    const batch = mockBatch((token) => {
      if (token.metric === "VITALS_BASELINE" && token.type === "WEIGHT") {
        return insufficient("insufficient_history_for_band", 4);
      }
      return insufficient("no_readings_in_window");
    });
    const html = render(
      <VitalsDashboard batch={batch} snapshot={NO_SNAPSHOT} />,
    );
    expect(html).toContain('data-metric="WEIGHT"');
    expect(html).toContain('data-state="provisional"');
    expect(html).toContain('data-slot="coverage-meter"');
    expect(html).toContain("Building your typical range");
  });

  it("renders the fitness-age tile with its age framing", () => {
    const batch = mockBatch((token) => {
      if (token.metric === "FITNESS_AGE") {
        return ok({
          vo2Max: 46,
          band: "green",
          fitnessAgeDeltaYears: -6,
          referenceBand: { low: 35, high: 45 },
          trendDelta: 2,
          readingCount: 4,
        });
      }
      return insufficient("no_readings_in_window");
    });
    const html = render(
      <VitalsDashboard batch={batch} snapshot={NO_SNAPSHOT} />,
    );
    expect(html).toContain('data-metric="FITNESS_AGE"');
    expect(html).toContain("yr younger");
  });

  it("renders the BMI tile with its WHO category", () => {
    const batch = mockBatch((token) => {
      if (token.metric === "BMI") {
        return ok({
          bmi: 24.7,
          category: "normal",
          band: "green",
          weightKg: 80,
          heightCm: 180,
        });
      }
      return insufficient("no_readings_in_window");
    });
    const html = render(
      <VitalsDashboard batch={batch} snapshot={NO_SNAPSHOT} />,
    );
    expect(html).toContain('data-metric="BMI"');
    expect(html).toContain("Normal range (WHO)");
  });

  it("hides BMI when there is no height/weight", () => {
    const batch = mockBatch((token) => {
      if (token.metric === "BMI") return insufficient("no_height_on_profile");
      return insufficient("no_readings_in_window");
    });
    const html = render(
      <VitalsDashboard batch={batch} snapshot={NO_SNAPSHOT} />,
    );
    expect(html).not.toContain('data-metric="BMI"');
  });

  it("renders the estimated 6-minute-walk band tile with its percent framing", () => {
    const batch = mockBatch((token) => {
      if (token.metric === "SIX_MINUTE_WALK_BAND") {
        return ok({
          distanceM: 540,
          predictedM: 600,
          percentOfPredicted: 90,
          band: "green",
          trendDelta: 12,
          readingCount: 5,
          series: [520, 530, 540],
        });
      }
      return insufficient("no_readings_in_window");
    });
    const html = render(
      <VitalsDashboard batch={batch} snapshot={NO_SNAPSHOT} />,
    );
    expect(html).toContain('data-slot="vitals-mobility"');
    expect(html).toContain('data-metric="SIX_MINUTE_WALK_BAND"');
    expect(html).toContain("90% of predicted");
  });

  it("renders the 6-minute-walk tile distance-only when demographics are absent", () => {
    const batch = mockBatch((token) => {
      if (token.metric === "SIX_MINUTE_WALK_BAND") {
        return ok({
          distanceM: 540,
          predictedM: null,
          percentOfPredicted: null,
          band: null,
          trendDelta: null,
          readingCount: 1,
          series: [],
        });
      }
      return insufficient("no_readings_in_window");
    });
    const html = render(
      <VitalsDashboard batch={batch} snapshot={NO_SNAPSHOT} />,
    );
    expect(html).toContain('data-metric="SIX_MINUTE_WALK_BAND"');
    // Honest prompt, never a fabricated placement.
    expect(html).toContain("Add your age, height, weight and sex");
  });

  it("renders a stair-ascent-speed baseline band tile under Mobility & body", () => {
    const batch = mockBatch((token) => {
      if (token.metric === "STAIR_ASCENT_SPEED_BASELINE") {
        return ok({
          type: "STAIR_ASCENT_SPEED",
          center: 0.4,
          low: 0.3,
          high: 0.5,
          spread: 0.05,
          sampleDays: 21,
          k: 3,
          series: [0.38, 0.4, 0.42],
        });
      }
      return insufficient("no_readings_in_window");
    });
    const html = render(
      <VitalsDashboard batch={batch} snapshot={NO_SNAPSHOT} />,
    );
    expect(html).toContain('data-slot="vitals-mobility"');
    expect(html).toContain('data-metric="STAIR_ASCENT_SPEED_BASELINE"');
    expect(html).toContain("Mobility &amp; body");
  });

  it("hides the whole Mobility & body section when no mobility metric has content", () => {
    const batch = mockBatch(() => insufficient("no_readings_in_window"));
    const html = render(
      <VitalsDashboard batch={batch} snapshot={NO_SNAPSHOT} />,
    );
    expect(html).not.toContain('data-slot="vitals-mobility"');
    expect(html).not.toContain("Mobility &amp; body");
    expect(html).not.toContain('data-metric="SIX_MINUTE_WALK_BAND"');
    expect(html).not.toContain('data-metric="WRIST_TEMPERATURE_BASELINE"');
  });

  it("does not read the coincident-deviation flag (now the top-of-overview card)", () => {
    // The flag moved to the dedicated `CoincidentDeviationCard`; the dashboard
    // batch no longer requests it and the grid never paints it.
    let requestedCoincident = false;
    const batch = mockBatch((token) => {
      if (token.metric === "COINCIDENT_DEVIATION") requestedCoincident = true;
      return insufficient("no_readings_in_window");
    });
    const html = render(
      <VitalsDashboard batch={batch} snapshot={NO_SNAPSHOT} />,
    );
    expect(requestedCoincident).toBe(false);
    expect(html).not.toContain('data-metric="COINCIDENT_DEVIATION"');
  });

  describe("Today so far", () => {
    const hourly = {
      mode: "hourly",
      type: "ACTIVITY_STEPS",
      unit: "count",
      timezone: "UTC",
      dateKey: "2026-06-10",
      asOfHour: 2,
      todayValue: 300,
      typicalValue: 200,
      typicalLow: 100,
      typicalHigh: 400,
      delta: 100,
      percentOfTypical: 150,
      band: "within",
      todayCurve: [0, 100, 300],
      typicalCurve: [0, 80, 200],
      baselineDays: 20,
      windowDays: 28,
    };
    const dailyTotal = {
      mode: "daily_total",
      type: "FLIGHTS_CLIMBED",
      unit: "flights",
      timezone: "UTC",
      dateKey: "2026-06-10",
      todayValue: 4,
      typicalValue: 9,
      typicalLow: 6,
      typicalHigh: 12,
      percentOfTypical: 44,
      dayRangeReached: "not_yet",
      source: "GARMIN",
      updatedAt: "2026-06-10T14:05:00.000Z",
      baselineDays: 14,
      windowDays: 14,
    };
    const sameTime = (values: Record<string, Resp>) =>
      mockBatch((token) =>
        token.metric === "SAME_TIME_BASELINE" && token.type
          ? (values[token.type] ?? insufficient("no_intraday_today"))
          : insufficient("no_readings_in_window"),
      );

    it("renders the day-total form with the usual full day and the update stamp", () => {
      const html = render(
        <VitalsDashboard
          snapshot={NO_SNAPSHOT}
          batch={sameTime({ FLIGHTS_CLIMBED: ok(dailyTotal) })}
        />,
      );
      expect(html).toContain('data-mode="daily_total"');
      expect(html).toContain('data-slot="usual-day-track"');
      expect(html).toContain('data-reached="not_yet"');
      expect(html).toContain("Usual full day: 6–12");
      expect(html).toContain("(Garmin)");
      expect(html).toContain("Your running totals against your usual full day");
      // No curve and no "typical by" hour: nothing behind a day total knows it.
      expect(html).not.toContain('data-slot="sparkline-delta-tile-spark"');
      expect(html).not.toContain("Typical by");
    });

    it("keeps the hourly form and its subtitle when every tile compares hours", () => {
      const html = render(
        <VitalsDashboard
          snapshot={NO_SNAPSHOT}
          batch={sameTime({ ACTIVITY_STEPS: ok(hourly) })}
        />,
      );
      expect(html).toContain('data-mode="hourly"');
      expect(html).toContain("Typical by 03:00");
      expect(html).toContain(
        "Your running totals against what is usual for you at this hour",
      );
    });

    it("names the comparison plainly when both forms sit side by side", () => {
      const html = render(
        <VitalsDashboard
          snapshot={NO_SNAPSHOT}
          batch={sameTime({
            ACTIVITY_STEPS: ok(hourly),
            FLIGHTS_CLIMBED: ok(dailyTotal),
          })}
        />,
      );
      expect(html).toContain(
        "Your running totals against what is usual for you<",
      );
    });

    it("shows the day-total learning state against its own floor", () => {
      const html = render(
        <VitalsDashboard
          snapshot={NO_SNAPSHOT}
          batch={sameTime({
            ACTIVITY_STEPS: insufficient("learning_usual_total", 3),
          })}
        />,
      );
      expect(html).toContain("Learning your usual day: 3 of 7 days");
    });

    it("hides the section when no day-total reading arrived today", () => {
      const html = render(
        <VitalsDashboard
          snapshot={NO_SNAPSHOT}
          batch={sameTime({
            ACTIVITY_STEPS: insufficient("no_total_today", 14),
          })}
        />,
      );
      expect(html).not.toContain('data-slot="vitals-same-time"');
    });
  });
});

/**
 * The vitals grid and the dashboard print one number per metric. Both read the
 * snapshot summary's latest reading through `headlineValue`; the grid's band
 * and balance only frame it. The grid used to print the band's 30-day median,
 * and the HRV tile a seven-day mean, so HRV read 55 ms on the dashboard and
 * 57 ms on the overview for the same moment.
 */
describe("<VitalsDashboard> headline", () => {
  const BASELINE_TYPES = SECTION_VITALS.filter(
    (type) => type !== "HEART_RATE_VARIABILITY",
  );

  function headlineOf(html: string, metric: string): string | null {
    const start = html.indexOf(`data-metric="${metric}"`);
    if (start === -1) return null;
    const m = /data-slot="sparkline-delta-tile-value"[^>]*>([^<]*)</.exec(
      html.slice(start),
    );
    return m ? m[1] : null;
  }

  it.each(BASELINE_TYPES)(
    "%s prints the dashboard's latest reading, not the band centre",
    (type) => {
      const batch = mockBatch((token) =>
        token.metric === "VITALS_BASELINE" && token.type === type
          ? ok({
              type,
              center: 40,
              low: 30,
              high: 50,
              spread: 5,
              sampleDays: 30,
              k: 3,
              series: [39, 40, 41],
            })
          : insufficient("no_readings_in_window"),
      );
      const summaries = { [type]: { latest: 47 } };
      const html = render(
        <VitalsDashboard
          batch={batch}
          snapshot={{ data: { tiles: { summaries } }, isLoading: false }}
        />,
      );
      const shown = headlineOf(html, type);
      expect(shown).not.toBeNull();
      // The dashboard tile prints `headlineValue(summary)`; so does the grid.
      expect(headlineValue(summaries[type])).toBe(47);
      expect(shown).toMatch(/^47(\.0)?$/);
    },
  );

  it("HRV prints the dashboard's latest reading, not the trailing-week mean", () => {
    const batch = mockBatch((token) =>
      token.metric === "HRV_BALANCE"
        ? ok({
            recentAvg: 57,
            baselineCenter: 55.5,
            baselineLow: 44.4,
            baselineHigh: 66.6,
            band: "balanced",
            sampleDays: 24,
            series: [56, 59, 55],
          })
        : insufficient("no_readings_in_window"),
    );
    const html = render(
      <VitalsDashboard
        batch={batch}
        snapshot={{
          data: {
            tiles: { summaries: { HEART_RATE_VARIABILITY: { latest: 55 } } },
          },
          isLoading: false,
        }}
      />,
    );
    expect(headlineOf(html, "HRV_BALANCE")).toBe("55");
  });

  it("the dashboard's metric tiles print their headline through the same helper", () => {
    const src = readSource(
      "src/components/dashboard/tiles/strip-tiles.tsx",
      "headlineValue(",
    );
    // Every `latest=` prop the dashboard strip passes reads `headlineValue`.
    const latestProps = src.match(/\blatest=\{[^\n]*/g) ?? [];
    const summaryReads = latestProps.filter(
      (p) => !p.includes("bpInTargetPct"),
    );
    expect(summaryReads.length).toBeGreaterThan(0);
    for (const prop of summaryReads) expect(prop).toContain("headlineValue(");
  });

  it("holds the grid on its skeleton while the snapshot is on its way", () => {
    const batch = mockBatch(() => insufficient("no_readings_in_window"));
    const html = render(
      <VitalsDashboard batch={batch} snapshot={{ isLoading: true }} />,
    );
    expect(html).toContain('data-slot="vitals-tile-skeleton"');
    expect(html).not.toContain('data-slot="vitals-tile"');
  });
});
