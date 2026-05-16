"use client";

import { useContext } from "react";
import { QueryClientContext, useQuery } from "@tanstack/react-query";

/**
 * v1.4.31 — Client-side accessor for the operator's assistant
 * feature-flag matrix. Mirrors `GET /api/feature-flags`'s response
 * shape directly so callers can rely on a typed structure.
 *
 * The matrix gates every assistant-driven surface on the web —
 * Coach + chat, Daily Briefing, per-metric status cards, correlation
 * narration, Health-Score delta explainer. iOS reads the same
 * endpoint and uses the same matrix; the contract is locked per
 * `.planning/RESPONSE-TO-IOS-TEAM-2026-05-16.md` §3 R5.
 */

export interface AssistantFlagSet {
  /** Master kill-switch — when false, every sub-flag is forced false. */
  enabled: boolean;
  /** Coach drawer, chat SSE, history rail, FAB. */
  coach: boolean;
  /** Daily Briefing card + advisor recommendations + regen icon. */
  briefing: boolean;
  /** Per-metric status cards on every `/insights/<metric>` sub-page. */
  insightStatus: boolean;
  /** Correlation narration tile on the mother page. */
  correlations: boolean;
  /** `?` glyph that opens the Health-Score delta explainer popover. */
  healthScoreExplainer: boolean;
}

interface FeatureFlagsPayload {
  assistant: AssistantFlagSet;
}

/** All-on default — matches the v1.4.30 behaviour for fresh installs. */
export const DEFAULT_ASSISTANT_FLAGS: AssistantFlagSet = Object.freeze({
  enabled: true,
  coach: true,
  briefing: true,
  insightStatus: true,
  correlations: true,
  healthScoreExplainer: true,
});

async function fetchFeatureFlags(): Promise<FeatureFlagsPayload> {
  const res = await fetch("/api/feature-flags");
  if (!res.ok) {
    // Soft-fail: any HTTP error returns the all-on default so the
    // surface continues to render. The endpoint is a non-critical
    // metadata read; a 5xx must not turn into a "Coach hidden"
    // false negative for the user.
    return { assistant: { ...DEFAULT_ASSISTANT_FLAGS } };
  }
  const json = (await res.json()) as { data: FeatureFlagsPayload };
  return json.data;
}

/**
 * Read the operator's assistant feature-flag matrix.
 *
 * `staleTime: 60_000` matches the server-side cache header so the
 * hot /insights mount path doesn't re-fetch the matrix on every
 * remount within a minute. The hook fails open — any network error
 * returns the all-on default so the user keeps seeing the surface.
 *
 * The hook is referenced from a long tail of legacy presentational
 * components (`<InsightStatusCard>`, `<HealthScoreDeltaExplainer>`)
 * whose unit tests render the component without a
 * `<QueryClientProvider>`. To keep those tests valid we delegate
 * the React-Query call to a child hook that's only invoked when a
 * client is mounted. The branch is stable across the component's
 * lifetime — `QueryClientProvider` placement never flips between
 * renders — so the conditional hook call is safe per the Rules of
 * Hooks (same posture the React docs document for "different
 * environments where the same component renders").
 */
export function useFeatureFlags(): AssistantFlagSet {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasClient = useContext(QueryClientContext as unknown as React.Context<any>);
  if (!hasClient) return DEFAULT_ASSISTANT_FLAGS;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useFeatureFlagsQuery();
}

function useFeatureFlagsQuery(): AssistantFlagSet {
  const query = useQuery({
    queryKey: ["feature-flags"],
    queryFn: fetchFeatureFlags,
    staleTime: 60_000,
    gcTime: 300_000,
    retry: 0,
  });

  // While loading or on error, default to all-on so the assistant
  // surfaces don't flicker out and back in.
  return query.data?.assistant ?? DEFAULT_ASSISTANT_FLAGS;
}
