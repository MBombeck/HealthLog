import {
  QueryClient,
  environmentManager,
  type DefaultError,
  type DefaultOptions,
  type DefaultedQueryObserverOptions,
  type QueryKey,
  type QueryObserverOptions,
} from "@tanstack/react-query";

import { recordScopedQueryKeyHashFn } from "@/lib/query-keys/record-scope";

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
 *
 * v1.36.0 — `queryKeyHashFn` folds the record being read into the cache
 * identity of every entry in the app. Without it `["dashboard","snapshot"]`
 * names two different people's data and the cache cannot tell them apart. See
 * `src/lib/query-keys/record-scope.ts` for why this sits on the hash rather
 * than on the key arrays (the arrays feed prefix invalidation and the
 * import-time dependent-key bundles, both of which would break).
 */
export const QUERY_CLIENT_DEFAULT_OPTIONS: DefaultOptions = {
  queries: {
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryKeyHashFn: recordScopedQueryKeyHashFn,
  },
  mutations: {
    networkMode: "always",
  },
};

/**
 * The app's `QueryClient`. It differs from a plain one in a single rule: on
 * the server, no cache entry schedules its own garbage collection.
 *
 * `Providers` creates this client once per render, so on the server it lives
 * exactly as long as one request. A finite `gcTime` (the ten minutes above, or
 * a call site's own) makes every entry the render builds start a timer of that
 * length, `useQuery` with `enabled: false` included. A Node timer keeps the
 * async context it was created in, and that context is the request's: its
 * response, the React Flight stream, the compressed body. So each server render
 * stayed reachable for ten minutes after it was answered, about 250 KB per
 * request, and a scanner walking a few hundred unknown paths pushed the heap
 * into the hundreds of megabytes on not-found pages alone.
 *
 * The library already defaults `gcTime` to `Infinity` on the server for this
 * reason; an explicit value from the defaults or from a hook overrides it.
 * Folding `Infinity` back in at `defaultQueryOptions`, the one merge point every
 * observer, cache build and hydration goes through, restores that default
 * whatever a caller passes. The server cache then goes with the client at the
 * end of the request. In the browser nothing changes.
 *
 * Mutations need no counterpart: a mutation is built when `mutate` runs, which
 * a server render never does.
 */
export class AppQueryClient extends QueryClient {
  override defaultQueryOptions<
    TQueryFnData = unknown,
    TError = DefaultError,
    TData = TQueryFnData,
    TQueryData = TQueryFnData,
    TQueryKey extends QueryKey = QueryKey,
    TPageParam = never,
  >(
    options:
      | QueryObserverOptions<
          TQueryFnData,
          TError,
          TData,
          TQueryData,
          TQueryKey,
          TPageParam
        >
      | DefaultedQueryObserverOptions<
          TQueryFnData,
          TError,
          TData,
          TQueryData,
          TQueryKey
        >,
  ): DefaultedQueryObserverOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryData,
    TQueryKey
  > {
    const defaulted = super.defaultQueryOptions(options);
    if (!environmentManager.isServer() || defaulted.gcTime === Infinity) {
      return defaulted;
    }
    return { ...defaulted, gcTime: Infinity };
  }
}

/** The client `Providers` mounts: the app's defaults on an `AppQueryClient`. */
export function createAppQueryClient(): QueryClient {
  return new AppQueryClient({ defaultOptions: QUERY_CLIENT_DEFAULT_OPTIONS });
}
