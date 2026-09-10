import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MedicationComplianceChart,
  aggregateMedicationCompliance,
  computeMedicationTrend7d,
} from "../medication-compliance-chart";

/**
 * Stubs — the dashboard chart wrappers all need TanStack Query +
 * useAuth shims to render in SSR. We don't care about live data; we
 * only assert that the wrapper paints its title and "no data" empty
 * state when the query resolves to an empty array, and that the
 * aggregation helper produces the correct rates.
 */

/**
 * The daily points the mocked query serves. Mutable so one test can hand the
 * chart a loaded window; every other test leaves it empty.
 */
const queryState = vi.hoisted(() => ({
  data: [] as { date: string; scheduled: number; taken: number }[],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: queryState.data, isLoading: false }),
  useQueryClient: () => ({
    cancelQueries: () => Promise.resolve(),
    getQueryData: () => undefined,
    setQueryData: () => undefined,
    invalidateQueries: () => Promise.resolve(),
  }),
  useMutation: () => ({ mutate: () => undefined, isPending: false }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: null, isLoading: false }),
}));

import { I18nProvider } from "@/lib/i18n/context";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("aggregateMedicationCompliance()", () => {
  it("computes rate as taken/scheduled rounded to nearest integer", () => {
    const out = aggregateMedicationCompliance([
      { date: "2026-05-01", scheduled: 4, taken: 4 }, // 100 %
      { date: "2026-05-02", scheduled: 4, taken: 3 }, // 75 %
      { date: "2026-05-03", scheduled: 4, taken: 2 }, // 50 %
      { date: "2026-05-04", scheduled: 4, taken: 0 }, // 0 %
    ]);
    expect(out.map((p) => p.rate)).toEqual([100, 75, 50, 0]);
  });

  it("skips days where no doses were scheduled (rate undefined)", () => {
    const out = aggregateMedicationCompliance([
      { date: "2026-05-01", scheduled: 0, taken: 0 }, // skipped
      { date: "2026-05-02", scheduled: 2, taken: 2 }, // 100 %
      { date: "2026-05-03", scheduled: 0, taken: 0 }, // skipped
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].rate).toBe(100);
  });

  it("clamps over-100 % rates (e.g. extra ad-hoc takes) to 100", () => {
    const out = aggregateMedicationCompliance([
      { date: "2026-05-01", scheduled: 2, taken: 5 },
    ]);
    expect(out[0].rate).toBe(100);
  });

  it("sorts by date ascending regardless of input order", () => {
    const out = aggregateMedicationCompliance([
      { date: "2026-05-03", scheduled: 1, taken: 1 },
      { date: "2026-05-01", scheduled: 1, taken: 1 },
      { date: "2026-05-02", scheduled: 1, taken: 1 },
    ]);
    expect(out.map((p) => p.timestamp)).toEqual(
      [...out.map((p) => p.timestamp)].sort((a, b) => a - b),
    );
  });

  it("emits an empty array when all input days have no scheduled doses", () => {
    const out = aggregateMedicationCompliance([
      { date: "2026-05-01", scheduled: 0, taken: 0 },
    ]);
    expect(out).toEqual([]);
  });
});

/**
 * v1.4.16 A6 — 7-day trend computation.
 *
 * The chart header now paints a 7-day trend chip with a signed delta
 * in percentage points (pp) plus a direction arrow. The helper
 * compares the mean of the most recent 7 daily rates with the mean of
 * the prior 7, on a 14-day cap.
 */
