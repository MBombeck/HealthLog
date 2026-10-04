import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// safeFetch's requirePublicHost path runs through undici's own `fetch`
// (version-locked with its dispatcher). Delegate it to the global `fetch`
// stub these tests install so the interception still applies.
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    fetch: (input: unknown, init?: unknown) =>
      (globalThis.fetch as unknown as (i: unknown, n?: unknown) => unknown)(
        input,
        init,
      ),
  };
});

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

vi.mock("@/lib/monitoring-settings", () => ({
  getPublicMonitoringSettings: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

import { POST } from "../route";
import { getPublicMonitoringSettings } from "@/lib/monitoring-settings";
import { resetUmamiCollectPathCache } from "@/lib/monitoring/umami";
import { checkRateLimit } from "@/lib/rate-limit";

const SCRIPT_URL = "https://analytics.example.com/script.js";

/** A built tracker's endpoint template, as Umami compiles it. */
function tracker(collectPath: string): string {
  return `!function(){const R=\`\${(x||""||u.src.split("/").slice(0,-1).join("/")).replace(/\\/$/,"")}${collectPath}\`;}();`;
}

function post(path: string[], ip = "203.0.113.11") {
  return POST(
    new NextRequest(`http://localhost/api/monitoring/umami/${path.join("/")}`, {
      method: "POST",
      body: JSON.stringify({ type: "event" }),
      headers: { "content-type": "application/json", "x-real-ip": ip },
    }),
    { params: Promise.resolve({ path }) },
  );
}

/** Upstream: the tracker script on GET, `status` on the event POST. */
function upstream(collectPath: string, status = 202) {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === SCRIPT_URL && (!init?.method || init.method === "GET")) {
      return new Response(tracker(collectPath), { status: 200 });
    }
    return new Response(null, { status });
  });
}

function eventPosts(): string[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => init?.method === "POST")
    .map(([input]) => String(input));
}

beforeEach(() => {
  vi.resetAllMocks();
  resetUmamiCollectPathCache();
  vi.stubGlobal("fetch", vi.fn());
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 119,
    resetAt: Date.now() + 60_000,
  } as never);
  vi.mocked(getPublicMonitoringSettings).mockResolvedValue({
    umamiEnabled: true,
    umamiScriptUrl: SCRIPT_URL,
    umamiWebsiteId: "site-1",
  } as never);
});

describe("POST /api/monitoring/umami/[...path]", () => {
  it("rate-limits the public Umami proxy by client IP before anything else", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    } as never);

    const response = await post(["api", "send"], "203.0.113.10");

    expect(response.status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledWith(
      "umami-proxy:203.0.113.10",
      120,
      60 * 1000,
    );
    expect(getPublicMonitoringSettings).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards a default build's /api/send to the Umami host", async () => {
    upstream("/api/send");
    const response = await post(["api", "send"]);
    expect(response.status).toBe(202);
    expect(eventPosts()).toEqual(["https://analytics.example.com/api/send"]);
  });

  it("forwards a renamed collect endpoint to the same path on the Umami host", async () => {
    // A build with COLLECT_API_ENDPOINT=/api/insight posts to
    // `<data-host-url>/api/insight`. Before the proxy prefix, that landed on
    // the app's own origin and 404'd with a full page on every page view.
    upstream("/api/insight");
    const response = await post(["api", "insight"]);
    expect(response.status).toBe(202);
    expect(eventPosts()).toEqual(["https://analytics.example.com/api/insight"]);
  });

  it("refuses any path that is not the tracker's collect path, with an empty body", async () => {
    upstream("/api/insight");
    const response = await post(["api", "websites"]);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(eventPosts()).toEqual([]);
  });

  it("learns the collect path once, not on every event", async () => {
    upstream("/api/insight");
    await post(["api", "insight"]);
    await post(["api", "insight"]);
    const scriptFetches = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input) === SCRIPT_URL);
    expect(scriptFetches).toHaveLength(1);
    expect(eventPosts()).toHaveLength(2);
  });

  it("answers an empty 502 when the tracker cannot be read", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 500 }));
    const response = await post(["api", "send"]);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("");
    expect(eventPosts()).toEqual([]);
  });

  it("answers 204 without touching the network when Umami is off", async () => {
    vi.mocked(getPublicMonitoringSettings).mockResolvedValue({
      umamiEnabled: false,
      umamiScriptUrl: SCRIPT_URL,
      umamiWebsiteId: "site-1",
    } as never);
    const response = await post(["api", "send"]);
    expect(response.status).toBe(204);
    expect(fetch).not.toHaveBeenCalled();
  });
});
