/**
 * v1.7.0 — open-dashboard auto-refresh contract.
 *
 * An open dashboard must pick up freshly-synced Withings / HealthKit
 * readings without a manual reload. The snapshot hook carries a
 * two-minute `refetchInterval` that pauses while the tab is
 * backgrounded (`refetchIntervalInBackground: false`). The poll rides
 * the warm 60 s server cache and never touches the LLM surfaces.
 *
 * The hook keeps its warm-cache options (`staleTime: 60_000`,
 * `refetchOnMount: false`) for remounts. v1.31.0 makes
 * `refetchOnWindowFocus` unconditional so an out-of-band background sync
 * surfaces even when the prior snapshot was fetched less than a minute ago;
 * the Today digest uses the same focus contract, keeping both cells aligned.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const useQueryMock =
  vi.fn<(opts: Record<string, unknown>) => { data: undefined }>();
const getQueryDataMock = vi.fn();
const setQueryDataMock = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: Record<string, unknown>) => useQueryMock(opts),
  useQueryClient: () => ({
    getQueryData: getQueryDataMock,
    setQueryData: setQueryDataMock,
  }),
}));

// v1.21.3 (b) — the hook now keys the cell by the active locale via
// `useTranslations()`; the suite exercises the hook body directly (react-query
// is mocked), so stub the i18n context to a fixed locale rather than mounting a
// provider.
vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({ locale: "en" }),
}));

import {
  useDashboardSnapshot,
  prefetchDashboardSnapshot,
  _resetDashboardSnapshotPreloadForTests,
} from "../use-dashboard-snapshot";
import { retryOnceOnTransientError } from "../retry-transient";
import { queryKeys } from "@/lib/query-keys";
import {
  __resetRecordScopeForTests,
  setRecordScope,
} from "@/lib/query-keys/record-scope";
import type { QueryClient } from "@tanstack/react-query";

/** Envelope-shaped Response — the snapshot fetch rides `apiGet` now. */
function envelopeResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data, error: null }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  useQueryMock.mockClear();
  getQueryDataMock.mockReset();
  setQueryDataMock.mockClear();
  _resetDashboardSnapshotPreloadForTests();
  __resetRecordScopeForTests();
  vi.unstubAllGlobals();
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
    const refetchOnMount = opts.refetchOnMount as (query: {
      state: { isInvalidated: boolean };
    }) => boolean;
    // A live cell is read as it is on remount ...
    expect(refetchOnMount({ state: { isInvalidated: false } })).toBe(false);
    // ... and one restored from the offline copy (invalidated) fetches.
    expect(refetchOnMount({ state: { isInvalidated: true } })).toBe(true);
  });

  it("always refetches on focus so freshness is not suppressed by staleTime", () => {
    useDashboardSnapshot();
    const opts = lastOpts();
    expect(opts.refetchOnWindowFocus).toBe("always");
  });

  it("routes the queryKey through the centralised factory, keyed by locale", () => {
    useDashboardSnapshot();
    const opts = lastOpts();
    // v1.21.3 (b) — the live cell carries the active locale; a zero-arg
    // invalidation still prefix-matches it.
    expect(opts.queryKey).toEqual(queryKeys.dashboardSnapshot("en"));
  });

  it("retries once on transient failures only (network / 5xx, never 4xx)", () => {
    useDashboardSnapshot();
    const opts = lastOpts();
    expect(opts.retry).toBe(retryOnceOnTransientError);
  });

  it("seeds the widgets cache from the snapshot layout when the slot is empty", async () => {
    const layout = { widgets: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(envelopeResponse({ layout, tiles: {} })),
    );
    getQueryDataMock.mockReturnValue(undefined);
    useDashboardSnapshot();
    const opts = lastOpts();
    await (opts.queryFn as () => Promise<unknown>)();
    expect(setQueryDataMock).toHaveBeenCalledWith(
      queryKeys.dashboardWidgets(),
      layout,
    );
  });

  it("never clobbers an already-populated widgets cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          envelopeResponse({ layout: { widgets: [] }, tiles: {} }),
        ),
    );
    getQueryDataMock.mockReturnValue({ widgets: [{ id: "existing" }] });
    useDashboardSnapshot();
    const opts = lastOpts();
    await (opts.queryFn as () => Promise<unknown>)();
    expect(setQueryDataMock).not.toHaveBeenCalled();
  });
});

