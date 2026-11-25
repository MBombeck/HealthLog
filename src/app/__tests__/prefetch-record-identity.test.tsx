/**
 * Whose record a server-prefetching page serialises into the HTML.
 *
 * The prefetch is a server-side copy of what a route would answer. It is only
 * ever correct when the account the RSC read equals the account the client's
 * route would serve, and under an account switch those two are never the same
 * account:
 *
 *   - `getSession()` answers who is CALLING and deliberately never the record
 *     being acted on (`src/lib/auth/session.ts`), so the RSC read the
 *     delegate's own rows;
 *   - a NON-delegable route (`/api/user/thresholds`, `/api/mood/analytics`)
 *     refuses the refetch outright, so the seeded value is what stays on
 *     screen — under a banner naming somebody else;
 *   - a DELEGABLE route (`/api/dashboard/snapshot`, `/api/daily/digest`,
 *     `/api/dashboard/widgets`, `/api/measurements/series-batch`,
 *     `/api/medications`) answers with the owner's rows, so the same page
 *     paints two people at once until the refetch lands.
 *
 * The front-door reads moved from the first bullet to the second when `/` was
 * made usable under a switch. That changed which ending a bad prefetch has,
 * not whether it is one.
 *
 * These tests assert what reaches the cache, not which branch ran. Each one
 * reads the dehydrated queries off the returned `<HydrationBoundary>` and
 * checks the payload by a marker unique to the account it came from, so a
 * prefetch that seeds the wrong person fails here even if every guard around
 * it stays green.
 *
 * Mutation checks, run:
 *   - restore `getSession()` in `src/app/page.tsx` → "seeds nothing while the
 *     session is acting on another record" goes red, PRINTING the four cache
 *     cells it found, each carrying the delegate's marker.
 *   - restore it in `src/app/medications/page.tsx` → the medications leg goes
 *     red the same way, printing the delegate's list.
 *   - make `getUnswitchedSession` return the session regardless of the carrier
 *     → both go red at once, which is the whole feature failing in one place.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HydrationBoundary, hashKey } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { queryKeys } from "@/lib/query-keys";

const getSession = vi.fn();
const resolveModuleMap = vi.fn();
const readDashboardSnapshotCached = vi.fn();
const loadDailyDigest = vi.fn();
const loadDailyMorning = vi.fn();
const readSeriesBatch = vi.fn();
const readMedicationsListCached = vi.fn();
const readRecoveryKit = vi.fn();

// The acting-carrier module is deliberately NOT mocked. The property under
// test is what a real switched session does to a real page, so the only thing
// stubbed on that path is the session row itself and the header context the
// carrier decision reads. A test that mocked `getUnswitchedSession` would
// prove the pages honour a boolean, which is not the same claim.
vi.mock("@/lib/auth/session", () => ({ getSession: () => getSession() }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: () => null }),
}));
vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: (id: string) => resolveModuleMap(id),
}));
vi.mock("@/lib/dashboard/snapshot-read", () => ({
  readDashboardSnapshotCached: (u: unknown) => readDashboardSnapshotCached(u),
}));
vi.mock("@/lib/dashboard/batch-chart-types", () => ({
  computeBatchWindow: () => ({
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-07-31T00:00:00.000Z",
  }),
  deriveBatchChartTypes: () => ["WEIGHT"],
}));
vi.mock("@/lib/dashboard-layout", () => ({
  resolveDashboardLayout: (layout: unknown) => layout,
}));
vi.mock("@/lib/daily/load-digest", () => ({
  loadDailyDigest: (u: unknown) => loadDailyDigest(u),
}));
vi.mock("@/lib/daily/morning-load", async (importOriginal) => ({
  settleTodayPair: (
    await importOriginal<typeof import("@/lib/daily/morning-load")>()
  ).settleTodayPair,
  loadDailyMorning: (u: unknown) => loadDailyMorning(u),
}));
vi.mock("@/lib/measurements/series-batch-read", () => ({
  readSeriesBatch: (...args: unknown[]) => readSeriesBatch(...args),
}));
vi.mock("@/lib/recovery/kit", () => ({
  readRecoveryKit: () => readRecoveryKit(),
}));
vi.mock("@/lib/medications/list-read", () => ({
  readMedicationsListCached: (u: unknown) => readMedicationsListCached(u),
}));
vi.mock("../page-client", () => ({ default: () => null }));
vi.mock("../medications/page-client", () => ({ default: () => null }));

import DashboardPage from "../page";
import MedicationsPage from "../medications/page";

/**
 * The account the RSC would read from. `DELEGATE_MARKER` rides every payload
 * these mocks return, so any assertion that finds it in the cache has found
 * the caller's own record dehydrated into somebody else's page.
 */
