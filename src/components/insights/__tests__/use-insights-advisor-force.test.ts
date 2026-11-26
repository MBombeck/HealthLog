/**
 * v1.28.30 — wire-contract for the explicit regenerate.
 *
 * House rule: generation = nightly cron + explicit button. The button's
 * mutation therefore MUST issue `POST { force: true }` — without `force`
 * the route's 24 h short-circuit re-serves the cached payload and the
 * button reads as doing nothing (one half of the recurring
 * "no briefing today" chain). The read path stays a plain GET.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const apiFetchRaw = vi.fn();

vi.mock("@/lib/api/api-fetch", () => ({
  apiFetchRaw: (...a: unknown[]) => apiFetchRaw(...a),
}));

import { fetchAdvisor, forceAdvisorTimeoutMs } from "../use-insights-advisor";

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchRaw.mockResolvedValue(
    jsonResponse({ insights: { dailyBriefing: null }, cached: false }),
  );
});

describe("fetchAdvisor — explicit regenerate forces a generation", () => {
  it("POSTs force: true on the regenerate path", async () => {
    const result = await fetchAdvisor({ force: true });

    expect(apiFetchRaw).toHaveBeenCalledTimes(1);
    const [url, init] = apiFetchRaw.mock.calls[0] as [
      string,
      { method: string; body?: string },
    ];
    expect(url).toBe("/api/insights/generate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body ?? "{}")).toEqual({ force: true });
    expect(result.outcome).toBe("fresh");
  });

  it("uses a read-only GET (no body, no force) on the read path", async () => {
    await fetchAdvisor();

    expect(apiFetchRaw).toHaveBeenCalledTimes(1);
    const [url, init] = apiFetchRaw.mock.calls[0] as [
      string,
      { method: string; body?: string },
    ];
    expect(url).toBe("/api/insights/generate");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("lifts briefingOmittedReason through the payload for the card", async () => {
    apiFetchRaw.mockResolvedValue(
      jsonResponse({
        insights: { dailyBriefing: null },
        cached: true,
        briefingOmittedReason: "ungrounded",
      }),
    );

    const result = await fetchAdvisor();
    expect(result.payload?.briefingOmittedReason).toBe("ungrounded");
    expect(result.payload?.dailyBriefing).toBeNull();
  });
});

describe("fetchAdvisor — the regenerate waits as long as the response timeout allows (#1267)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A POST that only ends when its signal aborts, like a slow model. */
  function hangUntilAborted() {
    apiFetchRaw.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
  }

  it("is still waiting at 45 s and at 10 min with a 600 s setting", async () => {
    vi.useFakeTimers();
    hangUntilAborted();
    let settled: unknown = null;
    void fetchAdvisor({ force: true, responseTimeoutMs: 600_000 }).then(
      (r) => (settled = r),
    );
    await vi.advanceTimersByTimeAsync(45_001);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(forceAdvisorTimeoutMs(600_000));
    expect(settled).toEqual({ payload: null, outcome: "timeout" });
  });

  it("never waits less than the briefing's own 180 s per call", () => {
    // 60 s is what the payload publishes when nothing is set; the route still
    // gives each briefing call 180 s.
    expect(forceAdvisorTimeoutMs(60_000)).toBeGreaterThanOrEqual(2 * 180_000);
    expect(forceAdvisorTimeoutMs(undefined)).toBe(
      forceAdvisorTimeoutMs(60_000),
    );
  });

  it("keeps the read path at its fast 8 s bound", async () => {
    vi.useFakeTimers();
    hangUntilAborted();
    let settled: unknown = null;
    void fetchAdvisor({ responseTimeoutMs: 600_000 }).then(
      (r) => (settled = r),
    );
    await vi.advanceTimersByTimeAsync(8_001);
    expect(settled).toEqual({ payload: null, outcome: "timeout" });
  });
});

describe("fetchAdvisor — a refusal's body is read to its end", () => {
  it.each([422, 429, 503, 403])(
    "reads the %i body before returning the outcome",
    async (status) => {
      const text = vi.fn(async () => '{"data":null,"error":"refused"}');
      apiFetchRaw.mockResolvedValue({
        ok: false,
        status,
        text,
      } as unknown as Response);

      const result = await fetchAdvisor();

      expect(result.payload).toBeNull();
      expect(text).toHaveBeenCalledTimes(1);
    },
  );
});
