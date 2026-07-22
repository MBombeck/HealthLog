import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    notificationChannel: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((value: string) => `encrypted:${value}`),
  decrypt: vi.fn((value: string) => value.replace(/^encrypted:/, "")),
}));

vi.mock("@/lib/telegram", () => ({
  setTelegramWebhook: vi.fn().mockResolvedValue(true),
  deleteTelegramWebhook: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/notifications/senders/email-config", () => ({
  isEmailConfigured: vi.fn(() => true),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetAt: Date.now() + 60_000,
  }),
  rateLimitHeaders: () => ({}),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { PUT as putWebhook } from "../webhook/route";
import { PUT as putNtfy } from "../ntfy/route";
import { PUT as putEmail } from "../email/route";
import { PUT as putTelegram } from "../telegram/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { setTelegramWebhook } from "@/lib/telegram";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

const routes = {
  webhook: putWebhook,
  ntfy: putNtfy,
  email: putEmail,
  telegram: putTelegram,
};

type PutRoute = (request: Request) => Promise<Response>;

function put(channel: keyof typeof routes, body: unknown) {
  return (routes[channel] as PutRoute)(
    new Request(`http://localhost/api/settings/${channel}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.notificationChannel.updateMany).mockResolvedValue({
    count: 1,
  } as never);
  vi.mocked(prisma.notificationChannel.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.user.update).mockResolvedValue({} as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("notification channel enable-only routes", () => {
  it.each(Object.keys(routes) as Array<keyof typeof routes>)(
    "%s rejects unauthenticated toggle writes",
    async (channel) => {
      vi.mocked(getSession).mockResolvedValue(null);

      const response = await put(channel, { enabled: false });

      expect(response.status).toBe(401);
      expect(prisma.notificationChannel.updateMany).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    },
  );

  it("updates only the owned webhook enabled field", async () => {
    vi.mocked(prisma.notificationChannel.findUnique).mockResolvedValue({
      config:
        'encrypted:{"url":"https://saved.example/hook","headerName":"Authorization","headerValue":"secret"}',
    } as never);

    const response = await put("webhook", { enabled: true });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { saved: true },
      error: null,
    });
    expect(prisma.notificationChannel.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", type: "WEBHOOK" },
      data: { enabled: true },
    });
    expect(prisma.notificationChannel.upsert).not.toHaveBeenCalled();
  });

  it("updates only the owned ntfy enabled field", async () => {
    vi.mocked(prisma.notificationChannel.findUnique).mockResolvedValue({
      config:
        'encrypted:{"serverUrl":"https://ntfy.sh","topic":"saved-topic","authToken":"secret"}',
    } as never);

    const response = await put("ntfy", { enabled: true });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { saved: true },
      error: null,
    });
    expect(prisma.notificationChannel.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", type: "NTFY" },
      data: { enabled: true },
    });
    expect(prisma.notificationChannel.upsert).not.toHaveBeenCalled();
  });

  it("updates only the owned email enabled field", async () => {
    vi.mocked(prisma.notificationChannel.findUnique).mockResolvedValue({
      config: 'encrypted:{"recipient":"saved@example.com"}',
    } as never);

    const response = await put("email", { enabled: true });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { saved: true },
      error: null,
    });
    expect(prisma.notificationChannel.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", type: "EMAIL" },
      data: { enabled: true },
    });
    expect(prisma.notificationChannel.upsert).not.toHaveBeenCalled();
  });

  it("updates only Telegram enabled fields and leaves stored credentials untouched", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      telegramBotToken: "encrypted:saved-token",
      telegramChatId: "saved-chat",
      telegramEnabled: true,
    } as never);

    const response = await put("telegram", { enabled: false });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: { updated: true },
      error: null,
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { telegramEnabled: false },
    });
    expect(prisma.notificationChannel.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", type: "TELEGRAM" },
      data: { enabled: false },
    });
    expect(prisma.notificationChannel.upsert).not.toHaveBeenCalled();
    expect(prisma.notificationChannel.deleteMany).not.toHaveBeenCalled();
  });

  it("registers Telegram on enable without rewriting stored credentials", async () => {
    vi.stubEnv("APP_URL", "https://health.example");
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      telegramBotToken: "encrypted:saved-token",
      telegramChatId: "saved-chat",
      telegramEnabled: false,
    } as never);

    const response = await put("telegram", { enabled: true });

    expect(response.status).toBe(200);
    expect(setTelegramWebhook).toHaveBeenCalledWith(
      "saved-token",
      "https://health.example/api/telegram/webhook",
      undefined,
    );
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { telegramEnabled: true },
    });
    expect(prisma.notificationChannel.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", type: "TELEGRAM" },
      data: { enabled: true },
    });
    expect(prisma.notificationChannel.upsert).not.toHaveBeenCalled();
  });

  it.each([
    [
      "webhook",
      {
        url: "https://saved.example/hook",
        headerName: "X-Test",
        headerValue: "secret",
        enabled: false,
      },
    ],
    [
      "ntfy",
      {
        serverUrl: "https://ntfy.sh",
        topic: "saved-topic",
        authToken: "secret",
        enabled: false,
      },
    ],
    ["email", { recipient: "saved@example.com", enabled: false }],
  ] as const)(
    "keeps the existing full %s save contract",
    async (channel, body) => {
      vi.mocked(prisma.notificationChannel.findUnique).mockResolvedValue(null);

      const response = await put(channel, body);

      expect(response.status).toBe(200);
      expect(prisma.notificationChannel.upsert).toHaveBeenCalledOnce();
      expect(prisma.notificationChannel.updateMany).not.toHaveBeenCalled();
    },
  );

  it("keeps the existing full Telegram save contract", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      telegramBotToken: null,
      telegramChatId: null,
      telegramEnabled: false,
    } as never);

    const response = await put("telegram", {
      botToken: "new-token",
      chatId: "new-chat",
      enabled: false,
    });

    expect(response.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        telegramEnabled: false,
        telegramBotToken: "encrypted:new-token",
        telegramChatId: "new-chat",
      },
    });
    expect(prisma.notificationChannel.upsert).toHaveBeenCalledOnce();
    expect(prisma.notificationChannel.updateMany).not.toHaveBeenCalled();
  });

  it.each(["webhook", "ntfy", "email"] as const)(
    "rejects enabling an unconfigured %s channel without creating configuration",
    async (channel) => {
      vi.mocked(prisma.notificationChannel.findUnique).mockResolvedValue(null);

      const response = await put(channel, { enabled: true });

      expect(response.status).toBe(422);
      expect(prisma.notificationChannel.updateMany).not.toHaveBeenCalled();
      expect(prisma.notificationChannel.upsert).not.toHaveBeenCalled();
    },
  );
});
