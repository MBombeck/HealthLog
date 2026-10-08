/**
 * A chart whose chunk fails never reports its visible window, and the stat
 * strip above it holds its cells for that report. The boundary's catch
 * settles it with "no window" so the strip paints the full-range summary
 * instead of staying a skeleton for good.
 */
import type { ComponentProps, ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { ChartBoundary } from "@/components/charts/chart-error-state";
import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";

type Props = ComponentProps<typeof HealthChartDynamic>;

describe("chart boundary settles the stat strip", () => {
  it("reports an empty window when the chart fails to mount", () => {
    const onVisibleStats = vi.fn();
    const element = HealthChartDynamic({
      types: ["WEIGHT"],
      onVisibleStats,
    } as unknown as Props) as ReactElement<{
      onError?: (error: Error) => void;
    }>;

    expect(element.props.onError).toBeTypeOf("function");
    element.props.onError?.(new Error("chunk"));
    expect(onVisibleStats).toHaveBeenCalledWith(null);
  });

  it("passes no handler for a chart nobody reads stats from", () => {
    const element = HealthChartDynamic({
      types: ["WEIGHT"],
    } as unknown as Props) as ReactElement<{ onError?: unknown }>;
    expect(element.props.onError).toBeUndefined();
  });

  it("the boundary calls its handler when it catches", () => {
    const onError = vi.fn();
    const boundary = new ChartBoundary({
      fallback: null,
      children: null,
      onError,
    });
    const error = new Error("chunk");
    boundary.componentDidCatch(error);
    expect(onError).toHaveBeenCalledWith(error);
  });
});