const DELEGATE_MARKER = "delegate-own-record";

const OWN_SESSION = {
  user: { id: "u-delegate", timezone: "Europe/Berlin" },
  session: { id: "s1", actingAsUserId: null },
};

/** The same caller, stamped onto the owner's record by the switch endpoint. */
const SWITCHED_SESSION = {
  user: { id: "u-delegate", timezone: "Europe/Berlin" },
  session: { id: "s1", actingAsUserId: "u-owner" },
};

const SNAPSHOT = {
  body: {
    marker: DELEGATE_MARKER,
    layout: ["weight"],
    tiles: { summaries: { WEIGHT: { count: 3 } } },
  },
  locale: "en",
};
const DIGEST = { marker: DELEGATE_MARKER, headline: "3 kg down" };
const MORNING = { marker: DELEGATE_MARKER, lead: { rank: 8 } };
const SERIES = { WEIGHT: [{ marker: DELEGATE_MARKER, value: 81.4 }] };
const MEDICATIONS = [{ id: "m1", name: DELEGATE_MARKER }];

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.DASHBOARD_SSR_PREFETCH;
});

/** Every dehydrated query on a HydrationBoundary element, keyed by hash. */
function seededCache(el: ReactElement): Record<string, unknown> {
  if (el.type !== HydrationBoundary) return {};
  const props = el.props as {
    state?: { queries: { queryHash: string; state: { data: unknown } }[] };
  };
  const out: Record<string, unknown> = {};
  for (const q of props.state?.queries ?? []) out[q.queryHash] = q.state.data;
  return out;
}

function primeDashboard() {
  resolveModuleMap.mockResolvedValue({ insights: true });
  readDashboardSnapshotCached.mockResolvedValue(SNAPSHOT);
  loadDailyDigest.mockResolvedValue(DIGEST);
  loadDailyMorning.mockResolvedValue(MORNING);
  readSeriesBatch.mockResolvedValue({ series: SERIES });
}

