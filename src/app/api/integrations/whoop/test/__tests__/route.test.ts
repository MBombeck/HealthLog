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
    whoopConnection: {
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

vi.mock("@/lib/whoop/sync-core", () => ({
  getValidToken: vi.fn(),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { getValidToken } from "@/lib/whoop/sync-core";

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
  vi.mocked(prisma.whoopConnection.findUnique).mockReset();
  vi.mocked(getValidToken).mockReset();
  global.fetch = vi.fn() as never;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function emptyRequest(): Request {
  return new Request("http://localhost/api/integrations/whoop/test", {
    method: "POST",
    headers: { "content-length": "0" },
  });
}

describe("POST /api/integrations/whoop/test", () => {
  it("happy path returns ok with shape", async () => {
    const lastSyncedAt = new Date("2026-05-01T10:00:00.000Z");
    vi.mocked(getValidToken).mockResolvedValueOnce({
      accessToken: "plain-access",
      connection: { id: "wc-1", whoopUserId: "wu-1" },
    });
    vi.mocked(prisma.whoopConnection.findUnique).mockResolvedValueOnce({
      lastSyncedAt,
    } as never);
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ user_id: 1, first_name: "x" }), {
        status: 200,
      }),
    );

    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ApiSuccessEnvelope<{
      ok: boolean;
      lastSyncedAt: string;
      latencyMs: number;
    }>;
    expect(body.data.ok).toBe(true);
    expect(typeof body.data.latencyMs).toBe("number");
    expect(body.data.lastSyncedAt).toBe(lastSyncedAt.toISOString());
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

  it("returns 422 when no WHOOP connection exists", async () => {
    vi.mocked(getValidToken).mockResolvedValueOnce(null);
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(422);
    const body = (await response.json()) as ApiErrorEnvelope;
    expect(body.error).toMatch(/not connected/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("classifies 401 upstream as credentials_rejected", async () => {
    vi.mocked(getValidToken).mockResolvedValueOnce({
      accessToken: "sk-secret",
      connection: { id: "wc-1", whoopUserId: "wu-1" },
    });
    vi.mocked(prisma.whoopConnection.findUnique).mockResolvedValueOnce({
      lastSyncedAt: null,
    } as never);
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(502);
    const body = (await response.json()) as ApiErrorEnvelope & {
      meta?: { errorCode?: string };
    };
    expect(body.meta?.errorCode).toBe("credentials_rejected");
  });

  it("classifies 429 upstream as rate_limited", async () => {
    vi.mocked(getValidToken).mockResolvedValueOnce({
      accessToken: "plain-access",
      connection: { id: "wc-1", whoopUserId: "wu-1" },
    });
    vi.mocked(prisma.whoopConnection.findUnique).mockResolvedValueOnce({
      lastSyncedAt: null,
    } as never);
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "rate limited" }), { status: 429 }),
    );
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(502);
    const body = (await response.json()) as ApiErrorEnvelope & {
      meta?: { errorCode?: string };
    };
    expect(body.meta?.errorCode).toBe("rate_limited");
  });

  it("classifies 500 upstream as upstream_error", async () => {
    vi.mocked(getValidToken).mockResolvedValueOnce({
      accessToken: "plain-access",
      connection: { id: "wc-1", whoopUserId: "wu-1" },
    });
    vi.mocked(prisma.whoopConnection.findUnique).mockResolvedValueOnce({
      lastSyncedAt: null,
    } as never);
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("oops", { status: 503 }),
    );
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(502);
    const body = (await response.json()) as ApiErrorEnvelope & {
      meta?: { errorCode?: string };
    };
    expect(body.meta?.errorCode).toBe("upstream_error");
  });

  it("does not leak Bearer token or upstream URL on failure", async () => {
    vi.mocked(getValidToken).mockResolvedValueOnce({
      accessToken: "sk-secret",
      connection: { id: "wc-1", whoopUserId: "wu-1" },
    });
    vi.mocked(prisma.whoopConnection.findUnique).mockResolvedValueOnce({
      lastSyncedAt: null,
    } as never);
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "Authorization: Bearer sk-secret echoed",
          url: "https://api.prod.whoop.com/developer/v2/user/profile/basic",
        }),
        { status: 401 },
      ),
    );
    const response = await POST(emptyRequest() as never);
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).not.toMatch(/sk-/);
    expect(text).not.toMatch(/api\.prod\.whoop\.com/);
  });
});
