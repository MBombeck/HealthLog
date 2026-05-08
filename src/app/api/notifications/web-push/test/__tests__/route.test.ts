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
    pushSubscription: {
      findFirst: vi.fn(),
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

vi.mock("@/lib/notifications/vapid-config", () => ({
  getVapidConfig: vi.fn(async () => ({
    subject: "mailto:test@example.com",
    publicKey:
      "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
    privateKey: "private-key-stub",
  })),
}));

const sendNotification = vi.fn();
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
  setVapidDetails: vi.fn(),
  sendNotification: (...args: unknown[]) => sendNotification(...args),
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
  vi.mocked(prisma.pushSubscription.findFirst).mockReset();
  sendNotification.mockReset();
  global.fetch = vi.fn() as never;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function emptyRequest(): Request {
  return new Request("http://localhost/api/notifications/web-push/test", {
    method: "POST",
    headers: { "content-length": "0" },
  });
}

describe("POST /api/notifications/web-push/test", () => {
  it("happy path returns ok and sends to one subscription", async () => {
    vi.mocked(prisma.pushSubscription.findFirst).mockResolvedValueOnce({
      id: "p-1",
      userId: "u-1",
      endpoint: "https://fcm.googleapis.com/fcm/send/abc123token",
      p256dh: "p256",
      auth: "auth",
    } as never);
    sendNotification.mockResolvedValueOnce({ statusCode: 201 });

    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ApiSuccessEnvelope<{
      ok: boolean;
      sent: number;
      latencyMs: number;
      perEndpoint: Array<{ host: string; status: number | null }>;
    }>;
    expect(body.data.ok).toBe(true);
    expect(body.data.sent).toBe(1);
    expect(body.data.perEndpoint).toHaveLength(1);
    expect(body.data.perEndpoint[0].host).toBe("fcm.googleapis.com");
    // never the full endpoint URL (the routing token is the only thing
    // protecting that subscription from anyone who learns it).
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/abc123token/);

    // Spec: only the most-recent subscription gets the test push, not all.
    expect(prisma.pushSubscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u-1" },
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("rate-limit denial returns 429 with no upstream call", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    } as never);
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(429);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("returns 422 when no subscriptions registered", async () => {
    vi.mocked(prisma.pushSubscription.findFirst).mockResolvedValueOnce(null);
    const response = await POST(emptyRequest() as never);
    expect(response.status).toBe(422);
    const body = (await response.json()) as ApiErrorEnvelope;
    expect(body.error).toMatch(/no push subscriptions/i);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not leak Bearer/sk- or full endpoint URL when upstream rejects", async () => {
    vi.mocked(prisma.pushSubscription.findFirst).mockResolvedValueOnce({
      id: "p-1",
      userId: "u-1",
      endpoint: "https://fcm.googleapis.com/fcm/send/abc123token",
      p256dh: "p256",
      auth: "auth",
    } as never);
    sendNotification.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "401 Unauthorized: Authorization: Bearer sk-secret from https://fcm.googleapis.com/fcm/send/abc123token",
        ),
        { statusCode: 401 },
      ),
    );
    const response = await POST(emptyRequest() as never);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toMatch(/sk-/);
    expect(text).not.toMatch(/abc123token/);
    const parsed = JSON.parse(text) as ApiSuccessEnvelope<{
      ok: boolean;
      sent: number;
      perEndpoint: Array<{ host: string; status: number | null }>;
    }>;
    expect(parsed.data.ok).toBe(false);
    expect(parsed.data.sent).toBe(0);
    expect(parsed.data.perEndpoint[0].host).toBe("fcm.googleapis.com");
    expect(parsed.data.perEndpoint[0].status).toBe(401);
  });
});
