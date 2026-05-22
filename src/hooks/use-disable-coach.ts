"use client";

import { useContext } from "react";
import { QueryClientContext } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";

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
 * Mirrors the defensive pattern in `useFeatureFlags()`: when no
 * `QueryClientContext` is mounted we short-circuit to the "no opt-out"
 * default so the legacy tests keep rendering the surface, and the gate
 * stays correct for the production app where the provider is always
 * mounted.
 */
export function useDisableCoach(): boolean {
  const hasClient = useContext(
    QueryClientContext as unknown as React.Context<unknown>,
  );
  if (!hasClient) return false;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useDisableCoachInner();
}

function useDisableCoachInner(): boolean {
  const { user } = useAuth();
  return user?.disableCoach ?? false;
}
