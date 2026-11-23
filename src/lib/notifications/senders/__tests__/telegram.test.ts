/**
 * Telegram sender unit tests.
 *
 * v1.7.0 SB-SCHED-4 / code-correctness H2 — the pre-send delete must be
 * scoped to the recipient and single dose slot `{ recipientUserId,
 * medicationId, scheduleId, date, phase, timeOfDay }`, NOT the whole
 * medication. A multi-time-of-day
 * schedule keeps a distinct ledger row per slot; the legacy whole-
 * medication wipe deleted the morning row when the evening slot fired,
 * which made the worker's dedup `findUnique` miss and re-send the
 * morning reminder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendTelegramMessageMock = vi.fn();
const deleteMessageMock = vi.fn();
const findUniqueMock = vi.fn();
const upsertMock = vi.fn();
const userFindUniqueMock = vi.fn();

vi.mock("@/lib/telegram", () => ({
  sendTelegramMessage: (...args: unknown[]) => sendTelegramMessageMock(...args),
  deleteMessage: (...args: unknown[]) => deleteMessageMock(...args),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => userFindUniqueMock(...args),
    },
    telegramReminderMessage: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      upsert: (...args: unknown[]) => upsertMock(...args),
    },
  },
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addWarning: vi.fn() }),
}));

vi.mock("@/lib/notifications/senders/push-attempt-record", () => ({
  recordPushAttempt: vi.fn(),
  recordPushAttemptForPayload: vi.fn(),
}));

const scheduleTelegramAutoDeleteMock = vi.fn();
vi.mock("@/lib/telegram-cleanup", () => ({
  scheduleTelegramAutoDelete: (...args: unknown[]) =>
    scheduleTelegramAutoDeleteMock(...args),
  TELEGRAM_AUTO_DELETE_DELAY_MS: 30 * 60 * 1000,
}));

import { sendViaTelegram } from "../telegram";

const config = { botToken: "bot-token", chatId: "chat-1" };

function reminderPayload(over?: Record<string, unknown>) {
  return {
    eventType: "MEDICATION_REMINDER" as const,
    userId: "user-1",
    title: "t",
    message: "m",
    metadata: {
      medicationId: "med-1",
      scheduleId: "sched-1",
      phase: "YELLOW",
      date: "2025-06-10",
      timeOfDay: "20:00",
      ...over,
    },
  };
}

describe("sendViaTelegram — per-slot delete scope (H2)", () => {
  beforeEach(() => {
    sendTelegramMessageMock.mockResolvedValue({ ok: true, messageId: 999 });
    deleteMessageMock.mockResolvedValue(undefined);
    findUniqueMock.mockResolvedValue(null);
    upsertMock.mockResolvedValue(undefined);
    userFindUniqueMock.mockResolvedValue({ locale: "en" });
    scheduleTelegramAutoDeleteMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("looks up only the exact slot composite before sending, not the whole medication", async () => {
    await sendViaTelegram(config, reminderPayload());

    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: {
        recipientUserId_medicationId_scheduleId_date_phase_timeOfDay: {
          recipientUserId: "user-1",
          medicationId: "med-1",
          scheduleId: "sched-1",
          date: "2025-06-10",
          phase: "YELLOW",
          timeOfDay: "20:00",
        },
      },
    });
  });

  it("replaces only the matching slot's remote message, leaving its tracking row for update", async () => {
    // The 20:00 slot has a prior row; the lookup returns it.
    findUniqueMock.mockResolvedValue({
      chatId: "chat-1",
      messageId: 123,
    });

    await sendViaTelegram(config, reminderPayload());

    // The Telegram message for the old 20:00 row is deleted...
    expect(deleteMessageMock).toHaveBeenCalledWith("bot-token", "chat-1", 123);
    // The tracking row stays in place so the recipient-scoped upsert updates
    // it rather than creating a second row when the chat binding changes.
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          recipientUserId_medicationId_scheduleId_date_phase_timeOfDay: {
            recipientUserId: "user-1",
            medicationId: "med-1",
            scheduleId: "sched-1",
            date: "2025-06-10",
            phase: "YELLOW",
            timeOfDay: "20:00",
          },
        },
      }),
    );
  });

  it("does not delete anything when no prior row exists for the slot", async () => {
    findUniqueMock.mockResolvedValue(null);

    await sendViaTelegram(config, reminderPayload());

    expect(deleteMessageMock).not.toHaveBeenCalled();
    // It still sends + tracks the new message.
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });

  it("skips the delete entirely when the slot composite is incomplete", async () => {
    // No scheduleId / date → cannot key a slot; pre-v1.7 would wipe the
    // whole medication, the scoped path must do nothing.
    await sendViaTelegram(
      config,
      reminderPayload({ scheduleId: undefined, date: undefined }),
    );

    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("keeps two recipients' identical subject slots independent", async () => {
    await sendViaTelegram(
      { botToken: "bot-token", chatId: "guardian-chat-a" },
      {
        ...reminderPayload(),
        userId: "managed-record",
        recordUserId: "managed-record",
        recipientUserId: "guardian-a",
      },
    );
    await sendViaTelegram(
      { botToken: "bot-token", chatId: "guardian-chat-b" },
      {
        ...reminderPayload(),
        userId: "managed-record",
        recordUserId: "managed-record",
        recipientUserId: "guardian-b",
      },
    );

    expect(upsertMock).toHaveBeenCalledTimes(2);
    expect(upsertMock.mock.calls.map((call) => call[0].where)).toEqual([
      {
        recipientUserId_medicationId_scheduleId_date_phase_timeOfDay: {
          recipientUserId: "guardian-a",
          medicationId: "med-1",
          scheduleId: "sched-1",
          date: "2025-06-10",
          phase: "YELLOW",
          timeOfDay: "20:00",
        },
      },
      {
        recipientUserId_medicationId_scheduleId_date_phase_timeOfDay: {
          recipientUserId: "guardian-b",
          medicationId: "med-1",
          scheduleId: "sched-1",
          date: "2025-06-10",
          phase: "YELLOW",
          timeOfDay: "20:00",
        },
      },
    ]);
  });

  it("omits a record's inline actions for a managed Guardian", async () => {
    await sendViaTelegram(
      { botToken: "bot-token", chatId: "guardian-chat" },
      {
        ...reminderPayload({
          replyMarkup: {
            inline_keyboard: [[{ text: "Take", callback_data: "taken:med-1" }]],
          },
        }),
        userId: "managed-record",
        recordUserId: "managed-record",
        recipientUserId: "guardian-1",
      },
    );

    expect(
      sendTelegramMessageMock.mock.calls[0][3].replyMarkup,
    ).toBeUndefined();
  });

  it("updates one recipient slot when its Telegram chat changes", async () => {
    findUniqueMock.mockResolvedValue({ chatId: "old-chat", messageId: 123 });

    await sendViaTelegram(
      { botToken: "bot-token", chatId: "new-chat" },
      reminderPayload(),
    );

    expect(deleteMessageMock).toHaveBeenCalledWith(
      "bot-token",
      "old-chat",
      123,
    );
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          recipientUserId_medicationId_scheduleId_date_phase_timeOfDay: {
            recipientUserId: "user-1",
            medicationId: "med-1",
            scheduleId: "sched-1",
            date: "2025-06-10",
            phase: "YELLOW",
            timeOfDay: "20:00",
          },
        },
        update: { chatId: "new-chat", messageId: 999 },
      }),
    );
  });
});

describe("sendViaTelegram — interactive mood + measurement (v1.19.0)", () => {
  beforeEach(() => {
    sendTelegramMessageMock.mockResolvedValue({ ok: true, messageId: 999 });
    deleteMessageMock.mockResolvedValue(undefined);
    findUniqueMock.mockResolvedValue(null);
    upsertMock.mockResolvedValue(undefined);
    userFindUniqueMock.mockResolvedValue({ locale: "en" });
    scheduleTelegramAutoDeleteMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("attaches a 1–5 mood keyboard + note/later row on MOOD_REMINDER", async () => {
    await sendViaTelegram(config, {
      eventType: "MOOD_REMINDER",
      userId: "user-1",
      title: "t",
      message: "How are you feeling today?",
    });

    const opts = sendTelegramMessageMock.mock.calls[0][3];
    const rows = opts.replyMarkup.inline_keyboard;
    expect(
      rows[0].map((b: { callback_data: string }) => b.callback_data),
    ).toEqual(["mood:1", "mood:2", "mood:3", "mood:4", "mood:5"]);
    expect(
      rows[1].map((b: { callback_data: string }) => b.callback_data),
    ).toEqual(["mood_note", "mood_later:120"]);
  });

  it("schedules the unanswered mood prompt for ~30-min self-clean", async () => {
    await sendViaTelegram(config, {
      eventType: "MOOD_REMINDER",
      userId: "user-1",
      title: "t",
      message: "m",
    });
    expect(scheduleTelegramAutoDeleteMock).toHaveBeenCalledWith(
      "user-1",
      "chat-1",
      [999],
    );
  });

  it("attaches a done/later keyboard on MEASUREMENT_REMINDER with a reminderId", async () => {
    await sendViaTelegram(config, {
      eventType: "MEASUREMENT_REMINDER",
      userId: "user-1",
      title: "t",
      message: "m",
      metadata: { reminderId: "rem-1" },
    });
    const opts = sendTelegramMessageMock.mock.calls[0][3];
    const row = opts.replyMarkup.inline_keyboard[0];
    expect(row.map((b: { callback_data: string }) => b.callback_data)).toEqual([
      "measure_done:rem-1",
      "measure_later:rem-1:180",
    ]);
    expect(scheduleTelegramAutoDeleteMock).toHaveBeenCalledWith(
      "user-1",
      "chat-1",
      [999],
    );
  });

  it("offers no keyboard on a MEASUREMENT_REMINDER whose actions are suppressed", async () => {
    // An appointment nudge. The reminder id is present and the event type
    // matches, so only the flag stands between the person and two buttons
    // that can answer nothing but "not found".
    await sendViaTelegram(config, {
      eventType: "MEASUREMENT_REMINDER",
      userId: "user-1",
      title: "t",
      message: "m",
      suppressActions: true,
      metadata: { reminderId: "rem-1" },
    });
    const opts = sendTelegramMessageMock.mock.calls[0][3];
    expect(opts.replyMarkup).toBeUndefined();
    expect(scheduleTelegramAutoDeleteMock).not.toHaveBeenCalled();
  });

  it("sends a plain MEASUREMENT_REMINDER (no keyboard, no self-clean) without a reminderId", async () => {
    await sendViaTelegram(config, {
      eventType: "MEASUREMENT_REMINDER",
      userId: "user-1",
      title: "t",
      message: "m",
    });
    const opts = sendTelegramMessageMock.mock.calls[0][3];
    expect(opts.replyMarkup).toBeUndefined();
    expect(scheduleTelegramAutoDeleteMock).not.toHaveBeenCalled();
  });
});

describe("sendViaTelegram — tap target", () => {
  beforeEach(() => {
    sendTelegramMessageMock.mockResolvedValue({ ok: true, messageId: 5 });
    findUniqueMock.mockResolvedValue(null);
    upsertMock.mockResolvedValue(undefined);
    userFindUniqueMock.mockResolvedValue({ locale: "en" });
    scheduleTelegramAutoDeleteMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function sent(): {
    text: string;
    replyMarkup?: { inline_keyboard: Record<string, string>[][] };
  } {
    const call = sendTelegramMessageMock.mock.calls[0] as [
      string,
      string,
      string,
      { replyMarkup?: { inline_keyboard: Record<string, string>[][] } },
    ];
    return { text: call[2], replyMarkup: call[3].replyMarkup };
  }

  it("adds an https URL button as its own row under the action buttons", async () => {
    await sendViaTelegram(config, {
      ...reminderPayload(),
      tap: {
        path: "/medications",
        url: "https://health.example/medications",
        label: "Open in HealthLog",
      },
    });
    const rows = sent().replyMarkup?.inline_keyboard ?? [];
    // The medication keyboard keeps its two callback rows first.
    expect(rows[0]?.[0]?.callback_data).toBe("taken:med-1");
    expect(rows.at(-1)).toEqual([
      {
        text: "Open in HealthLog",
        url: "https://health.example/medications",
      },
    ]);
    expect(sent().text).toBe("m");
  });

  it("creates a keyboard with only the URL button for an event without actions", async () => {
    await sendViaTelegram(config, {
      eventType: "DAILY_BRIEFING",
      userId: "user-1",
      title: "t",
      message: "line",
      tap: { path: "/", url: "https://health.example/", label: "Open" },
    });
    expect(sent().replyMarkup).toEqual({
      inline_keyboard: [[{ text: "Open", url: "https://health.example/" }]],
    });
  });

  it("falls back to an escaped text link on a plain-HTTP origin Telegram refuses as a button", async () => {
    await sendViaTelegram(config, {
      eventType: "DAILY_BRIEFING",
      userId: "user-1",
      title: "t",
      message: "line",
      tap: {
        path: "/?a=1&b=2",
        url: "http://nas.lan/?a=1&b=2",
        label: "Open <app>",
      },
    });
    expect(sent().replyMarkup).toBeUndefined();
    expect(sent().text).toBe(
      'line\n\n<a href="http://nas.lan/?a=1&amp;b=2">Open &lt;app&gt;</a>',
    );
  });

  it("carries no link at all for a loopback origin", async () => {
    await sendViaTelegram(config, {
      eventType: "DAILY_BRIEFING",
      userId: "user-1",
      title: "t",
      message: "line",
      tap: { path: "/", url: "https://localhost:3000/", label: "Open" },
    });
    expect(sent().replyMarkup).toBeUndefined();
    expect(sent().text).toBe("line");
  });

  it("keeps the 1–5 mood keyboard and adds the link row to the mood reminder", async () => {
    await sendViaTelegram(config, {
      eventType: "MOOD_REMINDER",
      userId: "user-1",
      title: "t",
      message: "How are you?",
      tap: {
        path: "/mood?add=1",
        url: "https://health.example/mood?add=1",
        label: "Open",
      },
    });
    const rows = sent().replyMarkup?.inline_keyboard ?? [];
    expect(rows[0]?.map((b) => b.callback_data)).toEqual([
      "mood:1",
      "mood:2",
      "mood:3",
      "mood:4",
      "mood:5",
    ]);
    expect(rows.at(-1)?.[0]?.url).toBe("https://health.example/mood?add=1");
  });
});

describe("sendViaTelegram — a dose reminder without its own keyboard", () => {
  beforeEach(() => {
    sendTelegramMessageMock.mockResolvedValue({ ok: true, messageId: 1 });
    findUniqueMock.mockResolvedValue(null);
    upsertMock.mockResolvedValue(undefined);
    scheduleTelegramAutoDeleteMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("gets the reminder job's keyboard: the person's locale and snooze length", async () => {
    userFindUniqueMock.mockResolvedValue({
      locale: "en",
      notificationPrefs: { medication: { snoozeMinutes: 45 } },
    });

    await sendViaTelegram(config, reminderPayload());

    const sent = JSON.stringify(sendTelegramMessageMock.mock.calls[0]);
    expect(sent).toContain("snooze:med-1:45");
    expect(sent).not.toContain("snooze:med-1:60");
    expect(sent).not.toContain("snooze:med-1:180");
    expect(sent).not.toContain("Genommen");
  });
});
