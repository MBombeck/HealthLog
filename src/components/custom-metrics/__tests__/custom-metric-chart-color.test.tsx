import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The line takes the series colour it is given (the GKI draws in a chart
 * token beside the ketone series) and keeps primary when it is given none,
 * so a custom metric's chart looks as it always has.
 */

const lineProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const Leaf = () => null;
  return {
    ResponsiveContainer: Pass,
    ComposedChart: Pass,
    CartesianGrid: Leaf,
    ReferenceArea: Leaf,
    ReferenceLine: Leaf,
    Tooltip: Leaf,
    XAxis: Leaf,
    YAxis: Leaf,
    Line: (props: Record<string, unknown>) => {
      lineProps.push(props);
      return null;
    },
  };
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";

import { CustomMetricChart } from "../custom-metric-chart";
import type { CustomMetricEntryDto } from "../types";

const NOW = Date.now();
const ENTRIES: CustomMetricEntryDto[] = [3, 2, 1].map((daysAgo, i) => ({
  id: `e${i}`,
  customMetricId: "",
  value: 2 + i,
  unit: "",
  measuredAt: new Date(NOW - daysAgo * 86_400_000).toISOString(),
  note: null,
  createdAt: new Date(NOW).toISOString(),
}));

function lineStroke(color?: string): unknown {
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <CustomMetricChart
          name="Index"
          unit=""
          targetLow={null}
          targetHigh={null}
          decimals={1}
          entries={ENTRIES}
          {...(color ? { color } : {})}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return lineProps.at(-1)?.stroke;
}

beforeEach(() => {
  lineProps.length = 0;
});

describe("<CustomMetricChart> series colour", () => {
  it("draws the line in the colour it is given", () => {
    expect(lineStroke("var(--chart-4)")).toBe("var(--chart-4)");
  });

  it("keeps primary by default", () => {
    expect(lineStroke()).toBe("var(--primary)");
  });
});
