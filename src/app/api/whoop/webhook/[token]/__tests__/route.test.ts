import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";

// --- Module-boundary mocks must come before importing the route. ---

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    whoopConnection: { findUnique: vi.fn() },
    measurement: { updateMany: vi.fn() },
    workout: { deleteMany: vi.fn() },
  },
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/api-response", () => ({
  getClientIp: vi.fn(() => "203.0.113.7"),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => ({
    setAuth: vi.fn(),
    addWarning: vi.fn(),
  })),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";

const SECRET = "test-whoop-webhook-secret";
const ORIGINAL_SECRET = process.env.WHOOP_WEBHOOK_SECRET;
const NOW = 1_700_000_000_000;

function signedRequest(
  body: object,
  opts: { signatureValid?: boolean; timestamp?: number } = {},
): NextRequest {
  const rawBody = JSON.stringify(body);
  const timestamp = String(opts.timestamp ?? NOW);
  const signingSecret = opts.signatureValid === false ? "wrong" : SECRET;
  const signature = createHmac("sha256", signingSecret)
    .update(timestamp + rawBody, "utf8")
    .digest("base64");
  return new NextRequest(
    "https://app.example.com/api/whoop/webhook/" + SECRET,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-WHOOP-Signature": signature,
        "X-WHOOP-Signature-Timestamp": timestamp,
      },
      body: rawBody,
    },
  );
}

const ctx = (token: string) => ({ params: Promise.resolve({ token }) });

beforeEach(() => {
  vi.resetAllMocks();
  process.env.WHOOP_WEBHOOK_SECRET = SECRET;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    limit: 60,
    remaining: 59,
    reset: NOW + 60_000,
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
  process.env.WHOOP_WEBHOOK_SECRET = ORIGINAL_SECRET;
});

describe("POST /api/whoop/webhook/[token]", () => {
  it("rate-limits BEFORE any secret/signature work", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      count: 61,
      limit: 60,
      remaining: 0,
      reset: NOW + 60_000,
    } as never);

    const req = signedRequest({
      user_id: 42,
      id: "abc",
      type: "recovery.updated",
    });
    const res = await POST(req, ctx(SECRET));

    expect(res.status).toBe(429);
    // No connection lookup happened — the rate limit short-circuited.
    expect(prisma.whoopConnection.findUnique).not.toHaveBeenCalled();
    expect(getGlobalBoss).not.toHaveBeenCalled();
  });

  it("rejects a bad path-segment secret with 401, no work done", async () => {
    const req = signedRequest({
      user_id: 42,
      id: "abc",
      type: "recovery.updated",
    });
    const res = await POST(req, ctx("wrong-token"));

    expect(res.status).toBe(401);
    expect(prisma.whoopConnection.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a forged HMAC signature with 401, no work done", async () => {
    const req = signedRequest(
      { user_id: 42, id: "abc", type: "recovery.updated" },
      { signatureValid: false },
    );
    const res = await POST(req, ctx(SECRET));

    expect(res.status).toBe(401);
    expect(prisma.whoopConnection.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a stale timestamp with 401", async () => {
    const req = signedRequest(
      { user_id: 42, id: "abc", type: "recovery.updated" },
      { timestamp: NOW - 10 * 60 * 1000 },
    );
    const res = await POST(req, ctx(SECRET));
    expect(res.status).toBe(401);
  });

  it("enqueues the matching per-resource sync on a valid `*.updated`", async () => {
    const send = vi.fn().mockResolvedValue("job-id");
    vi.mocked(getGlobalBoss).mockReturnValue({ send } as never);
    vi.mocked(prisma.whoopConnection.findUnique).mockResolvedValue({
      userId: "user-1",
    } as never);

    const req = signedRequest({
      user_id: 42,
      id: "abc",
      type: "recovery.updated",
    });
    const res = await POST(req, ctx(SECRET));

    expect(res.status).toBe(200);
    expect(prisma.whoopConnection.findUnique).toHaveBeenCalledWith({
      where: { whoopUserId: "42" },
      select: { userId: true },
    });
    // v1.16.16 (iOS #17) — the resource id rides through so the worker can do
    // a targeted fetch-by-id refresh instead of re-walking the collection.
    expect(send).toHaveBeenCalledWith("whoop-recovery-sync", {
      userId: "user-1",
      resourceId: "abc",
    });
  });

  it("returns 200 unknown_user for an unrecognised WHOOP user (no retry storm)", async () => {
    vi.mocked(prisma.whoopConnection.findUnique).mockResolvedValue(null);

    const req = signedRequest({
      user_id: 99,
      id: "abc",
      type: "sleep.updated",
    });
    const res = await POST(req, ctx(SECRET));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "unknown_user" });
    expect(getGlobalBoss).not.toHaveBeenCalled();
  });

  it("soft-deletes matching rows on a `*.deleted` event", async () => {
    vi.mocked(prisma.whoopConnection.findUnique).mockResolvedValue({
      userId: "user-1",
    } as never);

    const req = signedRequest({
      user_id: 42,
      id: "rec-uuid",
      type: "recovery.deleted",
    });
    const res = await POST(req, ctx(SECRET));

    expect(res.status).toBe(200);
    expect(prisma.measurement.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        source: "WHOOP",
        externalId: { startsWith: "rec-uuid:" },
        deletedAt: null,
      },
      data: { deletedAt: expect.any(Date), syncVersion: { increment: 1 } },
    });
  });
});
