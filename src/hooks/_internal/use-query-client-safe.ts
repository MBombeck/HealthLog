"use client";

import { useContext } from "react";
import { QueryClientContext } from "@tanstack/react-query";

/**
 * v1.4.48 M4 — shared SSR-safety helper for hooks that delegate to
 * React Query under a `<QueryClientProvider>`.
 *
 * A long tail of legacy presentational components (`<HeroStrip>`,
 * `<SuggestedPrompts>`, `<LayoutCoachFab>`, `<InsightStatusCard>`,
 * `<HealthScoreDeltaExplainer>`, …) ships with unit tests that render
 * the component in isolation without wrapping it in
 * `<QueryClientProvider>`. Hooks that call `useQuery` directly crash
 * in that environment.
 *
 * `useQueryClientMounted()` returns `true` when a `QueryClientContext`
 * value is present in the React tree, `false` otherwise. The branch is
 * stable across the component's lifetime — the provider never
 * appears and disappears between renders — so a conditional hook call
 * gated on this value remains safe per the Rules of Hooks (the same
 * posture the React docs document for "different environments where
 * the same component renders").
 */
export function useQueryClientMounted(): boolean {
  // The cast strips the generic so callers don't have to learn the
  // internal `QueryClient | undefined` shape — they only need to know
  // whether the context is mounted.
  const ctx = useContext(
    QueryClientContext as unknown as React.Context<unknown>,
  );
  return ctx != null;
}
