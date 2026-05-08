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

vi.mock("@/lib/monitoring/glitchtip", () => ({
  sendGlitchtipEvent: vi.fn(),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendGlitchtipEvent } from "@/lib/monitoring/glitchtip";

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
  vi.mocked(sendGlitchtipEvent).mockReset();
  global.fetch = vi.fn() as never;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function emptyRequest(): Request {
  return new Request("http://localhost/api/monitoring/glitchtip/test", {
    method: "POST",
    headers: { "content-length": "0" },
  });
}

describe("POST /api/monitoring/glitchtip/test", () => {
  it("happy path returns ok with statusCode", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValueOnce({
      glitchtipDsn: "https://abc@glitch.example.com/1",
    } as never);
    vi.mocked(sendGlitchtipEvent).mockResolvedValueOnce({
      ok: true,
      method: "envelope",
      status: 200,
    });

    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ApiSuccessEnvelope<{
      ok: boolean;
      statusCode: number;
      latencyMs: number;
    }>;
    expect(body.data.ok).toBe(true);
    expect(body.data.statusCode).toBe(200);
    expect(typeof body.data.latencyMs).toBe("number");

    // CRITICAL guard against the `id: "default"` typo regression.
    expect(prisma.appSettings.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "singleton" } }),
    );
  });

  it("rejects HTTP DSN with 422", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValueOnce({
      glitchtipDsn: "http://abc@glitch.example.com/1",
    } as never);
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(422);
    const body = (await response.json()) as ApiErrorEnvelope & {
      meta: { errorCode: string };
    };
    expect(body.meta.errorCode).toBe("dsn_not_https");
    expect(sendGlitchtipEvent).not.toHaveBeenCalled();
  });

  it("rejects DSN pointing at a private host (SSRF guard)", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValueOnce({
      glitchtipDsn: "https://abc@127.0.0.1/1",
    } as never);
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(422);
    const body = (await response.json()) as ApiErrorEnvelope & {
      meta: { errorCode: string };
    };
    expect(body.meta.errorCode).toBe("dsn_host_not_public");
    expect(sendGlitchtipEvent).not.toHaveBeenCalled();
  });

  it("rate-limit denial returns 429 with no upstream call", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    } as never);
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(429);
    expect(sendGlitchtipEvent).not.toHaveBeenCalled();
  });

  it("returns 422 when DSN is not configured", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValueOnce({
      glitchtipDsn: null,
    } as never);
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(422);
    const body = (await response.json()) as ApiErrorEnvelope;
    expect(body.error).toMatch(/not configured/i);
    expect(sendGlitchtipEvent).not.toHaveBeenCalled();
  });

  it("does not leak DSN/Bearer/sk- on upstream 401", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValueOnce({
      glitchtipDsn: "https://abc@glitch.example.com/1",
    } as never);
    vi.mocked(sendGlitchtipEvent).mockRejectedValueOnce(
      new Error(
        "401 Unauthorized: Authorization: Bearer sk-secret from https://glitch.example.com/api/1/envelope/",
      ),
    );
    const response = await POST(emptyRequest() as never);
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).not.toMatch(/sk-/);
    expect(text).not.toMatch(/glitch\.example\.com/);
  });
});
