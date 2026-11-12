/**
 * The tab strip owns the regenerate button on every Insights page but shows
 * no briefing, so it no longer reads one on entry. A regenerate from a page
 * that never read the briefing still needs the briefing it replaces as the
 * baseline a timed-out attempt settles against; without it the old briefing
 * would read as the fresh one. `ensureAdvisorBaseline` reads it first, and
 * only when the cache holds none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

const apiFetchRaw = vi.fn();

vi.mock("@/lib/api/api-fetch", () => ({
  apiFetchRaw: (...a: unknown[]) => apiFetchRaw(...a),
}));

import { queryKeys } from "@/lib/query-keys";
import { ensureAdvisorBaseline } from "../use-insights-advisor";

const CACHED_AT = "2026-11-10T05:00:00.000Z";

beforeEach(() => {
  apiFetchRaw.mockReset().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      data: { insights: {}, cached: true, cachedAt: CACHED_AT },
    }),
  } as unknown as Response);
});

describe("ensureAdvisorBaseline", () => {
  it("reads the briefing a regenerate replaces when nothing has read it yet", async () => {
    const queryClient = new QueryClient();

    await ensureAdvisorBaseline(queryClient);

    expect(apiFetchRaw).toHaveBeenCalledTimes(1);
    expect(apiFetchRaw.mock.calls[0][1]).toMatchObject({ method: "GET" });
    const cached = queryClient.getQueryData<{
      payload: { cachedAt: string } | null;
    }>(queryKeys.insightsAdvisor());
    expect(cached?.payload?.cachedAt).toBe(CACHED_AT);
  });

  it("asks nothing when the overview already read it", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.insightsAdvisor(), {
      payload: { cachedAt: CACHED_AT },
      outcome: "fresh",
    });

    await ensureAdvisorBaseline(queryClient);

    expect(apiFetchRaw).not.toHaveBeenCalled();
  });

  it("leaves the baseline empty when the read fails", async () => {
    apiFetchRaw.mockRejectedValue(new Error("offline"));
    const queryClient = new QueryClient();

    await expect(ensureAdvisorBaseline(queryClient)).resolves.toBeUndefined();
    expect(
      queryClient.getQueryData(queryKeys.insightsAdvisor()),
    ).toBeUndefined();
  });
});
