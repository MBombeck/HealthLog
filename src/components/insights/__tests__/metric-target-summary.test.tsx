import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.8.0 — `<MetricTargetSummary>` unit tests.
 *
 * The card surfaces the numeric target range + the in-target share on
 * each insights category page, reading the same `/api/insights/targets`
 * payload that powers `/targets`. The component depends on `useAuth`
 * (gate) and TanStack Query (`useQuery`) for the payload, so both are
 * mocked here and the assertions run through SSR — the load-bearing
 * behaviour is the range/share rendering + the slug→type mapping, not
 * the live fetch.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: vi.fn(() => ({ isAuthenticated: true, user: null })),
}));

const useQueryMock = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: unknown) => useQueryMock(opts),
}));

const { MetricTargetSummary } = await import("../metric-target-summary");

interface TargetsFixture {
  targets: Array<{
    type: string;
    current: number | null;
    unit: string;
    range: { min: number; max: number } | null;
    daysInRange30d: number;
    daysLogged30d: number;
    insufficientData: boolean;
  }>;
  bpDiastolic: { current: number | null; range: { min: number; max: number } | null };
}

function renderWith(slug: string, data: TargetsFixture | undefined) {
  useQueryMock.mockReturnValue({ data });
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MetricTargetSummary slug={slug} />
    </I18nProvider>,
  );
}

const WEIGHT_DATA: TargetsFixture = {
  targets: [
    {
      type: "WEIGHT",
      current: 72,
      unit: "kg",
      range: { min: 60.1, max: 80.9 },
      daysInRange30d: 18,
      daysLogged30d: 24,
      insufficientData: false,
    },
  ],
  bpDiastolic: { current: null, range: null },
};

const BP_DATA: TargetsFixture = {
  targets: [
    {
      type: "BLOOD_PRESSURE",
      current: 124,
      unit: "mmHg",
      range: { min: 120, max: 129 },
      daysInRange30d: 10,
      daysLogged30d: 20,
      insufficientData: false,
    },
  ],
  bpDiastolic: { current: 78, range: { min: 70, max: 79 } },
};

describe("<MetricTargetSummary>", () => {
  it("renders the numeric range + in-target share for a simple metric", () => {
    const html = renderWith("weight", WEIGHT_DATA);
    // Trailing `.0` trimmed, single-decimal kept.
    expect(html).toContain("Target: 60.1–80.9 kg");
    // round(18/24*100) = 75
    expect(html).toContain("75% of logged days within target");
  });

  it("stitches the systolic + diastolic bands for blood pressure", () => {
    const html = renderWith("blood-pressure", BP_DATA);
    expect(html).toContain("Target: 120–129 / 70–79 mmHg");
    expect(html).toContain("50% of logged days within target");
  });

  it("renders the adjust-target link to /targets", () => {
    const html = renderWith("weight", WEIGHT_DATA);
    expect(html).toContain('href="/targets"');
    expect(html).toContain("Adjust target range");
  });

  it("suppresses the share when the route flags insufficient data", () => {
    const html = renderWith("weight", {
      ...WEIGHT_DATA,
      targets: [{ ...WEIGHT_DATA.targets[0], insufficientData: true }],
    });
    expect(html).toContain("Target: 60.1–80.9 kg");
    expect(html).not.toContain("of logged days within target");
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
      targets: [{ ...WEIGHT_DATA.targets[0], range: null }],
    });
    expect(html).toBe("");
  });
});
