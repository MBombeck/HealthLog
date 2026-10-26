import { dashboardSource } from "@/__tests__/helpers/dashboard-source";
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";

/**
 * Saving the dashboard tile selection must surface on the dashboard on the
 * very next SAME-TAB navigation — not "eventually" via the 120 s poll or a
 * window-focus flick.
 *
 * The web dashboard (`src/app/page-client.tsx`) reads tile visibility/order
 * from TWO cache cells:
 *   1. the snapshot cell (`queryKeys.dashboardSnapshot(locale)` via
 *      `useDashboardSnapshot`) — `snapshotQuery.data.layout` is the layout
 *      source whenever snapshot mode is on (the default), and
 *   2. the legacy `queryKeys.dashboardWidgets()` cell (snapshot mode off, plus
 *      the per-chart overlay-prefs hook).
 * The settings save writes (2) directly via `setQueryData` with the server
 * response, so its freshness is unconditional. (1) is only INVALIDATED — and
 * that is where the same-tab staleness lived:
 *
 * While the user sits on /settings/layout/dashboard the dashboard page is
 * unmounted, so the snapshot cell has no active observer. An
 * `invalidateQueries` with the default `refetchType: "active"` merely marks
 * the cell stale, and the snapshot query's deliberate `refetchOnMount: false`
 * (`use-dashboard-snapshot.ts` — return-to-dashboard within a minute stays a
 * free cache hit) then suppresses the mount-time refetch when the user
 * navigates back. Result: "saved, but the dashboard shows the old tiles".
 * The tests below pin that mechanism against the REAL TanStack QueryClient
 * and the fix (`refetchType: "all"`), so neither half can silently regress.
 */

/** Mirror of the layout-relevant options in `use-dashboard-snapshot.ts`. */
function snapshotObserverOptions(
  client: QueryClient,
  queryFn: () => Promise<unknown>,
) {
  return new QueryObserver(client, {
    queryKey: queryKeys.dashboardSnapshot("en"),
    queryFn,
    staleTime: 60_000,
    refetchOnMount: false,
    retry: false,
  });
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

describe("dashboard snapshot invalidation — same-tab staleness mechanism", () => {
  it("default refetchType leaves the unmounted snapshot cell stale across a remount (the defect)", async () => {
    const client = makeClient();
    let fetchCount = 0;
    const queryFn = async () => {
      fetchCount += 1;
      return { layout: `v${fetchCount}` };
    };

    // Dashboard mounted — first fetch. Wait for the COMMITTED data, not just
    // the queryFn call: an observer-less query that never committed a fetch
    // reads as disabled and would be skipped by refetchQueries.
    const observer = snapshotObserverOptions(client, queryFn);
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data).toEqual({ layout: "v1" }),
    );

    // Navigate to Settings → the dashboard unmounts.
    unsubscribe();

    // The PRE-fix save-mutation call: zero-arg key (prefix-matches the
    // locale-keyed cell), default refetchType ("active").
    await client.invalidateQueries({
      queryKey: queryKeys.dashboardSnapshot(),
    });
    expect(fetchCount).toBe(1); // inactive cell: marked stale, NOT refetched

    // Navigate back to the dashboard — remount. `refetchOnMount: false`
    // suppresses the stale-triggered refetch: the OLD layout renders.
    const observer2 = snapshotObserverOptions(client, queryFn);
    const unsubscribe2 = observer2.subscribe(() => {});
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fetchCount).toBe(1);
    expect(observer2.getCurrentResult().data).toEqual({ layout: "v1" });
    unsubscribe2();
    client.clear();
  });

  it('refetchType: "all" refetches the unmounted cell so the remount reads fresh layout (the fix)', async () => {
    const client = makeClient();
    let fetchCount = 0;
    const queryFn = async () => {
      fetchCount += 1;
      return { layout: `v${fetchCount}` };
    };

    const observer = snapshotObserverOptions(client, queryFn);
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data).toEqual({ layout: "v1" }),
    );
    unsubscribe();

    // The save-mutation call as shipped: zero-arg key still prefix-matches
    // the locale-keyed cell, and `refetchType: "all"` fires the request
    // immediately even though the dashboard is unmounted.
    await client.invalidateQueries({
      queryKey: queryKeys.dashboardSnapshot(),
      refetchType: "all",
    });
    expect(fetchCount).toBe(2);

    // Remount: fresh data is already in the cache — no refetch needed.
    const observer2 = snapshotObserverOptions(client, queryFn);
    const unsubscribe2 = observer2.subscribe(() => {});
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(observer2.getCurrentResult().data).toEqual({ layout: "v2" });
    unsubscribe2();
    client.clear();
  });
});

describe("dashboard layout save — every layout source is covered (source pins)", () => {
  const sectionSrc = readFileSync(
    join(
      process.cwd(),
      "src/components/settings/dashboard-layout/use-dashboard-layout-draft.ts",
    ),
    "utf8",
  );

  it("save and reset refetch inactive snapshot and daily-digest cells", () => {
    for (const key of ["dashboardSnapshot", "dailyDigest"]) {
      const calls =
        sectionSrc.match(
          new RegExp(
            `invalidateQueries\\(\\{\\s*queryKey: queryKeys\\.${key}\\(\\),\\s*refetchType: "all",\\s*\\}\\)`,
            "g",
          ),
        ) ?? [];
      expect(calls).toHaveLength(2);
    }
  });

  it("the legacy dashboardWidgets cell is written directly with the server response", () => {
    expect(sectionSrc).toMatch(
      /setQueryData\(queryKeys\.dashboardWidgets\(\), saved\)/,
    );
  });

  it("the dashboard reads layout from the snapshot (or the dashboardWidgets cell) only", () => {
    const pageSrc = dashboardSource();
    // Snapshot path: layout comes off the snapshot payload…
    expect(pageSrc).toContain("snapshotQuery.data?.layout");
    // …legacy path: the dashboardWidgets factory key (no bare literal).
    expect(pageSrc).toContain("queryKeys.dashboardWidgets()");
    // The analytics slices carry tile DATA (summaries), never layout — if
    // someone threads layout through them, this pin forces a rethink of the
    // save-path invalidation set.
    expect(pageSrc).not.toMatch(/analytics[A-Za-z]*\??\.(data\.)?layout/);
  });

  it("keeps remounts disabled while focus refresh remains unconditional", () => {
    const hookSrc = readFileSync(
      join(process.cwd(), "src/lib/queries/use-dashboard-snapshot.ts"),
      "utf8",
    );
    expect(hookSrc).toContain("refetchOnMount: false");
    // Arrival freshness is out-of-band, so staleTime must not suppress focus.
    expect(hookSrc).toContain('refetchOnWindowFocus: "always"');
  });
});
