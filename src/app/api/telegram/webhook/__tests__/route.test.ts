import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// --- Module-boundary mocks must come before importing the route. ---

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findFirst: vi.fn() },
    medication: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    medicationIntakeEvent: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    telegramReminderMessage: {
      deleteMany: vi.fn(),
    },
    telegramScheduledDeletion: {
      createMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((value: string) => `decrypted:${value}`),
}));

vi.mock("@/lib/telegram", () => ({
  answerTelegramCallbackQuery: vi.fn().mockResolvedValue(undefined),
  deleteMessage: vi.fn().mockResolvedValue(undefined),
  sendTelegramMessage: vi.fn().mockResolvedValue({ messageId: 999, ok: true }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => ({
    setAuth: vi.fn(),
    addWarning: vi.fn(),
  })),
}));

import { POST, GET } from "../route";
import { prisma } from "@/lib/db";
import {
  answerTelegramCallbackQuery,
  deleteMessage,
  sendTelegramMessage,
} from "@/lib/telegram";
import { checkRateLimit } from "@/lib/rate-limit";

const ORIGINAL_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

const TG_USER = {
  id: "user-1",
  telegramBotToken: "ENC(token-blob)",
  locale: "en",
};

const MEDICATION = { id: "med-1", name: "Ramipril" };

beforeEach(() => {
  vi.resetAllMocks();
  process.env.TELEGRAM_WEBHOOK_SECRET = "sekret";
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 120,
    resetAt: Date.now() + 60_000,
  } as never);
  vi.mocked(prisma.user.findFirst).mockResolvedValue(TG_USER as never);
  vi.mocked(prisma.medication.findFirst).mockResolvedValue(MEDICATION as never);
  vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medication.update).mockResolvedValue({} as never);
  vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.medicationIntakeEvent.create).mockResolvedValue({} as never);
  vi.mocked(prisma.telegramReminderMessage.deleteMany).mockResolvedValue({
    count: 0,
  } as never);
  vi.mocked(prisma.telegramScheduledDeletion.createMany).mockResolvedValue({
    count: 0,
  } as never);
  vi.mocked(prisma.$transaction).mockResolvedValue([] as never);
  vi.mocked(answerTelegramCallbackQuery).mockResolvedValue(undefined as never);
  vi.mocked(deleteMessage).mockResolvedValue(undefined as never);
  vi.mocked(sendTelegramMessage).mockResolvedValue({
    messageId: 999,
    ok: true,
  } as never);
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
  else process.env.TELEGRAM_WEBHOOK_SECRET = ORIGINAL_SECRET;
});

