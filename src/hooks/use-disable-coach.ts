"use client";

import { useAuth } from "@/hooks/use-auth";
import { useQueryClientMounted } from "@/hooks/_internal/use-query-client-safe";

/**
 * v1.4.47 W3 — SSR-safe accessor for the per-user "Hide Coach" toggle.
 *
 * `useAuth()` calls `useQuery` directly and crashes when the caller
 * SSR-renders without a `<QueryClientProvider>` (the legacy
 * Coach-surface unit tests do exactly this). The cascade-test fixture
 * + the dedicated disable-cascade fixture both seed a client, but the
 * long-tail SSR snapshot tests (`<SuggestedPrompts>`, `<LayoutCoachFab>`,
 * `<HeroStrip>` …) render the component in isolation and don't.
 *
 * v1.4.48 M4 — share the `<QueryClientProvider>`-mount detection with
 * `useFeatureFlags()` via the `_internal/use-query-client-safe`
 * helper. When no client is mounted we short-circuit to the "no
 * opt-out" default; the inner hook is only invoked once the provider
 * is known to be in the tree, so the conditional call is safe per the
 * Rules of Hooks (the branch is stable across the component's
 * lifetime).
 */
export function useDisableCoach(): boolean {
  const hasClient = useQueryClientMounted();
  if (!hasClient) return false;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useDisableCoachInner();
}

function useDisableCoachInner(): boolean {
  const { user } = useAuth();
  return user?.disableCoach ?? false;
}
