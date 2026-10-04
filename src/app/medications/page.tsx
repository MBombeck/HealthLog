import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query";

import { getUnswitchedSession } from "@/lib/auth/acting-carrier";
import { readMedicationsListCached } from "@/lib/medications/list-read";
import { resolveModuleMap } from "@/lib/modules/gate";
import { queryKeys } from "@/lib/query-keys";

import MedicationsPageClient from "./page-client";

/**
 * Thin RSC wrapper around the (client) medications page.
 *
 * `/medications` is a high-traffic surface whose above-the-fold content — the
 * medication cards — waited for the client `queryKeys.medications()` cell to
 * fetch `/api/medications` after hydrate, so the first paint flashed skeletons
 * before the list filled in. This wrapper runs the SAME cached read the API
 * route uses (`readMedicationsListCached`, the shared `caches.medications` SWR
 * cell) during SSR and hands it to TanStack through `HydrationBoundary`, so the
 * mounted list cell starts warm instead of skeleton-first.
 *
 * Contract notes (the v1.30.9 dashboard template):
 *  - The query key comes ONLY from the central factory — `queryKeys.medications()`
 *    is a deterministic zero-arg tuple, so the server-seeded key equals the
 *    client's `useQuery` key by construction (no window/locale param to drift).
 *  - The dehydrated VALUE is JSON-round-tripped so the hydrated shape is exactly
 *    what the client `queryFn` produces from the wire ((await res.json()).data —
 *    Prisma `Date`s as ISO strings, Decimals as their JSON form), never a
 *    Date-carrying sibling that would poison the cell.
 *  - Module-gate parity: the client list query is gated on the `medications`
 *    module being on; skip the prefetch when it is off (the client cell is
 *    disabled then too, and the page renders nothing).
 *  - The client cell keeps `refetchOnMount: "always"` — it is a correctness
 *    gate, not a redundancy: a cross-device / cross-surface take/skip (the iOS
 *    app, a notification action, a second tab) produces no client mutation
 *    event, so the list must re-verify on every mount. With the prefetch in
 *    place the hydrated cards paint immediately and that refetch runs in the
 *    background — the "empty then fills" flash is gone WITHOUT dropping the
 *    freshness guarantee. The one exception is data a prefetch fired by this
 *    same navigation just fetched (`refetchMedicationsOnMount`): that already
 *    is the re-verification, so it is not sent twice.
 *  - Record identity: the session comes from `getUnswitchedSession()`, which
 *    answers null while the browser is acting on somebody else's record.
 *    `/api/medications` IS delegable, so the client cell corrects itself on its
 *    `refetchOnMount: "always"` pass — but the frame before that correction
 *    painted the DELEGATE's medicine cabinet under a banner naming the owner,
 *    and a flash of the wrong person's medication is still the wrong person's
 *    medication.
 *  - Fail-soft: no session, an active switch, a module lookup hiccup, or a DB
 *    blip renders the page exactly as before this wrapper existed — the client
 *    cell owns the fetch. The prefetch is an accelerator, never a gate.
 */
export default async function MedicationsPage() {
  // Global SSR-prefetch kill-switch shared with the dashboard wrapper. The e2e
  // server sets `DASHBOARD_SSR_PREFETCH=false` so Playwright route mocks — which
  // only see CLIENT fetches — keep governing what every prefetched page paints.
  if (process.env.DASHBOARD_SSR_PREFETCH === "false") {
    return <MedicationsPageClient />;
  }

  let dehydratedState = null;
  try {
    const session = await getUnswitchedSession();
    if (session) {
      const { user } = session;
      const modules = await resolveModuleMap(user.id);
      // Mirror the client gate (`user?.modules?.medications !== false`): an
      // absent key reads as enabled; only an explicit `false` disables.
      if (modules.medications !== false) {
        const list = await readMedicationsListCached(user);
        const queryClient = new QueryClient();
        // Match the client cell's wire shape exactly (JSON semantics, ISO date
        // strings) — same-key-different-shape is silent cache poison.
        queryClient.setQueryData(
          queryKeys.medications(),
          JSON.parse(JSON.stringify(list)),
        );
        dehydratedState = dehydrate(queryClient);
      }
    }
  } catch {
    // Prefetch is an accelerator, never a gate — the client path stands.
  }

  if (dehydratedState === null) {
    return <MedicationsPageClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <MedicationsPageClient />
    </HydrationBoundary>
  );
}
