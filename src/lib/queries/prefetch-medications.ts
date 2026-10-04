import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";

/**
 * v1.16.7 — intent-based data prefetch for the medications page.
 *
 * The nav links already prefetch the route's JS chunk (next/link
 * default in production); what still serialised the first visit was
 * the data hop — the list query only fired once the page chunk had
 * mounted. Wiring this to the nav link's hover / touch / focus intent
 * puts `/api/medications` (the response carries the per-medication
 * `nextDueAt` due times) in flight while the navigation commits.
 *
 * v1.16.8 — the batched card-compliance read
 * (`/api/medications/compliance`) prefetches alongside the list, so the
 * compliance bars + the status line resolve in the same paint as the
 * cards instead of swapping in late. Two independent requests on
 * purpose: the list response must stay fast (the due line never waits
 * on a compliance ledger build), and the compliance prefetch rides the
 * same server-side cache cells the page query would warm anyway.
 *
 * The 15 s prefetch window only bounds how old a cache entry may be
 * before an intent re-fires the request — the mounted page query rides
 * the provider-default `staleTime` (5 min) and consumes whatever this
 * prefetch parked. The server caches both reads per user (60 s list /
 * 15 min compliance, each with an SWR window), so even a missed window
 * stays cheap.
 */
export const MEDICATIONS_LIST_STALE_TIME_MS = 15_000;

/**
 * How long after a prefetch STARTED its data still counts as this visit's
 * fresh read. Wide enough to span hover → click → route commit → mount on a
 * slow device; far below any gap in which another surface could have
 * written something the user would expect to see.
 */
export const MEDICATIONS_PREFETCH_COVERS_MOUNT_MS = 10_000;

type MedicationsRead = "list" | "compliance";

/** When the last prefetch that actually went to the network started. */
const prefetchStartedAt = new Map<MedicationsRead, number>();

function prefetchRead(
  queryClient: QueryClient,
  read: MedicationsRead,
  queryKey: readonly unknown[],
  path: string,
  signal?: AbortSignal,
): void {
  const state = queryClient.getQueryState(queryKey);
  const willFetch =
    state?.fetchStatus !== "fetching" &&
    (!state ||
      state.dataUpdatedAt < Date.now() - MEDICATIONS_LIST_STALE_TIME_MS);
  if (willFetch) prefetchStartedAt.set(read, Date.now());
  void queryClient.prefetchQuery({
    queryKey,
    queryFn: () => apiGet(path, { signal }),
    staleTime: MEDICATIONS_LIST_STALE_TIME_MS,
  });
}

export function prefetchMedicationsList(
  queryClient: QueryClient,
  signal?: AbortSignal,
): void {
  prefetchRead(
    queryClient,
    "list",
    queryKeys.medications(),
    "/api/medications",
    signal,
  );
  prefetchRead(
    queryClient,
    "compliance",
    queryKeys.medicationComplianceSummary(),
    "/api/medications/compliance",
    signal,
  );
}

/**
 * `refetchOnMount` for the medications reads that must re-verify on every
 * visit (#316: a take or skip on another device produces no event here).
 *
 * Still "always", except when the cached data is the answer to a prefetch
 * that this same navigation fired moments ago: the hover / touch / focus
 * intent on the nav link, or the route-commit preload. Leaving the page ends
 * that navigation (`forgetMedicationsPrefetch`). Re-asking then sent
 * the identical request a second time, a few hundred milliseconds after the
 * first answer landed, on every visit to the page. A return to the page with
 * an older cache entry, or a direct load, still refetches on mount.
 */
export function refetchMedicationsOnMount(
  read: MedicationsRead,
): (query: { state: { dataUpdatedAt: number } }) => boolean | "always" {
  return (query) => {
    const startedAt = prefetchStartedAt.get(read);
    const answeredThisVisit =
      startedAt !== undefined &&
      query.state.dataUpdatedAt >= startedAt &&
      Date.now() - startedAt < MEDICATIONS_PREFETCH_COVERS_MOUNT_MS;
    return answeredThisVisit ? false : "always";
  };
}

/**
 * End the visit a recorded prefetch belongs to. Called whenever the route is
 * anything but `/medications`, so a prefetch only ever excuses the mounts of
 * the visit it was fired for: leave the page and come back within seconds,
 * and the remount still re-verifies.
 */
export function forgetMedicationsPrefetch(): void {
  prefetchStartedAt.clear();
}

/**
 * Intent props for a nav link pointing at `/medications` — fires the
 * list prefetch on hover / touch / keyboard focus, i.e. before the
 * router even commits. `prefetchQuery` dedupes internally (in-flight
 * promise reuse + the stale window above), so the three handlers and a
 * subsequent route-commit prefetch collapse into at most one request.
 */
export function medicationsPrefetchIntentProps(queryClient: QueryClient): {
  onPointerEnter: () => void;
  onTouchStart: () => void;
  onFocus: () => void;
} {
  const fire = () => prefetchMedicationsList(queryClient);
  return { onPointerEnter: fire, onTouchStart: fire, onFocus: fire };
}
