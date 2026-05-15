/**
 * v1.4.27 F21 — settings/telegram/test locale path.
 *
 * Asserts the per-user Telegram test message renders in the user's
 * persisted `User.locale` rather than the hardcoded English string
 * the pre-fix route used. The actual translator behaviour is covered
 * by `notifications/__tests__/admin-locale.test.ts`; this file is
 * the route-level smoke test that confirms the wiring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown) => ({ ok: true, data }),
  apiError: (message: string, status: number) => ({
    ok: false,
    error: message,
    status,
  }),
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: (s: string) => `decrypted(${s})`,
}));

const sendTelegramMessageMock = vi.fn();
vi.mock("@/lib/telegram", () => ({
  sendTelegramMessage: (...args: unknown[]) => sendTelegramMessageMock(...args),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

const tCalls: Array<{ locale: string; key: string }> = [];
vi.mock("@/lib/i18n/server-translator", () => ({
  getServerTranslator: (locale: string) => ({
    locale,
    t: (key: string) => {
      tCalls.push({ locale, key });
      const fakeStrings: Record<string, Record<string, string>> = {
        de: {
          "notifications.user.telegramTestBody":
            "HealthLog: Verbindung hergestellt. Telegram-Benachrichtigungen sind aktiv.",
        },
        en: {
          "notifications.user.telegramTestBody":
            "HealthLog: connection successful. Telegram notifications are active.",
        },
        fr: {
          "notifications.user.telegramTestBody":
            "HealthLog: connexion réussie. Les notifications Telegram sont actives.",
        },
      };
      return (fakeStrings[locale] ?? fakeStrings.en)[key] ?? key;
    },
  }),
}));

import { POST } from "../telegram/test/route";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/api-handler";
import { checkRateLimit } from "@/lib/rate-limit";

beforeEach(() => {
  vi.resetAllMocks();
  tCalls.length = 0;
  vi.mocked(requireAuth).mockResolvedValue({
    user: { id: "user-1" },
  } as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 5,
    resetAt: Date.now() + 60_000,
  } as never);
  sendTelegramMessageMock.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/settings/telegram/test — locale-aware message", () => {
  it("sends the German body when User.locale=de", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      telegramBotToken: "enc-token",
      telegramChatId: "chat-1",
      locale: "de",
    } as never);

    const result = await (POST as () => Promise<unknown>)();

    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    const [, , body] = sendTelegramMessageMock.mock.calls[0];
    expect(body).toBe(
      "HealthLog: Verbindung hergestellt. Telegram-Benachrichtigungen sind aktiv.",
    );
    expect(tCalls).toEqual([
      {
        locale: "de",
        key: "notifications.user.telegramTestBody",
      },
    ]);
    expect((result as { ok: boolean }).ok).toBe(true);
  });

  it("sends the French body when User.locale=fr", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      telegramBotToken: "enc-token",
      telegramChatId: "chat-1",
      locale: "fr",
    } as never);

    await (POST as () => Promise<unknown>)();

    const [, , body] = sendTelegramMessageMock.mock.calls[0];
    expect(body).toBe(
      "HealthLog: connexion réussie. Les notifications Telegram sont actives.",
    );
  });

  it("falls back to the default locale (en) when User.locale is null", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      telegramBotToken: "enc-token",
      telegramChatId: "chat-1",
      locale: null,
    } as never);

    await (POST as () => Promise<unknown>)();

    const [, , body] = sendTelegramMessageMock.mock.calls[0];
    expect(body).toBe(
      "HealthLog: connection successful. Telegram notifications are active.",
    );
    expect(tCalls[0].locale).toBe("en");
  });

  it("falls back to the default locale (en) when User.locale is unsupported", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      telegramBotToken: "enc-token",
      telegramChatId: "chat-1",
      locale: "klingon",
    } as never);

    await (POST as () => Promise<unknown>)();

    expect(tCalls[0].locale).toBe("en");
  });

  it("returns a 422 error when bot token is not configured", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      telegramBotToken: null,
      telegramChatId: null,
      locale: "de",
    } as never);

    const result = await (POST as () => Promise<unknown>)();

    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
    expect((result as { status: number }).status).toBe(422);
  });

  it("returns a 429 error when rate-limited", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    } as never);

    const result = await (POST as () => Promise<unknown>)();

    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
    expect((result as { status: number }).status).toBe(429);
  });

  it("returns a 422 error when the Telegram send fails", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      telegramBotToken: "enc-token",
      telegramChatId: "chat-1",
      locale: "en",
    } as never);
    sendTelegramMessageMock.mockResolvedValueOnce({ ok: false });

    const result = await (POST as () => Promise<unknown>)();

    expect((result as { status: number }).status).toBe(422);
  });
});
