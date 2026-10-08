/**
 * Client-managed suppression is APNs-only.
 *
 * `notificationPrefs.medication.clientManaged` (and its measurement-
 * reminder sibling) means "my iPhone schedules this reminder locally, so
 * don't push it". It never meant "stop telling me anywhere" — the OpenAPI
 * description, the settings copy and the iOS contract all say APNs. The
 * crons used to skip the whole dispatch, so a user who flipped the switch
 * also lost the Telegram reminder they read on a desktop.
 *
 * Pinned here: the APNs channel is skipped, every other channel still
 * sends, the skip is not counted as a delivery attempt, and the per-skip
 * wide-event annotation survives so the suppression stays countable.
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
  },
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => s,
  decrypt: (s: string) => s,
}));

const addMetaMock = vi.fn();
vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({
    addWarning: vi.fn(),
    addMeta: (key: string, value: unknown) => addMetaMock(key, value),
    addExternalCall: vi.fn(),
    setError: vi.fn(),
  }),
}));

const sendViaApnsMock = vi.fn();
const sendViaTelegramMock = vi.fn();
const recordPushAttemptMock = vi.fn();

vi.mock("@/lib/notifications/senders/apns", () => ({
  sendViaApns: (...args: unknown[]) => sendViaApnsMock(...args),
}));
vi.mock("@/lib/notifications/senders/telegram", () => ({
  sendViaTelegram: (...args: unknown[]) => sendViaTelegramMock(...args),
}));
vi.mock("@/lib/notifications/senders/push-attempt-record", () => ({
  recordPushAttempt: (...args: unknown[]) => recordPushAttemptMock(...args),
}));

import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { prisma } from "@/lib/db";

function channel(type: "APNS" | "TELEGRAM") {
  return {
    id: `ch-${type}`,
    userId: "u-1",
    type,
    enabled: true,
    config: JSON.stringify({ botToken: "b", chatId: "c" }),
    consecutiveFailures: 0,
    nextRetryAt: null,
    preferences: [],
  };
}

const MEDICATION_PAYLOAD = {
  eventType: "MEDICATION_REMINDER" as const,
  userId: "u-1",
  title: "t",
  message: "m",
  metadata: {
    medicationId: "med-1",
    scheduledAt: "2026-06-15T08:00:00.000Z",
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
    channel("APNS"),
    channel("TELEGRAM"),
  ] as never);
  sendViaApnsMock.mockResolvedValue({ ok: true });
  sendViaTelegramMock.mockResolvedValue({ ok: true });
  (
    prisma.notificationChannel.update as unknown as ReturnType<typeof vi.fn>
  ).mockResolvedValue({ consecutiveFailures: 0 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("dispatchNotification — client-managed APNs suppression", () => {
  it("skips APNs and still delivers over every other channel", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: { medication: { clientManaged: true } },
    } as never);

    const outcome = await dispatchNotification(MEDICATION_PAYLOAD);

    expect(sendViaApnsMock).not.toHaveBeenCalled();
    expect(sendViaTelegramMock).toHaveBeenCalledTimes(1);
    // The skipped channel is not an attempt — `dispatched` has to keep
    // meaning "something reached the user".
    expect(outcome.channelsAttempted).toBe(1);
    expect(outcome.channelsSucceeded).toBe(1);
    expect(outcome.dispatched).toBe(true);
  });

  it("keeps the skip countable in the wide event and the ledger", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: { medication: { clientManaged: true } },
    } as never);

    await dispatchNotification(MEDICATION_PAYLOAD);

    expect(addMetaMock).toHaveBeenCalledWith(
      "medication_reminder_suppressed_client_managed",
      "med-1:2026-06-15T08:00:00.000Z",
    );
    expect(addMetaMock).toHaveBeenCalledWith(
      "medication_reminder_suppressed_meta",
      {
        user_id: "u-1",
        medication_id: "med-1",
        schedule_id: "",
        phase: "",
        dose_at: "2026-06-15T08:00:00.000Z",
      },
    );
    expect(recordPushAttemptMock).toHaveBeenCalledWith({
      recordUserId: "u-1",
      recipientUserId: "u-1",
      channel: "APNS",
      eventType: "MEDICATION_REMINDER",
      result: "skipped",
      reason: "client_managed",
    });
  });

  it("keeps a follow-up for a dose still open on APNs, because the phone sends none", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: { medication: { clientManaged: true } },
    } as never);

    await dispatchNotification({
      ...MEDICATION_PAYLOAD,
      metadata: {
        ...MEDICATION_PAYLOAD.metadata,
        phase: "ORANGE",
        followUp: true,
      },
    });

    expect(sendViaApnsMock).toHaveBeenCalledTimes(1);
    expect(sendViaTelegramMock).toHaveBeenCalledTimes(1);
    expect(recordPushAttemptMock).not.toHaveBeenCalled();
  });

  it("still keeps the reminder that announces the dose off APNs", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: { medication: { clientManaged: true } },
    } as never);

    await dispatchNotification({
      ...MEDICATION_PAYLOAD,
      metadata: {
        ...MEDICATION_PAYLOAD.metadata,
        phase: "YELLOW",
        followUp: false,
      },
    });

    expect(sendViaApnsMock).not.toHaveBeenCalled();
    expect(sendViaTelegramMock).toHaveBeenCalledTimes(1);
  });

  it("honours the roaming deliveryDefault mapping", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: { medication: { deliveryDefault: "client" } },
    } as never);

    await dispatchNotification(MEDICATION_PAYLOAD);

    expect(sendViaApnsMock).not.toHaveBeenCalled();
  });

  it("suppresses the measurement reminder's APNs leg on its own flag", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: { measurementReminder: { clientManaged: true } },
    } as never);

    await dispatchNotification({
      eventType: "MEASUREMENT_REMINDER",
      userId: "u-1",
      title: "t",
      message: "m",
      metadata: { reminderId: "rem-1" },
    });

    expect(sendViaApnsMock).not.toHaveBeenCalled();
    expect(sendViaTelegramMock).toHaveBeenCalledTimes(1);
    expect(addMetaMock).toHaveBeenCalledWith(
      "measurement_reminder.suppressed_client_managed",
      "rem-1",
    );
  });

  it("sends over APNs when the flag is unset", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: null,
    } as never);

    await dispatchNotification(MEDICATION_PAYLOAD);

    expect(sendViaApnsMock).toHaveBeenCalledTimes(1);
    expect(recordPushAttemptMock).not.toHaveBeenCalled();
  });

  it("does not gate an event type that has no client-managed opt-out", async () => {
    // The medication flag must not leak across event types: a user who
    // owns their dose reminders locally still gets everything else.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPrefs: { medication: { clientManaged: true } },
    } as never);

    await dispatchNotification({
      eventType: "SYSTEM_ALERT",
      userId: "u-1",
      title: "t",
      message: "m",
    });

    expect(sendViaApnsMock).toHaveBeenCalledTimes(1);
  });
});
