import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

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
import { checkRateLimit } from "@/lib/rate-limit";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn());
});

describe("POST /api/send", () => {
  it("rate-limits the public Umami proxy by client IP", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/api/send", {
        method: "POST",
        body: JSON.stringify({ type: "event" }),
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.10",
        },
      }),
    );

    expect(response.status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledWith(
      "umami-proxy:203.0.113.10",
      120,
      60 * 1000,
    );
    expect(getPublicMonitoringSettings).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("continues to proxy when the request is within quota", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 119,
      resetAt: Date.now() + 60_000,
    } as never);
    vi.mocked(getPublicMonitoringSettings).mockResolvedValue({
      umamiEnabled: true,
      umamiScriptUrl: "https://analytics.example.com/script.js",
      umamiWebsiteId: "site-1",
    } as never);
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }));

    const response = await POST(
      new NextRequest("http://localhost/api/send", {
        method: "POST",
        body: JSON.stringify({ type: "event" }),
        headers: {
          "content-type": "application/json",
          "x-real-ip": "203.0.113.11",
        },
      }),
    );

    expect(response.status).toBe(202);
    expect(fetch).toHaveBeenCalledWith(
      "https://analytics.example.com/api/send",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