describe("prefetchDashboardSnapshot — hydration-safe promise handoff", () => {
  function fakeQueryClient(
    state?: { data: unknown; dataUpdatedAt: number } | undefined,
  ): QueryClient {
    return {
      // v1.21.3 (b) — the preloader probes ALL locale-keyed snapshot cells
      // via `getQueriesData` (prefix) then reads each cell's state. A fresh
      // `state` stands in for one warm locale cell; absent → no warm cell.
      getQueriesData: vi
        .fn()
        .mockReturnValue(
          state ? [[queryKeys.dashboardSnapshot("en"), state.data]] : [],
        ),
      getQueryState: vi.fn().mockReturnValue(state),
      getQueryData: getQueryDataMock,
      setQueryData: setQueryDataMock,
    } as unknown as QueryClient;
  }

  function stubFetch(
    payload: unknown = { layout: { widgets: [] }, tiles: {} },
  ) {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(envelopeResponse(payload)));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("never writes the query cache itself — the response parks until the mounted queryFn consumes it", async () => {
    const fetchMock = stubFetch();
    getQueryDataMock.mockReturnValue({ widgets: [{ id: "existing" }] });
    prefetchDashboardSnapshot(fakeQueryClient());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The prefetch must not commit data: committing pre-hydration is the
    // React #418 mismatch the handoff exists to prevent.
    expect(setQueryDataMock).not.toHaveBeenCalled();

    useDashboardSnapshot();
    const opts = lastOptsOf(useQueryMock);
    await (opts.queryFn as () => Promise<unknown>)();
    // The mounted cell consumed the in-flight request — no second fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op while a handoff is already parked", () => {
    const fetchMock = stubFetch();
    prefetchDashboardSnapshot(fakeQueryClient());
    prefetchDashboardSnapshot(fakeQueryClient());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips the fetch when the snapshot cache is still fresh", () => {
    const fetchMock = stubFetch();
    prefetchDashboardSnapshot(
      fakeQueryClient({ data: { tiles: {} }, dataUpdatedAt: Date.now() }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a cell that already carries data never parks a response, so a write's refetch reads the server as it is AFTER the write", async () => {
    // The read-after-write rule for the handoff. A parked response is a copy of
    // the server from the moment it was requested; handing it to a later
    // `queryFn` run serves pre-write data to a refetch whose entire purpose is
    // to see the write. The dashboard reaches `queryFn` again only via the
    // 120 s poll, a focus refetch, or the invalidation a mutation fires — never
    // via a remount (`refetchOnMount: false`) — so every consumer of a parked
    // response is one of those three.
    let serverBody: Record<string, unknown> = {
      layout: { widgets: [] },
      tiles: {},
      medsToday: { takenToday: 0 },
    };
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(envelopeResponse(serverBody)));
    vi.stubGlobal("fetch", fetchMock);
    getQueryDataMock.mockReturnValue({ widgets: [{ id: "existing" }] });

    // The user comes back to the dashboard after a few minutes away. The cell
    // still holds the pre-write body, so the page paints from it at once.
    prefetchDashboardSnapshot(
      fakeQueryClient({
        data: { tiles: {} },
        dataUpdatedAt: Date.now() - 5 * 60_000,
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    // They record a dose. The server now reports it taken.
    serverBody = {
      layout: { widgets: [] },
      tiles: {},
      medsToday: { takenToday: 1 },
    };

    // The write's invalidation refetches the mounted cell.
    useDashboardSnapshot();
    const opts = lastOptsOf(useQueryMock);
    const snap = await (
      opts.queryFn as () => Promise<{ medsToday: { takenToday: number } }>
    )();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(snap.medsToday.takenToday).toBe(1);
  });

  it("falls back to a fresh fetch when the preload failed — the mounted cell owns error surfacing", async () => {
    const layout = { widgets: [] };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 401"))
      .mockResolvedValueOnce(envelopeResponse({ layout, tiles: {} }));
    vi.stubGlobal("fetch", fetchMock);
    getQueryDataMock.mockReturnValue({ widgets: [{ id: "existing" }] });

    prefetchDashboardSnapshot(fakeQueryClient());
    useDashboardSnapshot();
    const opts = lastOptsOf(useQueryMock);
    const snap = await (opts.queryFn as () => Promise<{ layout: unknown }>)();
    expect(snap.layout).toEqual(layout);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("drops a parked shared-record response after the record scope changes", async () => {
    setRecordScope("shared-record");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        envelopeResponse({ layout: { owner: true }, tiles: {} }),
      )
      .mockResolvedValueOnce(
        envelopeResponse({ layout: { owner: false }, tiles: {} }),
      );
    vi.stubGlobal("fetch", fetchMock);
    getQueryDataMock.mockReturnValue({ widgets: [{ id: "existing" }] });

    prefetchDashboardSnapshot(fakeQueryClient());
    setRecordScope(null);

    useDashboardSnapshot();
    const opts = lastOptsOf(useQueryMock);
    const snapshot = await (
      opts.queryFn as () => Promise<{ layout: unknown }>
    )();

    expect(snapshot.layout).toEqual({ owner: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function lastOptsOf(mock: typeof useQueryMock): Record<string, unknown> {
  const call = mock.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![0];
}