function tgRequest(
  body: unknown,
  headers: Record<string, string> = {
    "x-telegram-bot-api-secret-token": "sekret",
  },
): NextRequest {
  return new NextRequest("http://localhost/api/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function callbackUpdate(data: string, overrides: Record<string, unknown> = {}) {
  return {
    update_id: 100,
    callback_query: {
      id: "cb-1",
      data,
      from: { id: 7777 },
      message: {
        message_id: 555,
        chat: { id: 7777 },
      },
      ...overrides,
    },
  };
}

describe("Telegram webhook — secret verification", () => {
  it("returns 401 when the X-Telegram-Bot-Api-Secret-Token header is missing", async () => {
    const res = await POST(tgRequest(callbackUpdate("taken:med-1"), {}));
    expect(res.status).toBe(401);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it("returns 401 when the header is present but does not match the env secret", async () => {
    const res = await POST(
      tgRequest(callbackUpdate("taken:med-1"), {
        "x-telegram-bot-api-secret-token": "WRONG",
      }),
    );
    expect(res.status).toBe(401);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it("returns 401 when TELEGRAM_WEBHOOK_SECRET env var is unset (defence in depth)", async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const res = await POST(
      tgRequest(callbackUpdate("taken:med-1"), {
        "x-telegram-bot-api-secret-token": "anything",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 with a valid header secret (happy path baseline)", async () => {
    const res = await POST(tgRequest(callbackUpdate("taken:med-1")));
    expect(res.status).toBe(200);
  });
});

describe("Telegram webhook — rate limit", () => {
  it("returns 429 when rate-limited and never reads the secret/user", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    } as never);
    const res = await POST(tgRequest(callbackUpdate("taken:med-1")));
    expect(res.status).toBe(429);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });
});

describe("Telegram webhook — callback dispatch", () => {
  it("'taken:<medId>' creates a MedicationIntakeEvent + clears snoozedUntil + acks the callback", async () => {
    const res = await POST(tgRequest(callbackUpdate("taken:med-1")));
    expect(res.status).toBe(200);

    // $transaction is invoked with [create-intake, update-medication]. Inspect
    // its argument list for both writes.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const txOps = vi.mocked(prisma.$transaction).mock.calls[0][0] as unknown;
    expect(Array.isArray(txOps)).toBe(true);

    // The route calls prisma.medicationIntakeEvent.create + medication.update
    // synchronously while building the transaction array, so these mocks
    // record the arguments the way it built them.
    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledTimes(1);
    const intakeArgs = vi.mocked(prisma.medicationIntakeEvent.create).mock
      .calls[0][0];
    expect(intakeArgs.data).toMatchObject({
      userId: "user-1",
      medicationId: "med-1",
      skipped: false,
      source: "REMINDER",
    });
    expect(intakeArgs.data.idempotencyKey).toMatch(
      /^telegram:cb:7777:555:med-1/,
    );

    expect(prisma.medication.update).toHaveBeenCalledWith({
      where: { id: "med-1" },
      data: { snoozedUntil: null },
    });

    expect(answerTelegramCallbackQuery).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith(
      "decrypted:ENC(token-blob)",
      "7777",
      555,
    );
  });

  it("'taken:<medId>' is idempotent — replaying the same callback with the same message_id does NOT create a second intake event", async () => {
    // First call: existing-row lookup misses → write happens.
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValueOnce(
      null,
    );
    await POST(tgRequest(callbackUpdate("taken:med-1")));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    // Second call: existing-row lookup hits → no second write.
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValueOnce({
      id: "intake-existing",
    } as never);
    const res2 = await POST(tgRequest(callbackUpdate("taken:med-1")));
    expect(res2.status).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1); // unchanged
  });

  it("'snooze:<medId>:60' updates the medication's snoozedUntil and answers with the locale-translated message", async () => {
    const res = await POST(tgRequest(callbackUpdate("snooze:med-1:60")));
    expect(res.status).toBe(200);

    expect(prisma.medication.update).toHaveBeenCalledTimes(1);
    const updateArgs = vi.mocked(prisma.medication.update).mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: "med-1" });
    const snoozedUntil = (updateArgs.data as { snoozedUntil: Date })
      .snoozedUntil;
    expect(snoozedUntil).toBeInstanceOf(Date);
    // Allow some clock drift but verify ~60 minutes ahead.
    const deltaMs = snoozedUntil.getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(55 * 60_000);
    expect(deltaMs).toBeLessThan(65 * 60_000);

    expect(answerTelegramCallbackQuery).toHaveBeenCalledTimes(1);
    const ackText = vi.mocked(answerTelegramCallbackQuery).mock.calls[0][2];
    expect(ackText).toMatch(/Ramipril/);
    expect(ackText).toMatch(/1 hour/i);
  });

  it("'skip:<medId>' creates an intake event with skipped=true and snoozes through end-of-day", async () => {
    const res = await POST(tgRequest(callbackUpdate("skip:med-1")));
    expect(res.status).toBe(200);

    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledTimes(1);
    const intakeArgs = vi.mocked(prisma.medicationIntakeEvent.create).mock
      .calls[0][0];
    expect(intakeArgs.data).toMatchObject({
      userId: "user-1",
      medicationId: "med-1",
      skipped: true,
      takenAt: null,
      source: "REMINDER",
    });
    expect(intakeArgs.data.idempotencyKey).toMatch(
      /^telegram:skip:7777:555:med-1/,
    );

    const updateArgs = vi.mocked(prisma.medication.update).mock.calls[0][0];
    const snoozedUntil = (updateArgs.data as { snoozedUntil: Date })
      .snoozedUntil;
    expect(snoozedUntil.getHours()).toBe(23);
    expect(snoozedUntil.getMinutes()).toBe(59);
  });

  it("'ack:<medId>' answers the callback without creating an intake event", async () => {
    const res = await POST(tgRequest(callbackUpdate("ack:med-1")));
    expect(res.status).toBe(200);

    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(answerTelegramCallbackQuery).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it("unknown callback action is acked with an 'unknown action' message and writes nothing", async () => {
    const res = await POST(tgRequest(callbackUpdate("totally:bogus")));
    expect(res.status).toBe(200);

    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(prisma.medication.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(answerTelegramCallbackQuery).toHaveBeenCalledTimes(1);
    const ackText = vi.mocked(answerTelegramCallbackQuery).mock.calls[0][2];
    expect(ackText).toMatch(/unknown action/i);
  });

  it("ignores callbacks from chats with no enrolled Telegram user (no answer, no DB writes)", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValueOnce(null);
    const res = await POST(tgRequest(callbackUpdate("taken:med-1")));
    expect(res.status).toBe(200);
    expect(answerTelegramCallbackQuery).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
  });

  it("rejects 'taken' for an inactive medication and acks with the localised error", async () => {
    vi.mocked(prisma.medication.findFirst).mockResolvedValueOnce(null);
    const res = await POST(tgRequest(callbackUpdate("taken:med-1")));
    expect(res.status).toBe(200);

    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    const ackText = vi.mocked(answerTelegramCallbackQuery).mock.calls[0][2];
    expect(ackText).toMatch(/medication.*not.*found.*inactive/i);
  });

  it("'snooze' with an empty medication id acks with errorInvalidAction (no writes)", async () => {
    const res = await POST(tgRequest(callbackUpdate("snooze::60")));
    expect(res.status).toBe(200);
    expect(prisma.medication.update).not.toHaveBeenCalled();
    const ackText = vi.mocked(answerTelegramCallbackQuery).mock.calls[0][2];
    expect(ackText).toMatch(/invalid action/i);
  });

  it("'snooze' for a missing medication acks with medicationNotFound (no update)", async () => {
    vi.mocked(prisma.medication.findFirst).mockResolvedValueOnce(null);
    const res = await POST(tgRequest(callbackUpdate("snooze:med-X:60")));
    expect(res.status).toBe(200);
    expect(prisma.medication.update).not.toHaveBeenCalled();
    const ackText = vi.mocked(answerTelegramCallbackQuery).mock.calls[0][2];
    expect(ackText).toMatch(/medication not found/i);
  });

  it("'add:<medId>:umid:<userMsgId>' creates an intake event and deletes both bot + user messages", async () => {
    const res = await POST(tgRequest(callbackUpdate("add:med-1:umid:1234")));
    expect(res.status).toBe(200);

    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledTimes(1);
    const intakeArgs = vi.mocked(prisma.medicationIntakeEvent.create).mock
      .calls[0][0];
    expect(intakeArgs.data.idempotencyKey).toMatch(
      /^telegram:add:7777:555:med-1/,
    );

    // Bot's selection message + user's /add command message both deleted.
    const deleteCalls = vi.mocked(deleteMessage).mock.calls;
    const ids = deleteCalls.map((c) => c[2]);
    expect(ids).toContain(555);
    expect(ids).toContain(1234);
  });

  it("'cancel_add:umid:1234' deletes both messages and acks with the cancelled message", async () => {
    const res = await POST(tgRequest(callbackUpdate("cancel_add:umid:1234")));
    expect(res.status).toBe(200);

    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    const ids = vi.mocked(deleteMessage).mock.calls.map((c) => c[2]);
    expect(ids).toContain(555);
    expect(ids).toContain(1234);
    const ackText = vi.mocked(answerTelegramCallbackQuery).mock.calls[0][2];
    expect(ackText).toMatch(/cancelled/i);
  });
});

describe("Telegram webhook — text-message dispatch", () => {
  it("returns 200 'ok' for /help and replies with help text", async () => {
    const update = {
      update_id: 200,
      message: {
        message_id: 11,
        text: "/help",
        chat: { id: 7777 },
      },
    };
    const res = await POST(tgRequest(update));
    expect(res.status).toBe(200);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    const text = vi.mocked(sendTelegramMessage).mock.calls[0][2];
    expect(text).toMatch(/available commands/i);
  });

  it("ignores unrelated text — never calls sendTelegramMessage", async () => {
    const update = {
      update_id: 201,
      message: {
        message_id: 12,
        text: "the weather is nice today",
        chat: { id: 7777 },
      },
    };
    const res = await POST(tgRequest(update));
    expect(res.status).toBe(200);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
  });

  it("greeting like 'hi' echoes a friendly reply", async () => {
    const res = await POST(
      tgRequest({
        update_id: 202,
        message: {
          message_id: 13,
          text: "hi",
          chat: { id: 7777 },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTelegramMessage).mock.calls[0][2]).toMatch(/Hi!/);
  });

  it("/add with no active medications replies with the 'no active' message", async () => {
    vi.mocked(prisma.medication.findMany).mockResolvedValueOnce([] as never);
    const res = await POST(
      tgRequest({
        update_id: 203,
        message: {
          message_id: 14,
          text: "/add",
          chat: { id: 7777 },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(vi.mocked(sendTelegramMessage).mock.calls[0][2]).toMatch(
      /no active medication/i,
    );
  });

  it("/add with exactly one active medication marks it taken without prompting", async () => {
    vi.mocked(prisma.medication.findMany).mockResolvedValueOnce([
      { id: "med-only", name: "Aspirin", dose: "100mg" },
    ] as never);
    const res = await POST(
      tgRequest({
        update_id: 204,
        message: {
          message_id: 15,
          text: "/add",
          chat: { id: 7777 },
        },
      }),
    );
    expect(res.status).toBe(200);
    // markMedicationTaken → findFirst on active medication
    expect(prisma.medication.findFirst).toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledTimes(1);
  });

  it("/add with multiple medications sends a keyboard listing them with cancel_add", async () => {
    vi.mocked(prisma.medication.findMany).mockResolvedValueOnce([
      { id: "med-a", name: "Aspirin", dose: "100mg" },
      { id: "med-b", name: "Bisoprolol", dose: "5mg" },
    ] as never);

    const res = await POST(
      tgRequest({
        update_id: 205,
        message: {
          message_id: 16,
          text: "/add",
          chat: { id: 7777 },
        },
      }),
    );
    expect(res.status).toBe(200);

    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(sendTelegramMessage).mock.calls[0][3] as {
      replyMarkup: { inline_keyboard: { callback_data: string }[][] };
    };
    const flatData = opts.replyMarkup.inline_keyboard
      .flat()
      .map((b) => b.callback_data);
    expect(flatData).toEqual(
      expect.arrayContaining([
        "add:med-a:umid:16",
        "add:med-b:umid:16",
        "cancel_add:umid:16",
      ]),
    );
    // No intake yet — user still has to choose.
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
  });

  it("'taken Ramipril' (text command) creates an intake event for the matched medication", async () => {
    vi.mocked(prisma.medication.findFirst).mockResolvedValueOnce({
      id: "med-1",
    } as never);
    // Second findFirst inside markMedicationTaken
    vi.mocked(prisma.medication.findFirst).mockResolvedValueOnce({
      id: "med-1",
      name: "Ramipril",
    } as never);

    const res = await POST(
      tgRequest({
        update_id: 206,
        message: {
          message_id: 17,
          text: "taken Ramipril",
          chat: { id: 7777 },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledTimes(1);
    const intakeArgs = vi.mocked(prisma.medicationIntakeEvent.create).mock
      .calls[0][0];
    expect(intakeArgs.data.idempotencyKey).toMatch(/^telegram:text:206:med-1/);
  });

  it("'taken' (no name) with no clearly matching medication asks for a medication name", async () => {
    // findMany returns 2 → ambiguous → ask
    vi.mocked(prisma.medication.findMany).mockResolvedValueOnce([
      { id: "med-a", name: "Aspirin" },
      { id: "med-b", name: "Bisoprolol" },
    ] as never);
    const res = await POST(
      tgRequest({
        update_id: 207,
        message: {
          message_id: 18,
          text: "taken",
          chat: { id: 7777 },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(vi.mocked(sendTelegramMessage).mock.calls[0][2]).toMatch(
      /specify a medication/i,
    );
  });

  it("'taken UnknownMed' replies with the medication-not-found message and writes nothing", async () => {
    // First findFirst (lookup by name) returns null
    vi.mocked(prisma.medication.findFirst).mockResolvedValueOnce(null);

    const res = await POST(
      tgRequest({
        update_id: 208,
        message: {
          message_id: 19,
          text: "taken UnknownMed",
          chat: { id: 7777 },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(vi.mocked(sendTelegramMessage).mock.calls[0][2]).toMatch(
      /not found/i,
    );
  });

  it("returns 200 ignored when the body has no message and no callback_query", async () => {
    const res = await POST(
      tgRequest({
        update_id: 999,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ignored");
  });

  it("returns 200 ignored when the body has no update_id", async () => {
    const res = await POST(tgRequest({ message: { text: "/help" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ignored");
  });

  it("returns 200 'invalid json' when the request body is malformed JSON", async () => {
    const req = new NextRequest("http://localhost/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "sekret",
      },
      body: "{not-valid",
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("invalid json");
  });
});

describe("Telegram webhook — GET verification", () => {
  it("returns 200 with a valid header secret", async () => {
    const req = new NextRequest("http://localhost/api/telegram/webhook", {
      headers: { "x-telegram-bot-api-secret-token": "sekret" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
  });

  it("returns 401 without a header secret", async () => {
    const req = new NextRequest("http://localhost/api/telegram/webhook");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });
});
