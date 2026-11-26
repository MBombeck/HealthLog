import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query";

import { unstable_rethrow } from "next/navigation";
import { getUnswitchedSession } from "@/lib/auth/acting-carrier";
import { listMeasurementReminders } from "@/lib/measurement-reminders/list-read";
import { queryKeys } from "@/lib/query-keys";

import CarePageClient from "./page-client";

/**
 * Thin RSC wrapper around the (client) Care page.
 *
 * The page's above-the-fold content — the Vorsorge reminder list — waited for
 * the client `queryKeys.measurementReminders()` cell to fetch after hydrate,
 * so the first paint flashed a skeleton before the list filled in. This
 * wrapper runs the SAME read the API route uses (`listMeasurementReminders`,
 * shared so filter/order/DTO cannot drift) during SSR and hands it to
 * TanStack through `HydrationBoundary`.
 *
 * Contract notes (the v1.30.9 dashboard template):
 *  - The query key comes ONLY from the central factory —
 *    `queryKeys.measurementReminders()` is a deterministic zero-arg tuple, so
 *    the server-seeded key equals the client's `useQuery` key by construction.
 *  - The dehydrated VALUE is JSON-round-tripped so the hydrated shape is
 *    exactly what the client `queryFn` produces from the wire (ISO date
 *    strings), never a Date-carrying sibling that poisons the cell.
 *  - Only the PRIMARY read is prefetched. The visits tab mounts its own read
 *    lazily on first open, and that stays client-lazy on purpose — most
 *    visits to this page never open it.
 *  - Record identity: the session comes from `getUnswitchedSession()`, which
 *    answers null while the browser is acting on somebody else's record —
 *    the prefetch must never serialise the delegate's own reminders into a
 *    page opened on the owner's record.
 *  - Fail-soft: no session or a read hiccup renders the page exactly as
 *    before this wrapper existed — the client cell owns the fetch.
 */
export default async function CarePage() {
  // Global SSR-prefetch kill-switch shared with the dashboard wrapper. The e2e
  // server sets `DASHBOARD_SSR_PREFETCH=false` so Playwright route mocks — which
  // only see CLIENT fetches — keep governing what every prefetched page paints.
  if (process.env.DASHBOARD_SSR_PREFETCH === "false") {
    return <CarePageClient />;
  }

  let dehydratedState = null;
  try {
    const session = await getUnswitchedSession();
    if (session) {
      const list = await listMeasurementReminders(session.user.id);
      const queryClient = new QueryClient();
      // Match the client cell's wire shape exactly (JSON semantics, ISO date
      // strings) — same-key-different-shape is silent cache poison.
      queryClient.setQueryData(
        queryKeys.measurementReminders(),
        JSON.parse(JSON.stringify(list)),
      );
      dehydratedState = dehydrate(queryClient);
    }
  } catch (error) {
    // A redirect or not-found from the session resolve (the second-factor
    // confinement sends a page to `/enroll-mfa`) is the answer, not a failure.
    unstable_rethrow(error);
    // Prefetch is an accelerator, never a gate — the client path stands.
  }

  if (dehydratedState === null) {
    return <CarePageClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <CarePageClient />
    </HydrationBoundary>
  );
}
