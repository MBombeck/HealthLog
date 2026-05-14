/**
 * Dispatcher reliability tests (v1.4.15 Phase B3).
 *
 * Drives the dispatcher through the four critical state transitions:
 *  1. Hard reject (web-push 410) → auto-disable + audit log + no retry.
 *  2. Soft reject (web-push 429) → counter increments, channel stays
 *     enabled, `nextRetryAt` set per backoff schedule.
 *  3. 5th consecutive transient failure → auto-disable with reason
 *     `give_up_after_5_failures`.
 *  4. Channel in cooldown (`nextRetryAt > now`) → sender is NOT called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    notificationChannel: {
      findMany: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn(async () => undefined),
}));

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

vi.mock("@/lib/notifications/senders/telegram", () => ({
  sendViaTelegram: (...args: unknown[]) => sendViaTelegramMock(...args),
}));
vi.mock("@/lib/notifications/senders/ntfy", () => ({
  sendViaNtfy: (...args: unknown[]) => sendViaNtfyMock(...args),
}));
vi.mock("@/lib/notifications/senders/web-push", () => ({
  sendViaWebPush: (...args: unknown[]) => sendViaWebPushMock(...args),
}));

import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";

type MockChannel = {
  id: string;
  userId: string;
  type: "TELEGRAM" | "NTFY" | "WEB_PUSH";
  enabled: boolean;
  config: string;
  consecutiveFailures: number;
  nextRetryAt: Date | null;
  preferences: { eventType: string; enabled: boolean }[];
};

function makeChannel(over: Partial<MockChannel> = {}): MockChannel {
  return {
    id: "ch-1",
    userId: "u-1",
    type: "WEB_PUSH",
    enabled: true,
    config: JSON.stringify({}),
    consecutiveFailures: 0,
    nextRetryAt: null,
    preferences: [],
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
  // Default: every update returns a counter of 1 — individual tests
  // override the resolved value when they need to drive a specific
  // failure count (e.g. the "5th in a row" give-up test).
  (
    prisma.notificationChannel.update as unknown as ReturnType<typeof vi.fn>
  ).mockResolvedValue({ consecutiveFailures: 1 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("dispatchNotification — hard reject (web-push 410)", () => {
  it("auto-disables the channel, writes audit, and does NOT retry", async () => {
    const channel = makeChannel({ type: "WEB_PUSH" });
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValueOnce([
      channel,
    ] as never);
    sendViaWebPushMock.mockResolvedValueOnce({
      ok: false,
      hardReject: true,
      statusCode: 410,
      reason: "web_push_410_gone",
    });

    await dispatchNotification({
      eventType: "SYSTEM_ALERT",
      userId: "u-1",
      title: "t",
      message: "m",
    });

    expect(sendViaWebPushMock).toHaveBeenCalledTimes(1);

    // Channel was auto-disabled with reason captured.
    const updateCalls = (
      prisma.notificationChannel.update as unknown as ReturnType<typeof vi.fn>
    ).mock.calls;
    const disablePayload = updateCalls.find(
      (c) => (c[0] as { data: { enabled?: boolean } }).data?.enabled === false,
    );
    expect(disablePayload).toBeTruthy();
    expect(
      (
        disablePayload?.[0] as {
          data: { disabledReason?: string };
        }
      ).data.disabledReason,
    ).toBe("web_push_410_gone");

    // Audit log entry written.
    expect(auditLog).toHaveBeenCalledWith(
      "notification.channel.auto_disabled",
      expect.objectContaining({
        userId: "u-1",
        details: expect.objectContaining({
          reason: "web_push_410_gone",
          kind: "hard_reject",
        }),
      }),
    );
  });
});

describe("dispatchNotification — soft reject (web-push 429)", () => {
  it("schedules backoff, increments counter, does NOT auto-disable", async () => {
    const channel = makeChannel({ type: "WEB_PUSH", consecutiveFailures: 0 });
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValueOnce([
      channel,
    ] as never);
    sendViaWebPushMock.mockResolvedValueOnce({
      ok: false,
      hardReject: false,
      statusCode: 429,
      reason: "web-push_429",
    });
    // First update (increment) returns counter=1.
    (prisma.notificationChannel.update as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ consecutiveFailures: 1 })
      .mockResolvedValue({});

    await dispatchNotification({
      eventType: "SYSTEM_ALERT",
      userId: "u-1",
      title: "t",
      message: "m",
    });

    const updateCalls = (
      prisma.notificationChannel.update as unknown as ReturnType<typeof vi.fn>
    ).mock.calls;
    // No update payload sets enabled=false → channel stays enabled.
    const disablePayload = updateCalls.find(
      (c) => (c[0] as { data: { enabled?: boolean } }).data?.enabled === false,
    );
    expect(disablePayload).toBeUndefined();

    // A `nextRetryAt` was scheduled — channel is in cooldown until then.
    const cooldownPayload = updateCalls.find(
      (c) =>
        (c[0] as { data: { nextRetryAt?: Date } }).data?.nextRetryAt instanceof
        Date,
    );
    expect(cooldownPayload).toBeTruthy();

    // No "auto_disabled" audit was written for a transient failure.
    const audits = vi.mocked(auditLog).mock.calls;
    const autoDisabledAudits = audits.filter(
      (call) => call[0] === "notification.channel.auto_disabled",
    );
    expect(autoDisabledAudits).toHaveLength(0);
  });
});

describe("dispatchNotification — give-up after 5 transient failures", () => {
  it("auto-disables on the 5th in-a-row failure", async () => {
    const channel = makeChannel({ type: "NTFY", consecutiveFailures: 4 });
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValueOnce([
      channel,
    ] as never);
    sendViaNtfyMock.mockResolvedValueOnce({
      ok: false,
      hardReject: false,
      statusCode: 503,
      reason: "ntfy_503",
    });
    // Counter post-increment is 5 → trips MAX_CONSECUTIVE_FAILURES.
    (prisma.notificationChannel.update as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ consecutiveFailures: 5 })
      .mockResolvedValue({});

    await dispatchNotification({
      eventType: "SYSTEM_ALERT",
      userId: "u-1",
      title: "t",
      message: "m",
    });

    // The give-up branch flipped enabled=false with the right reason.
    const updateCalls = (
      prisma.notificationChannel.update as unknown as ReturnType<typeof vi.fn>
    ).mock.calls;
    const giveUp = updateCalls.find(
      (c) =>
        (c[0] as { data: { disabledReason?: string } }).data?.disabledReason ===
        "give_up_after_5_failures",
    );
    expect(giveUp).toBeTruthy();
    expect((giveUp?.[0] as { data: { enabled?: boolean } }).data.enabled).toBe(
      false,
    );

    // Audit log entry written for give-up.
    expect(auditLog).toHaveBeenCalledWith(
      "notification.channel.auto_disabled",
      expect.objectContaining({
        userId: "u-1",
        details: expect.objectContaining({
          reason: "give_up_after_5_failures",
          kind: "transient_give_up",
        }),
      }),
    );
  });
});

describe("dispatchNotification — cooldown skip", () => {
  it("does NOT call the sender when nextRetryAt is in the future", async () => {
    const channel = makeChannel({
      type: "NTFY",
      nextRetryAt: new Date(Date.now() + 60_000),
    });
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValueOnce([
      channel,
    ] as never);

    await dispatchNotification({
      eventType: "SYSTEM_ALERT",
      userId: "u-1",
      title: "t",
      message: "m",
    });

    expect(sendViaNtfyMock).not.toHaveBeenCalled();
    expect(sendViaWebPushMock).not.toHaveBeenCalled();
    expect(sendViaTelegramMock).not.toHaveBeenCalled();
    // No update / audit when channel is in cooldown.
    expect(prisma.notificationChannel.update).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("DOES call the sender when nextRetryAt is in the past", async () => {
    const channel = makeChannel({
      type: "NTFY",
      nextRetryAt: new Date(Date.now() - 60_000),
    });
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValueOnce([
      channel,
    ] as never);
    sendViaNtfyMock.mockResolvedValueOnce({ ok: true });

    await dispatchNotification({
      eventType: "SYSTEM_ALERT",
      userId: "u-1",
      title: "t",
      message: "m",
    });

    expect(sendViaNtfyMock).toHaveBeenCalledTimes(1);
    // Success path resets the counter + clears nextRetryAt.
    const updateCalls = (
      prisma.notificationChannel.update as unknown as ReturnType<typeof vi.fn>
    ).mock.calls;
    const success = updateCalls.find(
      (c) =>
        (c[0] as { data: { lastSuccessAt?: Date } }).data
          ?.lastSuccessAt instanceof Date,
    );
    expect(success).toBeTruthy();
  });
});

describe("dispatchNotification — per-event default policy (v1.4.25 W16c)", () => {
  it("PERSONAL_RECORD defaults OFF when no preference row exists", async () => {
    const channel = makeChannel({
      type: "NTFY",
      config: JSON.stringify({
        serverUrl: "https://ntfy.example",
        topic: "t",
      }),
      preferences: [],
    });
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValueOnce([
      channel,
    ] as never);

    await dispatchNotification({
      eventType: "PERSONAL_RECORD",
      userId: "u-1",
      title: "PR",
      message: "Best ever",
    });

    // No row → opt-in for this event type → sender NOT called.
    expect(sendViaNtfyMock).not.toHaveBeenCalled();
  });

  it("PERSONAL_RECORD fires when the user has explicitly opted in", async () => {
    const channel = makeChannel({
      type: "NTFY",
      config: JSON.stringify({
        serverUrl: "https://ntfy.example",
        topic: "t",
      }),
      preferences: [{ eventType: "PERSONAL_RECORD", enabled: true }],
    });
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValueOnce([
      channel,
    ] as never);
    sendViaNtfyMock.mockResolvedValueOnce({ ok: true });

    await dispatchNotification({
      eventType: "PERSONAL_RECORD",
      userId: "u-1",
      title: "PR",
      message: "Best ever",
    });

    expect(sendViaNtfyMock).toHaveBeenCalledTimes(1);
  });

  it("legacy events (MEDICATION_REMINDER) still default ON when no row exists", async () => {
    const channel = makeChannel({
      type: "NTFY",
      config: JSON.stringify({
        serverUrl: "https://ntfy.example",
        topic: "t",
      }),
      preferences: [],
    });
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValueOnce([
      channel,
    ] as never);
    sendViaNtfyMock.mockResolvedValueOnce({ ok: true });

    await dispatchNotification({
      eventType: "MEDICATION_REMINDER",
      userId: "u-1",
      title: "Reminder",
      message: "Take it",
    });

    expect(sendViaNtfyMock).toHaveBeenCalledTimes(1);
  });
});

describe("dispatchNotification — Telegram hard reject", () => {
  it("auto-disables on 'chat not found'", async () => {
    const channel = makeChannel({
      type: "TELEGRAM",
      config: JSON.stringify({ botToken: "t", chatId: "c" }),
    });
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValueOnce([
      channel,
    ] as never);
    sendViaTelegramMock.mockResolvedValueOnce({
      ok: false,
      hardReject: true,
      reason: "telegram_chat_not_found",
      message: "Bad Request: chat not found",
    });

    await dispatchNotification({
      eventType: "SYSTEM_ALERT",
      userId: "u-1",
      title: "t",
      message: "m",
    });

    expect(auditLog).toHaveBeenCalledWith(
      "notification.channel.auto_disabled",
      expect.objectContaining({
        details: expect.objectContaining({
          reason: "telegram_chat_not_found",
          kind: "hard_reject",
        }),
      }),
    );
  });
});
