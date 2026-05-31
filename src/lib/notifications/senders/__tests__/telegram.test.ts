/**
 * Telegram sender unit tests.
 *
 * v1.7.0 SB-SCHED-4 / code-correctness H2 — the pre-send delete must be
 * scoped to the single dose slot `{ medicationId, scheduleId, date,
 * phase, timeOfDay }`, NOT the whole medication. A multi-time-of-day
 * schedule keeps a distinct ledger row per slot; the legacy whole-
 * medication wipe deleted the morning row when the evening slot fired,
 * which made the worker's dedup `findUnique` miss and re-send the
 * morning reminder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendTelegramMessageMock = vi.fn();
const deleteMessageMock = vi.fn();
const findUniqueMock = vi.fn();
const deleteMock = vi.fn();
const upsertMock = vi.fn();

vi.mock("@/lib/telegram", () => ({
  sendTelegramMessage: (...args: unknown[]) => sendTelegramMessageMock(...args),
  deleteMessage: (...args: unknown[]) => deleteMessageMock(...args),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    telegramReminderMessage: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      delete: (...args: unknown[]) => deleteMock(...args),
      upsert: (...args: unknown[]) => upsertMock(...args),
    },
  },
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addWarning: vi.fn() }),
}));

vi.mock("@/lib/notifications/senders/push-attempt-record", () => ({
  recordPushAttempt: vi.fn(),
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
    deleteMock.mockResolvedValue(undefined);
    upsertMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("looks up only the exact slot composite before sending, not the whole medication", async () => {
    await sendViaTelegram(config, reminderPayload());

    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: {
        medicationId_scheduleId_date_phase_timeOfDay: {
          medicationId: "med-1",
          scheduleId: "sched-1",
          date: "2025-06-10",
          phase: "YELLOW",
          timeOfDay: "20:00",
        },
      },
    });
  });

  it("deletes only the matching slot's ledger row, leaving sibling slots untouched", async () => {
    // The 20:00 slot has a prior row; the lookup returns it.
    findUniqueMock.mockResolvedValue({
      chatId: "chat-1",
      messageId: 123,
    });

    await sendViaTelegram(config, reminderPayload());

    // The Telegram message for the old 20:00 row is deleted...
    expect(deleteMessageMock).toHaveBeenCalledWith("bot-token", "chat-1", 123);
    // ...and exactly that single ledger row is removed (scoped delete, not deleteMany).
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith({
      where: {
        medicationId_scheduleId_date_phase_timeOfDay: {
          medicationId: "med-1",
          scheduleId: "sched-1",
          date: "2025-06-10",
          phase: "YELLOW",
          timeOfDay: "20:00",
        },
      },
    });
  });

  it("does not delete anything when no prior row exists for the slot", async () => {
    findUniqueMock.mockResolvedValue(null);

    await sendViaTelegram(config, reminderPayload());

    expect(deleteMessageMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
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
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
