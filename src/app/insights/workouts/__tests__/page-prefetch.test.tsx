import { afterEach, describe, expect, it, vi } from "vitest";
import { HydrationBoundary, hashKey } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { queryKeys } from "@/lib/query-keys";

/**
 * The `/insights/workouts` server-prefetch key crux + fail-soft.
 *
 * The RSC wrapper (`src/app/insights/workouts/page.tsx`) dehydrates the
 * workouts list so the client `useWorkouts({ limit: 8 })` cell reads it back
 * on mount instead of flashing the loading skeleton. These tests pin the
 * load-bearing rules:
 *  - the server dehydrates under the EXACT key the hook builds (byte-identical
 *    hash) — the hook passes `{ limit, offset, since, sportType }` with the
 *    last three `undefined`, so the seeded key must carry the same shape;
 *  - the value is JSON-round-tripped to the wire shape (Dates → ISO strings);
 *  - any prefetch error / a disabled module / no session fails soft to the bare
 *    client path (the client cell owns the fetch).
 */

const getUnswitchedSession = vi.fn();
const resolveModuleMap = vi.fn();
const readWorkoutsListCached = vi.fn();

vi.mock("@/lib/auth/acting-carrier", () => ({
  getUnswitchedSession: () => getUnswitchedSession(),
}));
vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: (id: string) => resolveModuleMap(id),
}));
vi.mock("@/lib/workouts/list-read", () => ({
  readWorkoutsListCached: (u: unknown, p: unknown) =>
    readWorkoutsListCached(u, p),
}));
vi.mock("../page-client", () => ({
  default: () => null,
}));

import InsightsWorkoutsPage from "../page";

const SESSION = { user: { id: "u1", timezone: "Europe/Berlin" } };

const LIST = {
  workouts: [{ id: "w1", sportType: "Running" }],
  meta: { total: 1, limit: 8, offset: 0, droppedDuplicates: 0 },
};

/**
 * The key EXACTLY as `useInfiniteWorkouts({ limit: 8 })` builds it. Offset
 * stays out of the key because it is the infinite query's page parameter.
 */
const CLIENT_KEY = queryKeys.workoutsRecentList({
  limit: 8,
  offset: undefined,
  since: undefined,
  sportType: undefined,
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.DASHBOARD_SSR_PREFETCH;
});

/** The single dehydrated query on a HydrationBoundary element, or null. */
function dehydratedQuery(
  el: ReactElement,
): { queryHash: string; state: { data: unknown } } | null {
  if (el.type !== HydrationBoundary) return null;
  const props = el.props as {
    state?: { queries: { queryHash: string; state: { data: unknown } }[] };
  };
  const q = props.state?.queries?.[0];
  return q ? { queryHash: q.queryHash, state: q.state } : null;
}

describe("/insights/workouts RSC prefetch", () => {
  it("dehydrates the list under the EXACT client key (byte-identical hash)", async () => {
    getUnswitchedSession.mockResolvedValue(SESSION);
    resolveModuleMap.mockResolvedValue({ workouts: true });
    readWorkoutsListCached.mockResolvedValue(LIST);

    const el = (await InsightsWorkoutsPage()) as ReactElement;
    const q = dehydratedQuery(el);
    expect(q).not.toBeNull();
    // The client cell looks this key up; a drift here silently no-ops the
    // prefetch and the skeleton flash comes back.
    expect(q!.queryHash).toBe(hashKey(CLIENT_KEY));
    expect(q!.state.data).toEqual({ pages: [LIST], pageParams: [0] });
  });

  it("reads the same filter the client's `limit: 8` request would", async () => {
    getUnswitchedSession.mockResolvedValue(SESSION);
    resolveModuleMap.mockResolvedValue({ workouts: true });
    readWorkoutsListCached.mockResolvedValue(LIST);

    await InsightsWorkoutsPage();
    // All-null filter params → the same `userId|||` projection cache slot the
    // `?limit=8` API request builds, so the two callers share one dedup pass.
    expect(readWorkoutsListCached).toHaveBeenCalledWith("u1", {
      limit: 8,
      offset: 0,
      since: null,
      until: null,
      sportType: null,
    });
  });

  it("JSON-round-trips the value to the wire shape (Dates → ISO strings)", async () => {
    getUnswitchedSession.mockResolvedValue(SESSION);
    resolveModuleMap.mockResolvedValue({ workouts: true });
    const startedAt = new Date("2026-07-18T08:30:00.000Z");
    readWorkoutsListCached.mockResolvedValue({
      ...LIST,
      workouts: [{ id: "w1", startedAt }],
    });

    const el = (await InsightsWorkoutsPage()) as ReactElement;
    const q = dehydratedQuery(el);
    // A Date must land as its ISO string — the shape the client's
    // (await res.json()).data would carry — never a live Date object.
    expect(q!.state.data).toEqual({
      pages: [
        {
          ...LIST,
          workouts: [{ id: "w1", startedAt: startedAt.toISOString() }],
        },
      ],
      pageParams: [0],
    });
  });

  it("fails soft to the bare client when the read throws", async () => {
    getUnswitchedSession.mockResolvedValue(SESSION);
    resolveModuleMap.mockResolvedValue({ workouts: true });
    readWorkoutsListCached.mockRejectedValue(new Error("db blip"));

    const el = (await InsightsWorkoutsPage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
  });

  it("skips the prefetch when the workouts module is off", async () => {
    getUnswitchedSession.mockResolvedValue(SESSION);
    resolveModuleMap.mockResolvedValue({ workouts: false });

    const el = (await InsightsWorkoutsPage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
    expect(readWorkoutsListCached).not.toHaveBeenCalled();
  });

  // Null also means "acting on somebody else's record" — `getUnswitchedSession`
  // collapses both into the same answer, and the page treats them the same.
  it("fails soft when there is no session", async () => {
    getUnswitchedSession.mockResolvedValue(null);
    const el = (await InsightsWorkoutsPage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
    expect(readWorkoutsListCached).not.toHaveBeenCalled();
  });

  it("honours the DASHBOARD_SSR_PREFETCH kill-switch (no session read)", async () => {
    process.env.DASHBOARD_SSR_PREFETCH = "false";
    const el = (await InsightsWorkoutsPage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
    expect(getUnswitchedSession).not.toHaveBeenCalled();
  });
});
