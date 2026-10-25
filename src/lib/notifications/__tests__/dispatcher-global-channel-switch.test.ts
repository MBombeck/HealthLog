/**
 * The operator's instance-wide channel switches, asserted where they have to
 * hold: at dispatch.
 *
 * `AppSettings.telegramGlobal` / `.ntfyGlobal` / `.webPushGlobal` used to
 * decide only whether the setup card rendered under Settings → Integrations.
 * A channel a self-hoster had switched off kept delivering to every account
 * that had already configured it. These tests drive the real dispatcher over
 * a stubbed settings row and assert the user-visible outcome: nothing is
 * sent, and the push-attempt ledger says why.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn() },
    notificationChannel: { findMany: vi.fn(), update: vi.fn() },
    pushAttempt: { create: vi.fn() },
    user: { findUnique: vi.fn(), count: vi.fn().mockResolvedValue(0) },
  },
}));

vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn(async () => undefined) }));

vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => s,
  decrypt: (s: string) => s,
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({
    addWarning: vi.fn(),
    addMeta: vi.fn(),
    addExternalCall: vi.fn(),
    setError: vi.fn(),
  }),
}));

const sendViaTelegramMock = vi.fn();
const sendViaNtfyMock = vi.fn();
const sendViaWebPushMock = vi.fn();
const sendViaEmailMock = vi.fn();

vi.mock("@/lib/notifications/senders/email", () => ({
  sendViaEmail: (...args: unknown[]) => sendViaEmailMock(...args),
}));

vi.mock("@/lib/notifications/senders/telegram", () => ({
  sendViaTelegram: (...args: unknown[]) => sendViaTelegramMock(...args),
}));
vi.mock("@/lib/notifications/senders/ntfy", () => ({
  sendViaNtfy: (...args: unknown[]) => sendViaNtfyMock(...args),
}));
vi.mock("@/lib/notifications/senders/web-push", () => ({
  sendViaWebPush: (...args: unknown[]) => sendViaWebPushMock(...args),
}));

import { prisma } from "@/lib/db";
import { dispatchNotification } from "@/lib/notifications/dispatcher";

type ChannelKind = "TELEGRAM" | "NTFY" | "WEB_PUSH" | "EMAIL";

function makeChannel(type: ChannelKind) {
  return {
    id: `ch-${type}`,
    userId: "u-1",
    type,
    enabled: true,
    config: JSON.stringify({ serverUrl: "https://ntfy.example", topic: "t" }),
    consecutiveFailures: 0,
    nextRetryAt: null,
    preferences: [],
  };
}

function stubSettings(over: Record<string, boolean> = {}) {
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
    telegramGlobal: true,
    ntfyGlobal: true,
    webPushGlobal: true,
    apiGlobal: true,
    ...over,
  } as never);
}

const SENDERS: Record<ChannelKind, ReturnType<typeof vi.fn>> = {
  TELEGRAM: sendViaTelegramMock,
  NTFY: sendViaNtfyMock,
  WEB_PUSH: sendViaWebPushMock,
  EMAIL: sendViaEmailMock,
};

const SWITCH_COLUMN = {
  TELEGRAM: "telegramGlobal",
  NTFY: "ntfyGlobal",
  WEB_PUSH: "webPushGlobal",
} as const;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    managedProfileAt: null,
  } as never);
  vi.mocked(prisma.notificationChannel.update).mockResolvedValue({
    consecutiveFailures: 0,
  } as never);
  vi.mocked(prisma.pushAttempt.create).mockResolvedValue({} as never);
  stubSettings();
});

describe.each(["TELEGRAM", "NTFY", "WEB_PUSH"] as const)(
  "dispatchNotification — %s instance-wide switch",
  (type) => {
    it("sends nothing and writes a globally_disabled ledger row when the operator switched the channel off", async () => {
      stubSettings({ [SWITCH_COLUMN[type]]: false });
      vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
        makeChannel(type),
      ] as never);

      const outcome = await dispatchNotification({
        eventType: "SYSTEM_ALERT",
        userId: "u-1",
        title: "t",
        message: "m",
      });

      expect(SENDERS[type]).not.toHaveBeenCalled();
      expect(outcome).toEqual({
        dispatched: false,
        channelsAttempted: 0,
        channelsSucceeded: 0,
      });
      expect(prisma.pushAttempt.create).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(prisma.pushAttempt.create).mock.calls[0][0],
      ).toMatchObject({
        data: {
          channel: type,
          eventType: "SYSTEM_ALERT",
          result: "skipped",
          reason: "globally_disabled",
        },
      });
    });

    it("sends normally when the switch is on", async () => {
      stubSettings({ [SWITCH_COLUMN[type]]: true });
      vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
        makeChannel(type),
      ] as never);
      SENDERS[type].mockResolvedValue({ ok: true });

      const outcome = await dispatchNotification({
        eventType: "SYSTEM_ALERT",
        userId: "u-1",
        title: "t",
        message: "m",
      });

      expect(SENDERS[type]).toHaveBeenCalledTimes(1);
      expect(outcome.dispatched).toBe(true);
      expect(outcome.channelsSucceeded).toBe(1);
    });
  },
);

describe("dispatchNotification — switch scope", () => {
  it("reads the settings row once for a cascade that carries several switchable channels", async () => {
    stubSettings({ telegramGlobal: false, ntfyGlobal: false });
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      makeChannel("TELEGRAM"),
      makeChannel("NTFY"),
    ] as never);

    await dispatchNotification({
      eventType: "SYSTEM_ALERT",
      userId: "u-1",
      title: "t",
      message: "m",
    });

    expect(sendViaTelegramMock).not.toHaveBeenCalled();
    expect(sendViaNtfyMock).not.toHaveBeenCalled();
    expect(prisma.appSettings.findUnique).toHaveBeenCalledTimes(1);
  });

  it("never reads the settings row for a cascade with no switchable channel", async () => {
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      makeChannel("EMAIL"),
    ] as never);

    await dispatchNotification({
      eventType: "SYSTEM_ALERT",
      userId: "u-1",
      title: "t",
      message: "m",
    });

    expect(prisma.appSettings.findUnique).not.toHaveBeenCalled();
  });
});
