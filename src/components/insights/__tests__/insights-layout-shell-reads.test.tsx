import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The layout shell wraps every Insights page. It owns the regenerate button
 * on the tab strip but shows no briefing, so it must not read the briefing
 * on entry: on a metric page that read was a request (and the schema chunk
 * that parses its answer) for a button. The button itself stays.
 *
 * The strip's pills are gated on one small presence read and the saved
 * layout. The overview read, a workouts page and the ECG list it used to
 * send on every page for four flags are gone.
 */

const queries: Array<{ queryKey: readonly unknown[]; enabled?: boolean }> = [];
const stripProps: Array<{
  onRegenerate?: unknown;
  availability?: { summaries?: unknown; hasMood?: boolean };
}> = [];
/** What the presence read answers, and the record the session is inside. */
const answer: { presence: unknown; active: unknown } = {
  presence: undefined,
  active: null,
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    queries.push(options);
    const presence = options.queryKey.join("/") === "insights/presence";
    return {
      data: presence ? answer.presence : undefined,
      isLoading: false,
      isError: false,
    };
  },
  useMutation: () => ({ mutate: vi.fn(), isPending: false, data: undefined }),
  useQueryClient: () => ({
    getQueryCache: () => ({ find: () => undefined }),
  }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: { modules: {}, accountAccess: { active: answer.active } },
  }),
}));
vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapability: () => ({ available: true }),
  useAiProviderState: () => ({ responseTimeoutMs: null }),
}));
const layoutReads: unknown[] = [];
vi.mock("@/hooks/use-insights-layout", () => ({
  useInsightsLayoutQuery: (enabled: unknown) => {
    layoutReads.push(enabled);
    return { layout: { tiles: [] }, isSuccess: false };
  },
}));
vi.mock("@/components/insights/insights-tab-strip", () => ({
  InsightsTabStrip: (props: (typeof stripProps)[number]) => {
    stripProps.push(props);
    return null;
  },
}));

import { queryKeys } from "@/lib/query-keys";
import { InsightsLayoutShell } from "../insights-layout-shell";

describe("InsightsLayoutShell: what it reads on entry", () => {
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

  it("reads the presence answer and the layout, nothing else", () => {
    queries.length = 0;
    layoutReads.length = 0;
    renderToStaticMarkup(
      <InsightsLayoutShell>
        <div />
      </InsightsLayoutShell>,
    );

    const sent = queries
      .filter((q) => q.enabled !== false)
      .map((q) => JSON.stringify(q.queryKey));
    expect(sent).toEqual([JSON.stringify(queryKeys.insightsPresence())]);
    expect(layoutReads).toEqual([true]);
  });

  it("offers no metric pill inside a switched-to record", () => {
    // The metric pages read `/api/analytics`, which serves only the caller's
    // own record; the mood and medication pills read their own routes.
    answer.presence = {
      metrics: { WEIGHT: { count: 12 } },
      hasMood: true,
      hasMedication: false,
      hasWorkouts: false,
      hasEcgRecordings: false,
    };
    const render = (active: unknown) => {
      answer.active = active;
      stripProps.length = 0;
      renderToStaticMarkup(
        <InsightsLayoutShell>
          <div />
        </InsightsLayoutShell>,
      );
      return stripProps[0]?.availability;
    };

    expect(render(null)?.summaries).toEqual({ WEIGHT: { count: 12 } });
    const switched = render({ accountId: "record-2" });
    expect(switched?.summaries).toBeUndefined();
    expect(switched?.hasMood).toBe(true);
    answer.presence = undefined;
    answer.active = null;
  });
});
