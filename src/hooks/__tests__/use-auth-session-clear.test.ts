/**
 * Cross-user in-memory cache leak (v1.25.1).
 *
 * The root QueryClient is created once and survives every client-side
 * navigation, so logout→login on the same browser used to leave the previous
 * account's NON-user-scoped health-data queries (`["measurements"]`,
 * `["dashboard","snapshot"]`, …) sitting in memory — the next account read
 * them before any refetch landed. `clearCachesForSessionEnd` drops the entire
 * in-memory cache at the session boundary; this test pins that guarantee on a
 * real QueryClient.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";

// The offline-cache wipe touches IndexedDB + the SW caches, neither of which
// exists in the node test env — mock it to a spy so we can assert it still
// runs alongside the in-memory clear without booting a browser.
const clearOfflineCachesForSessionEnd = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/pwa/query-persister", () => ({
  clearOfflineCachesForSessionEnd: () => clearOfflineCachesForSessionEnd(),
}));

// The day layer's remembered date is a date of the ending account's record.
const clearLastDay = vi.fn();
vi.mock("@/lib/day/last-day", () => ({
  clearLastDay: () => clearLastDay(),
}));

// Coach deletes the ending session could not confirm belong to its account.
const clearCoachDeleteJournal = vi.fn();
vi.mock("@/lib/ai/coach/delete-journal", () => ({
  clearCoachDeleteJournal: () => clearCoachDeleteJournal(),
}));

// `use-auth` pulls in the typed fetch wrapper, the router, and the i18n
// context at module load. None of them matter for the pure session-end
// helper, so stub them so the import is side-effect free in the test env.
vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: vi.fn(),
  apiFetchRaw: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({ t: (key: string) => key }),
}));

import { clearCachesForSessionEnd } from "../use-auth";

afterEach(() => {
  clearOfflineCachesForSessionEnd.mockClear();
  clearLastDay.mockClear();
  clearCoachDeleteJournal.mockClear();
});

describe("clearCachesForSessionEnd — cross-user in-memory wipe", () => {
  it("drops every in-memory query, including non-auth health data, at the session boundary", () => {
    const queryClient = new QueryClient();

    // Seed the cache as a logged-in account would leave it: an auth/me entry
    // plus a non-user-scoped health-data family.
    queryClient.setQueryData(queryKeys.authMe(), { id: "account-a" });
    queryClient.setQueryData(["measurements"], [{ id: "m1", value: 72 }]);
    queryClient.setQueryData(["dashboard", "snapshot"], { weightKg: 80 });

    expect(queryClient.getQueryCache().getAll().length).toBeGreaterThan(0);

    clearCachesForSessionEnd(queryClient);

    // Nothing survives into the next session: the in-memory cache is empty,
    // so the health-data entries can never render for the next account.
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(queryClient.getQueryData(["measurements"])).toBeUndefined();
    expect(queryClient.getQueryData(["dashboard", "snapshot"])).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.authMe())).toBeUndefined();

    // The persisted IndexedDB + SW caches are still wiped alongside the
    // in-memory clear — the existing offline-leak guard stays intact.
    expect(clearOfflineCachesForSessionEnd).toHaveBeenCalledTimes(1);
  });

  it("forgets the day the layer last showed", () => {
    clearCachesForSessionEnd(new QueryClient());
    expect(clearLastDay).toHaveBeenCalledTimes(1);
  });

  it("clears the Coach delete journal", () => {
    clearCachesForSessionEnd(new QueryClient());
    expect(clearCoachDeleteJournal).toHaveBeenCalledTimes(1);
  });
});
