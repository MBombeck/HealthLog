import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The layout shell wraps every Insights page. It owns the regenerate button
 * on the tab strip but shows no briefing, so it must not read the briefing
 * on entry: on a metric page that read was a request (and the schema chunk
 * that parses its answer) for a button. The button itself stays.
 */

const queries: Array<{ queryKey: readonly unknown[]; enabled?: boolean }> = [];
const stripProps: Array<{ onRegenerate?: unknown }> = [];

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    queries.push(options);
    return { data: undefined, isLoading: false, isError: false };
  },
  useMutation: () => ({ mutate: vi.fn(), isPending: false, data: undefined }),
  useQueryClient: () => ({
    getQueryCache: () => ({ find: () => undefined }),
  }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: { modules: {} } }),
}));
vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapability: () => ({ available: true }),
  useAiProviderState: () => ({ responseTimeoutMs: null }),
}));
vi.mock("@/hooks/use-surface-visible", () => ({
  useSurfaceVisible: () => true,
}));
vi.mock("@/hooks/use-workouts", () => ({
  useWorkouts: () => ({ data: undefined }),
}));
vi.mock("@/lib/queries/use-analytics-query", () => ({
  useAnalyticsQuery: () => ({ data: undefined }),
}));
vi.mock("@/hooks/use-insights-layout", () => ({
  useInsightsLayoutQuery: () => ({
    layout: { tiles: [] },
    isSuccess: false,
  }),
}));
vi.mock("@/components/insights/use-ecg-list", () => ({
  useEcgList: () => ({ data: undefined }),
}));
vi.mock("@/components/insights/insights-tab-strip", () => ({
  InsightsTabStrip: (props: { onRegenerate?: unknown }) => {
    stripProps.push(props);
    return null;
  },
}));

import { queryKeys } from "@/lib/query-keys";
import { InsightsLayoutShell } from "../insights-layout-shell";

describe("InsightsLayoutShell — what it reads on entry", () => {
  it("keeps the regenerate button and sends no briefing read", () => {
    renderToStaticMarkup(
      <InsightsLayoutShell>
        <div />
      </InsightsLayoutShell>,
    );

    const advisorKey = JSON.stringify(queryKeys.insightsAdvisor());
    const advisor = queries.filter(
      (q) => JSON.stringify(q.queryKey) === advisorKey,
    );
    expect(advisor).toHaveLength(1);
    expect(advisor[0].enabled).toBe(false);
    expect(typeof stripProps[0]?.onRegenerate).toBe("function");
  });
});