describe("computeMedicationTrend7d()", () => {
  function pt(timestamp: number, rate: number) {
    return { date: "", rate, timestamp };
  }

  it("returns null with fewer than 2 daily points", () => {
    expect(computeMedicationTrend7d([])).toBeNull();
    expect(computeMedicationTrend7d([pt(1, 90)])).toBeNull();
  });

  it("returns 'up' when recent half is higher than prior half", () => {
    // 14 points: first 7 average to 70 %, second 7 average to 95 %.
    // Delta = +25 pp, direction = up.
    const points = [
      ...Array.from({ length: 7 }, (_, i) => pt(i, 70)),
      ...Array.from({ length: 7 }, (_, i) => pt(7 + i, 95)),
    ];
    const trend = computeMedicationTrend7d(points);
    expect(trend).not.toBeNull();
    expect(trend!.direction).toBe("up");
    expect(trend!.delta).toBe(25);
  });

  it("returns 'down' when recent half is lower than prior half", () => {
    const points = [
      ...Array.from({ length: 7 }, (_, i) => pt(i, 95)),
      ...Array.from({ length: 7 }, (_, i) => pt(7 + i, 70)),
    ];
    const trend = computeMedicationTrend7d(points);
    expect(trend!.direction).toBe("down");
    expect(trend!.delta).toBe(-25);
  });

  it("returns 'stable' when delta is below 1 pp", () => {
    // Both halves average to 90 % (with noise just below 1 pp).
    const points = [
      ...Array.from({ length: 7 }, (_, i) => pt(i, 90)),
      pt(7, 90.4),
      pt(8, 89.6),
      pt(9, 90.3),
      pt(10, 89.7),
      pt(11, 90.5),
      pt(12, 89.5),
      pt(13, 90),
    ];
    const trend = computeMedicationTrend7d(points);
    expect(trend!.direction).toBe("stable");
    expect(Math.abs(trend!.delta)).toBeLessThan(1);
  });

  it("caps the comparison window at 14 days even with longer input", () => {
    // 30 points where the first 16 are 30 % and the last 14 are 100 %.
    // Without the 14-day cap the delta would average over the wider
    // window; with the cap, we only see the 100% half.
    const points = [
      ...Array.from({ length: 16 }, (_, i) => pt(i, 30)),
      ...Array.from({ length: 14 }, (_, i) => pt(16 + i, 100)),
    ];
    const trend = computeMedicationTrend7d(points);
    // Recent 14 split into halves (7+7): both halves average 100 %.
    expect(trend!.delta).toBe(0);
    expect(trend!.direction).toBe("stable");
  });

  it("handles short windows (< 14 points) by splitting available data in half", () => {
    // 4 points: first 2 average 50 %, second 2 average 100 %. Delta = +50 pp.
    const points = [pt(0, 50), pt(1, 50), pt(2, 100), pt(3, 100)];
    const trend = computeMedicationTrend7d(points);
    expect(trend!.delta).toBe(50);
    expect(trend!.direction).toBe("up");
  });
});

describe("<MedicationComplianceChart>", () => {
  it("renders the section title and the empty-state message when data is empty", () => {
    const html = render(<MedicationComplianceChart />);
    // Title — fallback to dashboard.medications when no override prop.
    expect(html).toContain("Medications");
    // Empty state surfaces the i18n no-data string.
    expect(html).toContain("No data");
    // The wrapper data-slot is present so e2e/visual-verify can target it.
    expect(html).toContain('data-slot="medication-compliance-chart"');
  });

  it("respects an explicit title override", () => {
    const html = render(<MedicationComplianceChart title="Adherence" />);
    expect(html).toContain("Adherence");
  });

  /**
   * v1.4.16 A6 — the trend chip is suppressed when the dataset is
   * empty (the empty-state placeholder is shown instead). Once data
   * arrives, the chip + reference lines paint — those are exercised
   * end-to-end by the e2e suite; a unit-rendered SSR snapshot can't
   * mount the recharts SVG primitives. Here we only lock the no-data
   * variant: chip is absent so the empty header doesn't paint a
   * misleading "0 pp" indicator.
   */
  it("does not paint the trend chip in the empty state", () => {
    const html = render(<MedicationComplianceChart />);
    expect(html).not.toContain('data-slot="medication-trend-chip"');
  });

  /**
   * The tile's adherence number exists only as bar geometry, so the root's
   * `data-latest-rate` is the one way to read it back — and the browser suite
   * was its only reader, which put a production attribute's shape three
   * minutes and a whole server away from the gate that should own it. Pinned
   * here: the value is the LAST day's rate, as an integer.
   */
  it("carries the last day's rate on the root as data-latest-rate", () => {
    queryState.data = [
      { date: "2026-05-01", scheduled: 2, taken: 2 }, // 100 %
      { date: "2026-05-02", scheduled: 4, taken: 1 }, // 25 %
    ];
    try {
      const html = render(<MedicationComplianceChart />);
      expect(html).toContain('data-latest-rate="25"');
    } finally {
      queryState.data = [];
    }
  });
});
