import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query";

import { unstable_rethrow } from "next/navigation";
import { getUnswitchedSession } from "@/lib/auth/acting-carrier";
import { listMoodEntriesPage } from "@/lib/mood/list-read";
import { MOOD_LIST_PAGE_SIZE } from "@/lib/mood/list-page-size";
import { resolveModuleMap } from "@/lib/modules/gate";
import { queryKeys } from "@/lib/query-keys";

import MoodPageClient from "./page-client";

/**
 * Thin RSC wrapper around the (client) mood page.
 *
 * The page's primary content — the mood management list — waited for the
 * client `queryKeys.moodEntriesList(…)` cell to fetch the first page after
 * hydrate, so the first paint flashed a skeleton before the entries filled
 * in. This wrapper runs the SAME read the API route uses
 * (`listMoodEntriesPage`, shared so filter/order/wire shape cannot drift)
 * with the list's first-mount defaults during SSR and hands it to TanStack
 * through `HydrationBoundary`.
 *
 * Contract notes (the v1.30.9 dashboard template):
 *  - THE CRUX — the list key is parameterised. The seeded tuple spells the
 *    client's first-mount state exactly: no filters, page 1, the default
 *    `moodLoggedAt desc` sort, and `MOOD_LIST_PAGE_SIZE` rows (the shared
 *    constant the client's `queryFn` also uses). Any other page/filter state
 *    keys a different slot and fetches client-side as before.
 *  - The dehydrated VALUE is JSON-round-tripped so the hydrated shape is
 *    exactly what the client `queryFn` produces from the wire (ISO date
 *    strings, decrypted note as plain `note`), never a Date-carrying sibling
 *    that poisons the cell.
 *  - Module-gate parity: the client page redirects when `modules.mood` is
 *    explicitly `false`; skip the prefetch then (the client never mounts the
 *    list).
 *  - Record identity: the session comes from `getUnswitchedSession()`, which
 *    answers null while the browser is acting on somebody else's record —
 *    the prefetch must never serialise the delegate's own entries into a
 *    page opened on the owner's record.
 *  - Fail-soft: no session, a module lookup hiccup, or a read hiccup renders
 *    the page exactly as before this wrapper existed — the client cell owns
 *    the fetch.
 */
export default async function MoodPage() {
  // Global SSR-prefetch kill-switch shared with the dashboard wrapper. The e2e
  // server sets `DASHBOARD_SSR_PREFETCH=false` so Playwright route mocks — which
  // only see CLIENT fetches — keep governing what every prefetched page paints.
  if (process.env.DASHBOARD_SSR_PREFETCH === "false") {
    return <MoodPageClient />;
  }

  let dehydratedState = null;
  try {
    const session = await getUnswitchedSession();
    if (session) {
      const { user } = session;
      const modules = await resolveModuleMap(user.id);
      // Mirror the client gate (`user?.modules?.mood !== false`): an absent
      // key reads as enabled; only an explicit `false` disables.
      if (modules.mood !== false) {
        const body = await listMoodEntriesPage(user.id, {
          limit: MOOD_LIST_PAGE_SIZE,
          offset: 0,
          sortBy: "moodLoggedAt",
          sortDir: "desc",
        });
        const queryClient = new QueryClient();
        // Match the client cell's wire shape exactly (JSON semantics, ISO
        // date strings) — same-key-different-shape is silent cache poison.
        queryClient.setQueryData(
          queryKeys.moodEntriesList({
            mood: undefined,
            source: undefined,
            from: undefined,
            to: undefined,
            page: 1,
            sortBy: "moodLoggedAt",
            sortDir: "desc",
          }),
          JSON.parse(JSON.stringify(body)),
        );
        dehydratedState = dehydrate(queryClient);
      }
    }
  } catch (error) {
    // A redirect or not-found from the session resolve (the second-factor
    // confinement sends a page to `/enroll-mfa`) is the answer, not a failure.
    unstable_rethrow(error);
    // Prefetch is an accelerator, never a gate — the client path stands.
  }

  if (dehydratedState === null) {
    return <MoodPageClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <MoodPageClient />
    </HydrationBoundary>
  );
}
