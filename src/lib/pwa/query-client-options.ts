import type { DefaultOptions, QueryClient } from "@tanstack/react-query";

export const MEANINGFUL_HIDDEN_INTERVAL_MS = 60_000;

interface VisibilityTarget {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: EventListener): void;
  removeEventListener(type: "visibilitychange", listener: EventListener): void;
}

/**
 * Refresh stale server state when an installed PWA resumes after a meaningful
 * absence. The hidden timestamp is consumed by the first matching visible
 * event, so duplicate browser lifecycle events cannot trigger a refresh burst.
 */
export function subscribeToMeaningfulVisibilityRefresh(
  queryClient: QueryClient,
  visibilityTarget: VisibilityTarget = document,
  now: () => number = Date.now,
): () => void {
  let hiddenAt: number | null = null;

  const onVisibilityChange = () => {
    if (visibilityTarget.visibilityState === "hidden") {
      hiddenAt ??= now();
      return;
    }

    if (visibilityTarget.visibilityState !== "visible" || hiddenAt === null) {
      return;
    }

    const hiddenFor = now() - hiddenAt;
    hiddenAt = null;
    if (hiddenFor < MEANINGFUL_HIDDEN_INTERVAL_MS) return;

    void queryClient.refetchQueries({ type: "active", stale: true });
  };

  visibilityTarget.addEventListener("visibilitychange", onVisibilityChange);
  return () =>
    visibilityTarget.removeEventListener(
      "visibilitychange",
      onVisibilityChange,
    );
}

/**
 * Shared TanStack Query default options for the app's single `QueryClient`.
 * Extracted from `providers.tsx` so the offline-mutation contract (F-OFF-1) is
 * unit-testable without importing the whole client-component tree.
 *
 * Mutations run in `always` network mode. The library default (`online`) PAUSES
 * a mutation fired offline — `isPending` stays true forever, `onError` never
 * fires, and the paused mutation is silently DROPPED on reload, so a health
 * entry vanishes with no "not saved" signal. In `always` mode the mutation runs
 * regardless, the offline `fetch` rejects immediately, and `onError` fires — an
 * honest failure the form surfaces (and the global `OfflineMutationToaster`
 * backstops), instead of a spinner-of-death plus silent write loss.
 */
export const QUERY_CLIENT_DEFAULT_OPTIONS: DefaultOptions = {
  queries: {
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  },
  mutations: {
    networkMode: "always",
  },
};
