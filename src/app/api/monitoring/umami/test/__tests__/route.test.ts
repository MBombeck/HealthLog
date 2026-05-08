import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAdmin: vi.fn(async () => ({
    user: { id: "u-admin" },
    session: { id: "s-1" },
  })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((x: string) => x),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";

interface ApiErrorEnvelope {
  data: null;
  error: string;
}
interface ApiSuccessEnvelope<T> {
  data: T;
  error: null;
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 5,
    resetAt: Date.now() + 60_000,
  } as never);
  vi.mocked(prisma.appSettings.findUnique).mockReset();
  global.fetch = vi.fn() as never;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function emptyRequest(): Request {
  return new Request("http://localhost/api/monitoring/umami/test", {
    method: "POST",
    headers: { "content-length": "0" },
  });
}

describe("POST /api/monitoring/umami/test", () => {
  it("happy path returns ok with hasMarker=true", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValueOnce({
      umamiScriptUrl: "https://analytics.example.com/script.js",
    } as never);
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("(function(){window.umami=function(){};})();", {
        status: 200,
      }),
    );

    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ApiSuccessEnvelope<{
      ok: boolean;
      statusCode: number;
      hasMarker: boolean;
    }>;
    expect(body.data.ok).toBe(true);
    expect(body.data.hasMarker).toBe(true);
    expect(body.data.statusCode).toBe(200);

    // CRITICAL guard: AppSettings is keyed on `id: "singleton"` everywhere
    // else in the codebase. A typo here ("default") would silently make the
    // route return 422 in prod even with valid settings.
    expect(prisma.appSettings.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "singleton" } }),
    );
  });

  it("rate-limit denial returns 429 with no upstream call", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    } as never);
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(429);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns 422 when URL not configured", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValueOnce({
      umamiScriptUrl: null,
    } as never);
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(422);
    const body = (await response.json()) as ApiErrorEnvelope;
    expect(body.error).toMatch(/not configured/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not leak Bearer/sk- or upstream URL on upstream 401", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValueOnce({
      umamiScriptUrl: "https://analytics.example.com/script.js",
    } as never);
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        "Authorization: Bearer sk-secret echoed back from https://analytics.example.com/script.js",
        { status: 401 },
      ),
    );
    const response = await POST(emptyRequest() as never);
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).not.toMatch(/sk-/);
    expect(text).not.toMatch(/analytics\.example\.com/);
  });
});
