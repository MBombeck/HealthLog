/**
 * POST /api/notifications/action/{token} — a quick answer from a
 * notification. Pins the order of the gates and every refusal class: the
 * signature (an HMAC, no database read), then the rate limit (per account for
 * a genuine token, per address in a bucket of its own for any other), expiry,
 * account, module, and the single-use write.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const TEST_HMAC_KEY = "test-hmac-key-at-least-32-chars-long-xxxxx";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    idempotencyKey: { create: vi.fn(), deleteMany: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkAuthSurfaceRateLimit: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({ "Retry-After": "60" })),
}));
vi.mock("@/lib/modules/gate", () => ({ isModuleEnabled: vi.fn() }));
vi.mock("@/lib/mood/create-from-telegram", () => ({
  logTelegramMood: vi.fn(),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { checkAuthSurfaceRateLimit, checkRateLimit } from "@/lib/rate-limit";
import { isModuleEnabled } from "@/lib/modules/gate";
import { logTelegramMood } from "@/lib/mood/create-from-telegram";
import {
  ACTION_TOKEN_TTL_MS,
  mintActionToken,
} from "@/lib/notifications/action-token";

function call(token: string) {
  const req = new NextRequest(
    `http://localhost/api/notifications/action/${token}`,
    { method: "POST" },
  );
  return POST(req, { params: Promise.resolve({ token }) });
}

function token(over: Partial<Parameters<typeof mintActionToken>[0]> = {}) {
  return mintActionToken({
    userId: "user-1",
    action: "mood-okay",
    nonce: "nonce-1",
    ...over,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("API_TOKEN_HMAC_KEY", TEST_HMAC_KEY);
  vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 19,
    resetAt: new Date(),
    ip: "203.0.113.5",
  } as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    limit: 20,
    remaining: 19,
    resetAt: Date.now(),
  });
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    id: "user-1",
    timezone: "Europe/Berlin",
  } as never);
  vi.mocked(isModuleEnabled).mockResolvedValue(true);
  vi.mocked(prisma.idempotencyKey.create).mockResolvedValue({} as never);
  vi.mocked(prisma.idempotencyKey.deleteMany).mockResolvedValue({
    count: 1,
  } as never);
  vi.mocked(logTelegramMood).mockResolvedValue({
    created: true,
    moodEntryId: "m1",
    score: 3,
  });
});

describe("POST /api/notifications/action/{token}", () => {
  it("logs the answer under the reminder's nonce with the notification source", async () => {
    const res = await call(token());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { logged: true, action: "mood-okay" },
      error: null,
    });
    expect(logTelegramMood).toHaveBeenCalledWith({
      userId: "user-1",
      score: 3,
      tz: "Europe/Berlin",
      externalId: "notification-action:nonce-1",
      source: "NOTIFICATION",
    });
  });

  it("limits a genuine token per account, before any database read", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      limit: 20,
      remaining: 0,
      resetAt: Date.now(),
    });
    const res = await call(token());
    expect(res.status).toBe(429);
    expect(vi.mocked(checkRateLimit).mock.calls[0]![0]).toBe(
      "notification-action:user:user-1",
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(logTelegramMood).not.toHaveBeenCalled();
  });

  it("charges junk to a bucket of its own, so it cannot hold genuine answers back", async () => {
    // The junk bucket is spent, as it is for everyone when the address
    // cannot be read and all junk lands in one bucket.
    vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date(),
      ip: null,
    } as never);
    const junk = await call("hla_not-a-token");
    expect(junk.status).toBe(429);
    expect(vi.mocked(checkAuthSurfaceRateLimit).mock.calls[0]![1]).toBe(
      "notification-action-invalid",
    );

    const genuine = await call(token());
    expect(genuine.status).toBe(200);
  });

  it("refuses a tampered token with 401 and writes nothing", async () => {
    const forged = token().replace("user-1", "user-2");
    const res = await call(forged);
    expect(res.status).toBe(401);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(logTelegramMood).not.toHaveBeenCalled();
  });

  it("refuses an expired token with 410", async () => {
    const res = await call(
      token({ now: Date.now() - ACTION_TOKEN_TTL_MS - 1 }),
    );
    expect(res.status).toBe(410);
    expect(logTelegramMood).not.toHaveBeenCalled();
  });

  it("refuses a token for an account that no longer exists", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    const res = await call(token());
    expect(res.status).toBe(401);
    expect(logTelegramMood).not.toHaveBeenCalled();
  });

  it("writes only for the user the token names", async () => {
    await call(token({ userId: "user-9" }));
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-9" } }),
    );
  });

  it("refuses with 403 when the mood module was switched off", async () => {
    vi.mocked(isModuleEnabled).mockResolvedValue(false);
    const res = await call(token());
    expect(res.status).toBe(403);
    expect(isModuleEnabled).toHaveBeenCalledWith("user-1", "mood");
    expect(logTelegramMood).not.toHaveBeenCalled();
  });

  it("refuses a reused reminder with 409", async () => {
    vi.mocked(logTelegramMood).mockResolvedValue({
      created: false,
      moodEntryId: "m1",
      score: 3,
    });
    const res = await call(token({ action: "mood-bad" }));
    expect(res.status).toBe(409);
  });

  it("refuses a spent nonce with 409 before writing anything", async () => {
    const { Prisma } = await import("@/generated/prisma/client");
    vi.mocked(prisma.idempotencyKey.create).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    const res = await call(token());
    expect(res.status).toBe(409);
    expect(logTelegramMood).not.toHaveBeenCalled();
  });

  it("claims the nonce until the token expires", async () => {
    const now = Date.now();
    await call(token({ now }));
    expect(prisma.idempotencyKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        key: "notification-action:nonce-1",
        requestFingerprint: null,
        expiresAt: new Date(now + ACTION_TOKEN_TTL_MS),
      }),
    });
  });

  it("gives the claim back when the write fails for another reason", async () => {
    vi.mocked(logTelegramMood).mockRejectedValue(new Error("db down"));
    const res = await call(token());
    expect(res.status).toBe(500);
    expect(prisma.idempotencyKey.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        userId: "user-1",
        key: "notification-action:nonce-1",
      }),
    });
  });
});
