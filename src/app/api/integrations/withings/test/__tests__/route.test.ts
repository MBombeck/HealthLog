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
    withingsConnection: {
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

vi.mock("@/lib/withings/sync", () => ({
  getValidToken: vi.fn(),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { getValidToken } from "@/lib/withings/sync";

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
  vi.mocked(prisma.withingsConnection.findUnique).mockReset();
  vi.mocked(getValidToken).mockReset();
  global.fetch = vi.fn() as never;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function emptyRequest(): Request {
  return new Request("http://localhost/api/integrations/withings/test", {
    method: "POST",
    headers: { "content-length": "0" },
  });
}

describe("POST /api/integrations/withings/test", () => {
  it("happy path returns ok with shape", async () => {
    const lastSyncedAt = new Date("2026-05-01T10:00:00.000Z");
    vi.mocked(getValidToken).mockResolvedValueOnce({
      accessToken: "plain-access",
      connection: { id: "wc-1", withingsUserId: "wu-1" },
    });
    vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValueOnce({
      lastSyncedAt,
    } as never);
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 0, body: {} }), { status: 200 }),
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

  it("returns 422 when no Withings connection exists", async () => {
    vi.mocked(getValidToken).mockResolvedValueOnce(null);
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(422);
    const body = (await response.json()) as ApiErrorEnvelope;
    expect(body.error).toMatch(/not connected/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("sanitises 401 upstream — does not leak Bearer token or upstream URL", async () => {
    vi.mocked(getValidToken).mockResolvedValueOnce({
      accessToken: "sk-secret",
      connection: { id: "wc-1", withingsUserId: "wu-1" },
    });
    vi.mocked(prisma.withingsConnection.findUnique).mockResolvedValueOnce({
      lastSyncedAt: null,
    } as never);
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "Authorization: Bearer sk-secret echoed",
          url: "https://wbsapi.withings.net/measure",
        }),
        { status: 401 },
      ),
    );
    const response = await POST(emptyRequest() as never);
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).not.toMatch(/sk-/);
    expect(text).not.toMatch(/wbsapi\.withings\.net/);
  });
});
