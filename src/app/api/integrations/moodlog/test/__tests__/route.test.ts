import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({
    user: { id: "u-1" },
    session: { id: "s-1" },
  })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
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
  vi.mocked(prisma.user.findUnique).mockReset();
  global.fetch = vi.fn() as never;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function emptyRequest(): Request {
  return new Request("http://localhost/api/integrations/moodlog/test", {
    method: "POST",
    headers: { "content-length": "0" },
  });
}

describe("POST /api/integrations/moodlog/test", () => {
  it("happy path returns ok with shape", async () => {
    const lastSyncedAt = new Date("2026-05-01T10:00:00.000Z");
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      moodLogUrlEncrypted: "https://example.com",
      moodLogApiKeyEncrypted: "ml-key-123",
      moodLogLastSyncedAt: lastSyncedAt,
    } as never);
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ entries: [] }), { status: 200 }),
    );

    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ApiSuccessEnvelope<{
      ok: boolean;
      statusCode: number;
      latencyMs: number;
      lastSyncedAt: string;
    }>;
    expect(body.data.ok).toBe(true);
    expect(body.data.statusCode).toBe(200);
    expect(typeof body.data.latencyMs).toBe("number");
    expect(body.data.lastSyncedAt).toBe(lastSyncedAt.toISOString());

    // Probe must hit the actual sync endpoint with Bearer auth, not a bare HEAD
    // against the configured URL.
    const fetchCall = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const init = fetchCall[1] as RequestInit;
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ml-key-123");
    expect(init.redirect).toBe("manual");
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

  it("returns 422 when no moodLog URL configured", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      moodLogUrlEncrypted: null,
      moodLogApiKeyEncrypted: null,
      moodLogLastSyncedAt: null,
    } as never);
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(422);
    const body = (await response.json()) as ApiErrorEnvelope;
    expect(body.error).toMatch(/not configured/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects SSRF (private IP) with 422", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      moodLogUrlEncrypted: "http://127.0.0.1/moodlog",
      moodLogApiKeyEncrypted: "ml-key-123",
      moodLogLastSyncedAt: null,
    } as never);
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(422);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not leak upstream URL or Bearer token on upstream rejection", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      moodLogUrlEncrypted: "https://example.com",
      moodLogApiKeyEncrypted: "sk-secret",
      moodLogLastSyncedAt: null,
    } as never);
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error(
        "Authorization: Bearer sk-secret echoed from https://example.com/api/integrations/health-log/mood",
      ),
    );
    const response = await POST(emptyRequest() as never);
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).not.toMatch(/sk-/);
    expect(text).not.toMatch(/example\.com/);
  });
});
