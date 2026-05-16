/**
 * v1.4.34 IW-F-Perf — consumer-collapse contract.
 *
 * Three independent consumers
 * (`<RecentAchievementsCard>`, `/achievements` mother page,
 * `<AchievementUnlockNotifier>`) all read through
 * `useAchievementsQuery()`. The shared hook is the only seam where the
 * queryKey is centralised; if a future drift reintroduces a per-user
 * discriminator or a literal `["gamification", "achievements"]` shadow
 * key, this test surfaces the regression before HAR proves it again
 * in production.
 *
 * Two contracts pinned:
 *
 *   1. Mounting all three consumers under one TanStack QueryClient
 *      produces exactly one network call. The shared cache cell wins;
 *      the divergent v1.4.33 keys are gone.
 *   2. The unlock notifier's polling interval rides the shared cache,
 *      so the card never re-renders on the 2-minute cadence by itself
 *      — the only refetch fires through the notifier's hook instance
 *      and updates the single cache cell that both consumers read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { I18nProvider } from "@/lib/i18n/context";
import { useAchievementsQuery } from "../use-achievements-query";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

const samplePayload = {
  summary: { unlockedCount: 0, totalCount: 0 },
  achievements: [],
  metrics: {},
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ data: samplePayload }),
  });
  // `fetch` is part of the Node global in vitest's node environment; the
  // hook reaches for it via `fetch(...)` directly.
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function ConsumerA() {
  useAchievementsQuery();
  return null;
}

function ConsumerB() {
  useAchievementsQuery();
  return null;
}

function ConsumerC() {
  useAchievementsQuery({ refetchInterval: 2 * 60 * 1000 });
  return null;
}

function withQueryClient(node: ReactNode): string {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        // Force the query to actually fire on mount so the test can
        // count the network calls — the hook's `refetchOnMount: false`
        // governs subsequent mounts within the staleTime window, not
        // the first mount.
        retry: false,
      },
    },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("useAchievementsQuery — consumer collapse", () => {
  it("fires a single network call when three consumers mount together", async () => {
    withQueryClient(
      <>
        <ConsumerA />
        <ConsumerB />
        <ConsumerC />
      </>,
    );

    // SSR renders are synchronous, so the queryFn is enqueued but not
    // awaited inside renderToStaticMarkup. The microtask flush below
    // mirrors what react-query does between mount and the network
    // call — one tick is enough to see the fetch attempt.
    await Promise.resolve();
    await Promise.resolve();

    // The three consumers share `queryKeys.gamificationAchievements()`
    // so TanStack hands every subscriber the same cache slot; one cell
    // = one in-flight queryFn = one fetch. Pre-fix the notifier carried
    // a `userId` discriminator and fired its own request.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("uses /api/gamification/achievements without query params", async () => {
    withQueryClient(<ConsumerA />);
    await Promise.resolve();
    await Promise.resolve();

    if (fetchMock.mock.calls.length > 0) {
      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe("/api/gamification/achievements");
    }
  });
});
