/**
 * `/insights/weight` shades the band of the record on screen. It used to take
 * the height of the person at the keyboard (`useAuth()`) and their own target
 * (`/api/user/thresholds`, refused under a switch), so a parent of 180 cm on
 * a child's record saw the parent's healthy band behind the child's weights.
 *
 * `SubPageShell` is stubbed to a probe so the test reads the band the page
 * hands the chart, not rendered pixels.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const shellProps = vi.fn();
vi.mock("@/components/insights/sub-page-shell", () => ({
  SubPageShell: (props: Record<string, unknown>) => {
    shellProps(props);
    return null;
  },
}));

vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({ t: (key: string) => key, locale: "en" }),
}));

// The viewer: 180 cm, signed in, looking at somebody else's record.
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: { heightCm: 180, timezone: "UTC", unitPreference: "metric" },
  }),
  useAccountOnceMounted: () => null,
}));

vi.mock("@/hooks/use-insights-analytics", () => ({
  useInsightsAnalytics: () => ({
    data: { summaries: { WEIGHT: { count: 10 } } },
    isLoading: false,
    isEmpty: false,
  }),
}));

// The record on screen: 118 cm, no target of its own.
const targets = {
  current: {
    targets: [
      { type: "WEIGHT", range: { min: 25.8, max: 34.7 }, source: "WHO BMI" },
    ],
    profile: { heightCm: 118 },
  } as unknown,
};
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => ({
    data: JSON.stringify(queryKey).includes("targets")
      ? targets.current
      : undefined,
    isLoading: false,
    error: null,
  }),
}));

import InsightsGewichtPage from "../page";
import { buildWeightRangeFromHeight } from "@/lib/analytics/value-bands";

function chartBands(): Array<{ min: number; max: number }> | undefined {
  renderToStaticMarkup(<InsightsGewichtPage />);
  const props = shellProps.mock.calls.at(-1)![0] as { children: unknown };
  const children = Array.isArray(props.children)
    ? props.children
    : [props.children];
  const chart = children.find(
    (el) =>
      el &&
      typeof el === "object" &&
      Array.isArray((el as { props?: { types?: unknown } }).props?.types),
  ) as { props: { valueBands?: Array<{ min: number; max: number }> } };
  return chart.props.valueBands;
}

describe("/insights/weight band", () => {
  beforeEach(() => shellProps.mockClear());

  it("shades the WHO band for the record's height, not the viewer's", () => {
    const bands = chartBands();
    const record = buildWeightRangeFromHeight(118);
    const viewer = buildWeightRangeFromHeight(180);
    expect(bands).toContainEqual(
      expect.objectContaining({ min: record.greenMin, max: record.greenMax }),
    );
    expect(bands).not.toContainEqual(
      expect.objectContaining({ min: viewer.greenMin, max: viewer.greenMax }),
    );
  });

  it("shades no band when the record's targets are not readable", () => {
    targets.current = undefined;
    try {
      expect(chartBands()).toBeUndefined();
    } finally {
      targets.current = {
        targets: [],
        profile: { heightCm: 118 },
      };
    }
  });
});