describe("the dashboard prefetch and the record on screen", () => {
  it("seeds the caller's own record when no switch is active", async () => {
    // The positive half, and it is not decoration: it fixes what the negative
    // half is the absence of. Without it, a page that prefetched nothing at
    // all for anybody would pass the switch test perfectly.
    getSession.mockResolvedValue(OWN_SESSION);
    primeDashboard();

    const cache = seededCache((await DashboardPage()) as ReactElement);

    expect(cache[hashKey(queryKeys.dashboardSnapshot("en"))]).toMatchObject({
      marker: DELEGATE_MARKER,
    });
    expect(cache[hashKey(queryKeys.dailyDigest())]).toMatchObject({
      marker: DELEGATE_MARKER,
    });
    expect(cache[hashKey(queryKeys.dailyMorning())]).toMatchObject({
      marker: DELEGATE_MARKER,
    });
    expect(
      cache[
        hashKey(
          queryKeys.chartSeriesBatch(
            "WEIGHT",
            "2026-07-01T00:00:00.000Z",
            "2026-07-31T00:00:00.000Z",
          ),
        )
      ],
    ).toMatchObject(SERIES);
  });

  it("seeds the recovery-kit status for an admin only", async () => {
    // The banner above the hero reads it; seeded, it is in the first HTML
    // instead of pushing the page down once it arrives.
    primeDashboard();
    readRecoveryKit.mockResolvedValue({ due: true, keys: [], unconfirmed: [] });

    getSession.mockResolvedValue({
      ...OWN_SESSION,
      user: { ...OWN_SESSION.user, role: "ADMIN" },
    });
    const admin = seededCache((await DashboardPage()) as ReactElement);
    expect(admin[hashKey(queryKeys.adminRecoveryKit())]).toEqual({
      due: true,
      keys: [],
      unconfirmed: [],
    });

    readRecoveryKit.mockClear();
    getSession.mockResolvedValue(OWN_SESSION);
    const user = seededCache((await DashboardPage()) as ReactElement);
    expect(user[hashKey(queryKeys.adminRecoveryKit())]).toBeUndefined();
    expect(readRecoveryKit).not.toHaveBeenCalled();
  });

  it("seeds nothing while the session is acting on another record", async () => {
    // The session row carries the owner's id, which is what a switch IS on the
    // cookie transport. Asserted on the CACHE rather than on a call count: a
    // future prefetch that reads through some other helper still has to put
    // its result somewhere, and this is where it would show up.
    getSession.mockResolvedValue(SWITCHED_SESSION);
    primeDashboard();

    const el = (await DashboardPage()) as ReactElement;
    const cache = seededCache(el);

    // Asserted as a whole-object equality on purpose: the failure message
    // then PRINTS the record that reached the cache, marker and all, instead
    // of saying a boolean was wrong.
    expect(cache).toEqual({});
    expect(el.type).not.toBe(HydrationBoundary);
    expect(readDashboardSnapshotCached).not.toHaveBeenCalled();
    expect(loadDailyDigest).not.toHaveBeenCalled();
    expect(loadDailyMorning).not.toHaveBeenCalled();
    expect(readSeriesBatch).not.toHaveBeenCalled();
  });

  it("seeds the digest and the morning both or neither", async () => {
    // The morning block renders from the two. One without the other would
    // paint the fallback hero on the server and swap the sentence after
    // hydration; over the budget both stay out and the block is a skeleton on
    // both sides.
    getSession.mockResolvedValue(OWN_SESSION);
    primeDashboard();
    loadDailyMorning.mockReturnValue(new Promise(() => {}));
    const slowMorning = seededCache((await DashboardPage()) as ReactElement);
    expect(slowMorning[hashKey(queryKeys.dailyMorning())]).toBeUndefined();
    expect(slowMorning[hashKey(queryKeys.dailyDigest())]).toBeUndefined();

    primeDashboard();
    loadDailyDigest.mockRejectedValue(new Error("pool"));
    const failedDigest = seededCache((await DashboardPage()) as ReactElement);
    expect(failedDigest[hashKey(queryKeys.dailyMorning())]).toBeUndefined();
    expect(failedDigest[hashKey(queryKeys.dailyDigest())]).toBeUndefined();
  });
});

describe("the medications prefetch and the record on screen", () => {
  it("seeds the caller's own list when no switch is active", async () => {
    getSession.mockResolvedValue(OWN_SESSION);
    resolveModuleMap.mockResolvedValue({ medications: true });
    readMedicationsListCached.mockResolvedValue(MEDICATIONS);

    const cache = seededCache((await MedicationsPage()) as ReactElement);
    // The route's rows, with the caller's registry search (none here).
    expect(cache[hashKey(queryKeys.medications())]).toEqual(
      MEDICATIONS.map((row) => ({ ...row, leafletSearch: null })),
    );
  });

  it("seeds nothing while the session is acting on another record", async () => {
    // `/api/medications` IS delegable, so the client cell corrects itself on
    // its `refetchOnMount: "always"` pass. What it cannot undo is the frame
    // before that: somebody else's medicine cabinet, painted under a banner
    // naming the owner.
    getSession.mockResolvedValue(SWITCHED_SESSION);
    resolveModuleMap.mockResolvedValue({ medications: true });
    readMedicationsListCached.mockResolvedValue(MEDICATIONS);

    const el = (await MedicationsPage()) as ReactElement;
    const cache = seededCache(el);

    // Asserted as a whole-object equality on purpose: the failure message
    // then PRINTS the record that reached the cache, marker and all, instead
    // of saying a boolean was wrong.
    expect(cache).toEqual({});
    expect(el.type).not.toBe(HydrationBoundary);
    expect(readMedicationsListCached).not.toHaveBeenCalled();
  });
});
