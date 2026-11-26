import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query";

import { unstable_rethrow } from "next/navigation";
import { getUnswitchedSession } from "@/lib/auth/acting-carrier";
import { readCoachNudgeStatus } from "@/lib/ai/coach/nudge-status";
import { loadAiCapabilityInputs } from "@/lib/ai/capabilities/load";
import { resolveAiCapability } from "@/lib/ai/capabilities/resolve";
import type { AiCapabilityState } from "@/lib/ai/capabilities/types";
import { queryKeys } from "@/lib/query-keys";

import CoachPageClient from "./page-client";

/**
 * Thin RSC wrapper around the (client) full-page Coach.
 *
 * The default new-chat hero path carries the one genuine sequential waterfall
 * on this route: the client `coachNudgeStatus` cell fetches
 * `/api/insights/coach/nudge-status` after hydrate, and the conversation's
 * `autoOpenMostRecent` decision is gated on that result — so the hero "pops in
 * after a beat" while the nudge round-trip resolves. This wrapper runs the SAME
 * read the API route uses (`readCoachNudgeStatus`) during SSR and hands it to
 * TanStack via `HydrationBoundary`, so the auto-open decision is available at
 * hydrate and the waterfall step collapses.
 *
 * Contract notes (the v1.30.9 dashboard template):
 *  - The query key comes ONLY from the central factory —
 *    `queryKeys.coachNudgeStatus()` is a deterministic zero-arg tuple, so the
 *    server-seeded key equals the client's `useQuery` key by construction.
 *  - The dehydrated VALUE is JSON-round-tripped; the read already returns ISO
 *    strings, so the shape is byte-identical to the client's
 *    ((await res.json()).data) wire.
 *  - The client cell carries `staleTime: 5min` with the default
 *    `refetchOnMount`, so the seeded fresh value is used at hydrate without an
 *    immediate refetch. When the client query is disabled (a `?c=`/`?doc=`/
 *    `?scope=` deep-link makes it `enabled: false`) the seeded value simply
 *    sits unused — harmless.
 *  - Availability parity: prefetch only when the `coach` capability is
 *    available for the caller's own record, resolved from every layer (the
 *    operator switch, the `disableCoach` opt-out, provider presence and
 *    consent) by the same resolver the API routes use. An unavailable Coach
 *    does no wasted work. The seeded value carries the same `ai` state the
 *    nudge-status route returns, so the hydrated shape equals the wire.
 *  - Left CLIENT-LAZY on purpose: the streaming conversation itself (the SSE
 *    thread, snapshot, any provider-touching path) is NOT prefetched or warmed
 *    — it depends on URL params + the nudge outcome and must never be triggered
 *    server-side.
 *  - Record identity: the session comes from `getUnswitchedSession()`, which
 *    answers null while the browser is acting on somebody else's record. Every
 *    read below scopes to the CALLER, so under a switch the prefetch would
 *    serialise the delegate's own rows into a page opened on the owner's
 *    record. The accessor's docblock carries the argument.
 *  - Fail-soft: no session, the Coach being off, or a DB blip renders the page
 *    exactly as before this wrapper existed — the client cell owns the fetch.
 */
/**
 * The `coach` capability for the caller's own record. An RSC has no request
 * event, so the route gate cannot resolve the record from it; the unswitched
 * session is always the caller's own record, read with the owner's authority.
 */
async function coachCapabilityForOwnRecord(
  userId: string,
): Promise<AiCapabilityState> {
  const inputs = await loadAiCapabilityInputs({
    recordId: userId,
    authority: {
      origin: "owner",
      recordUserId: userId,
      actorUserId: userId,
      grantId: null,
    },
    sections: null,
    recordKind: "self",
  });
  return resolveAiCapability("coach", inputs);
}

export default async function CoachPage() {
  // Global SSR-prefetch kill-switch shared with the dashboard wrapper. The e2e
  // server sets `DASHBOARD_SSR_PREFETCH=false` so Playwright route mocks — which
  // only see CLIENT fetches — keep governing what every prefetched page paints.
  if (process.env.DASHBOARD_SSR_PREFETCH === "false") {
    return <CoachPageClient />;
  }

  let dehydratedState = null;
  try {
    const session = await getUnswitchedSession();
    const ai = session
      ? await coachCapabilityForOwnRecord(session.user.id)
      : null;
    // An unavailable Coach skips the prefetch; the client path stands (and
    // redirects to /insights).
    if (session && ai?.available) {
      const nudge = await readCoachNudgeStatus(session.user.id);
      const queryClient = new QueryClient();
      queryClient.setQueryData(
        queryKeys.coachNudgeStatus(),
        JSON.parse(JSON.stringify({ ...nudge, ai })),
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
    return <CoachPageClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <CoachPageClient />
    </HydrationBoundary>
  );
}
