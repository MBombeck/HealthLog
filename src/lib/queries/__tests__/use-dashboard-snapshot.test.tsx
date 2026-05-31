/**
 * v1.7.0 — open-dashboard auto-refresh contract.
 *
 * An open dashboard must pick up freshly-synced Withings / HealthKit
 * readings without a manual reload. The snapshot hook carries a
 * two-minute `refetchInterval` that pauses while the tab is
 * backgrounded (`refetchIntervalInBackground: false`). The poll rides
 * the warm 60 s server cache and never touches the LLM surfaces.
 *
 * The hook keeps its existing warm-cache options (`staleTime: 60_000`,
 * `refetchOnMount: false`, `refetchOnWindowFocus: false`) so a
 * return-to-dashboard within a minute stays a free cache hit, and the
 * queryKey stays the centralised factory entry.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const useQueryMock =
  vi.fn<(opts: Record<string, unknown>) => { data: undefined }>();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: Record<string, unknown>) => useQueryMock(opts),
}));

import { useDashboardSnapshot } from "../use-dashboard-snapshot";
import { queryKeys } from "@/lib/query-keys";

afterEach(() => {
  useQueryMock.mockClear();
});

describe("useDashboardSnapshot — auto-refresh on an open page", () => {
  function lastOpts() {
    expect(useQueryMock).toHaveBeenCalledTimes(1);
    return useQueryMock.mock.calls[0]![0];
  }

  it("polls every two minutes and pauses in the background", () => {
    useDashboardSnapshot();
    const opts = lastOpts();
    expect(opts.refetchInterval).toBe(120_000);
    expect(opts.refetchIntervalInBackground).toBe(false);
  });

  it("keeps the warm-cache options so a return within a minute is free", () => {
    useDashboardSnapshot();
    const opts = lastOpts();
    expect(opts.staleTime).toBe(60_000);
    expect(opts.refetchOnMount).toBe(false);
    expect(opts.refetchOnWindowFocus).toBe(false);
  });

  it("routes the queryKey through the centralised factory", () => {
    useDashboardSnapshot();
    const opts = lastOpts();
    expect(opts.queryKey).toEqual(queryKeys.dashboardSnapshot());
  });
});
