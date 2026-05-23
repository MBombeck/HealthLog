/**
 * v1.4.49 — fire-and-forget push-attempt ledger writes across the
 * four senders (APNS, WEB_PUSH, TELEGRAM, NTFY).
 *
 * Pins:
 *   1. Every sender calls `prisma.pushAttempt.create` with the
 *      documented row shape (userId / channel / eventType / result /
 *      reason) on its primary exit paths.
 *   2. The write is fire-and-forget: a DB error from
 *      `pushAttempt.create` MUST NOT surface to the caller. The
 *      sender's `SendOutcome` carries on as if the ledger write had
 *      succeeded so the actual push delivery semantics stay intact.
 *   3. The ledger writes are scoped to the right channel discriminator
 *      ("APNS" | "WEB_PUSH" | "TELEGRAM" | "NTFY") — no accidental
 *      cross-channel mislabeling under the shared helper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factories run before module top-level executes, so anything
// referenced inside a factory must be created via vi.hoisted to share
// the same hoisted scope.
const hoisted = vi.hoisted(() => ({
  apnsSendMock: vi.fn(),
  apnsShutdownMock: vi.fn(),
  webPushSetVapidDetailsMock: vi.fn(),
  webPushSendNotificationMock: vi.fn(),
  sendTelegramMessageMock: vi.fn(),
  deleteTelegramMessageMock: vi.fn(),
}));

vi.mock("@parse/node-apn", () => {
  class Provider {
    send(...args: unknown[]) {
      return hoisted.apnsSendMock(...args);
    }
    shutdown() {
      return hoisted.apnsShutdownMock();
    }
  }
  class Notification {
    public topic = "";
    public alert: unknown;
    public sound: string | undefined;
    public badge: number | undefined;
    public threadId: string | undefined;
    public collapseId: string | undefined;
    public payload: unknown;
    public category: string | undefined;
    public mutableContent: boolean | undefined;
    public interruptionLevel: string | undefined;
    public priority: number | undefined;
  }
  return { default: { Provider, Notification }, Provider, Notification };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    device: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    pushSubscription: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    pushAttempt: {
      create: vi.fn(),
    },
    telegramReminderMessage: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\(|\)$/g, ""),
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({
    addExternalCall: vi.fn(),
    addWarning: vi.fn(),
    setError: vi.fn(),
  }),
}));

vi.mock("@/lib/notifications/vapid-config", () => ({
  getVapidConfig: vi.fn().mockResolvedValue({
    subject: "mailto:test@healthlog.local",
    publicKey: "vapid-public-key",
    privateKey: "vapid-private-key",
  }),
}));

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: hoisted.webPushSetVapidDetailsMock,
    sendNotification: hoisted.webPushSendNotificationMock,
  },
  setVapidDetails: hoisted.webPushSetVapidDetailsMock,
  sendNotification: hoisted.webPushSendNotificationMock,
}));

vi.mock("@/lib/telegram", () => ({
  sendTelegramMessage: hoisted.sendTelegramMessageMock,
  deleteMessage: hoisted.deleteTelegramMessageMock,
}));

import { sendViaApns, resetApnsForTesting } from "@/lib/notifications/senders/apns";
import { sendViaWebPush } from "@/lib/notifications/senders/web-push";
import { sendViaTelegram } from "@/lib/notifications/senders/telegram";
import { sendViaNtfy } from "@/lib/notifications/senders/ntfy";
import { prisma } from "@/lib/db";

const TEST_EC_PEM_LINES = [
  "-----BEGIN PRIVATE KEY-----",
  "MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgLOXP3Exjr5L5tamN",
  "pTxck85Iaum80PdRlWDpc/ezviOgCgYIKoZIzj0DAQehRANCAAT1x8nKRb8KshQU",
  "1aPieSCqOY6ilgC959umaFSlhfav8eZ91UHP/xond9aMoZcuQ7lJG/Rsj70SWMvZ",
  "bw81BG89",
  "-----END PRIVATE KEY-----",
];
const APNS_ENV = {
  APNS_KEY_ID: "ABCDE12345",
  APNS_TEAM_ID: "TEAM123456",
  APNS_BUNDLE_ID: "test.healthlog.ios",
  APNS_KEY: TEST_EC_PEM_LINES.join("\\n"),
};

function setApnsEnv(over: Record<string, string | undefined> = {}): void {
  for (const k of [
    "APNS_KEY_ID",
    "APNS_TEAM_ID",
    "APNS_BUNDLE_ID",
    "APNS_KEY",
    "APNS_KEY_B64",
    "APNS_KEY_FILE",
    "APNS_PRODUCTION",
  ]) {
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(over)) {
    if (v !== undefined) process.env[k] = v;
  }
}

// Capture every `create` call without forcing the test to a specific
// argument order. Each test asserts the call it cares about by
// filtering on `channel`.
function pushAttemptCalls(): Array<{
  userId: string;
  channel: string;
  eventType: string;
  result: string;
  reason: string | null;
}> {
  const create = vi.mocked(prisma.pushAttempt.create);
  return create.mock.calls.map((c) => {
    const args = c[0] as { data: Record<string, unknown> };
    return args.data as never;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.pushAttempt.create).mockResolvedValue({} as never);
  vi.mocked(prisma.device.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.device.deleteMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(prisma.pushSubscription.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.pushSubscription.deleteMany).mockResolvedValue({
    count: 0,
  } as never);
  resetApnsForTesting();
  setApnsEnv(APNS_ENV);
});

afterEach(() => {
  setApnsEnv();
  resetApnsForTesting();
});

// Helper — the recordPushAttempt helper is fire-and-forget. Tests
// resolve a microtask tick to give the swallowed promise time to land
// before assertions.
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("recordPushAttempt — APNS sender", () => {
  it("writes one ok row when the dispatch succeeds", async () => {
    vi.mocked(prisma.device.findMany).mockResolvedValue([
      {
        id: "dev-1",
        apnsToken: "a".repeat(64),
        apnsEnvironment: "sandbox",
      },
    ] as never);
    hoisted.apnsSendMock.mockResolvedValue({
      sent: [{ device: "a".repeat(64) }],
      failed: [],
    });

    const outcome = await sendViaApns("user-1", {
      title: "T",
      message: "M",
      eventType: "MEDICATION_REMINDER",
    });
    await flushMicrotasks();

    expect(outcome.ok).toBe(true);
    const apns = pushAttemptCalls().filter((c) => c.channel === "APNS");
    expect(apns).toHaveLength(1);
    expect(apns[0]).toMatchObject({
      userId: "user-1",
      channel: "APNS",
      eventType: "MEDICATION_REMINDER",
      result: "ok",
      reason: null,
    });
  });

  it("writes one error row carrying Apple's reason on hard reject", async () => {
    vi.mocked(prisma.device.findMany).mockResolvedValue([
      {
        id: "dev-1",
        apnsToken: "a".repeat(64),
        apnsEnvironment: "sandbox",
      },
    ] as never);
    hoisted.apnsSendMock.mockResolvedValue({
      sent: [],
      failed: [{ response: { reason: "BadDeviceToken" }, status: "410" }],
    });

    await sendViaApns("user-2", {
      title: "T",
      message: "M",
      eventType: "MEDICATION_REMINDER",
    });
    await flushMicrotasks();

    const apns = pushAttemptCalls().filter((c) => c.channel === "APNS");
    expect(apns).toHaveLength(1);
    expect(apns[0]).toMatchObject({
      userId: "user-2",
      channel: "APNS",
      eventType: "MEDICATION_REMINDER",
      result: "error",
      reason: "BadDeviceToken",
    });
  });

  it("writes a skipped row when no APNs devices are paired", async () => {
    vi.mocked(prisma.device.findMany).mockResolvedValue([] as never);

    await sendViaApns("user-3", {
      title: "T",
      message: "M",
      eventType: "MOOD_REMINDER",
    });
    await flushMicrotasks();

    const apns = pushAttemptCalls().filter((c) => c.channel === "APNS");
    expect(apns).toHaveLength(1);
    expect(apns[0]).toMatchObject({
      channel: "APNS",
      result: "skipped",
      reason: "apns_no_devices",
    });
  });

  it("does NOT surface a ledger DB error to the caller", async () => {
    vi.mocked(prisma.device.findMany).mockResolvedValue([
      {
        id: "dev-1",
        apnsToken: "a".repeat(64),
        apnsEnvironment: "sandbox",
      },
    ] as never);
    hoisted.apnsSendMock.mockResolvedValue({
      sent: [{ device: "a".repeat(64) }],
      failed: [],
    });
    // Simulate a DB hiccup on the ledger write. The sender contract
    // says this must not propagate.
    vi.mocked(prisma.pushAttempt.create).mockRejectedValue(
      new Error("connection refused"),
    );

    const outcome = await sendViaApns("user-4", {
      title: "T",
      message: "M",
      eventType: "MEDICATION_REMINDER",
    });
    await flushMicrotasks();

    expect(outcome.ok).toBe(true);
  });
});

describe("recordPushAttempt — WEB_PUSH sender", () => {
  it("writes one ok row when at least one subscription accepts the push", async () => {
    vi.mocked(prisma.pushSubscription.findMany).mockResolvedValue([
      {
        id: "sub-1",
        endpoint: "https://example.test/push",
        p256dh: "enc(p)",
        auth: "enc(a)",
      },
    ] as never);
    hoisted.webPushSendNotificationMock.mockResolvedValue(undefined);

    const outcome = await sendViaWebPush("user-1", {
      userId: "user-1",
      title: "T",
      message: "M",
      eventType: "MEASUREMENT_ANOMALY",
    });
    await flushMicrotasks();

    expect(outcome.ok).toBe(true);
    const rows = pushAttemptCalls().filter((c) => c.channel === "WEB_PUSH");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: "user-1",
      channel: "WEB_PUSH",
      eventType: "MEASUREMENT_ANOMALY",
      result: "ok",
    });
  });

  it("writes a skipped row when the user has zero subscriptions", async () => {
    vi.mocked(prisma.pushSubscription.findMany).mockResolvedValue([] as never);

    await sendViaWebPush("user-2", {
      userId: "user-2",
      title: "T",
      message: "M",
      eventType: "SYSTEM_ALERT",
    });
    await flushMicrotasks();

    const rows = pushAttemptCalls().filter((c) => c.channel === "WEB_PUSH");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      result: "skipped",
      reason: "web_push_no_subscriptions",
    });
  });

  it("does NOT surface a ledger DB error to the caller", async () => {
    vi.mocked(prisma.pushSubscription.findMany).mockResolvedValue([
      {
        id: "sub-1",
        endpoint: "https://example.test/push",
        p256dh: "enc(p)",
        auth: "enc(a)",
      },
    ] as never);
    hoisted.webPushSendNotificationMock.mockResolvedValue(undefined);
    vi.mocked(prisma.pushAttempt.create).mockRejectedValue(
      new Error("connection refused"),
    );

    const outcome = await sendViaWebPush("user-3", {
      userId: "user-3",
      title: "T",
      message: "M",
      eventType: "MEDICATION_REMINDER",
    });
    await flushMicrotasks();

    expect(outcome.ok).toBe(true);
  });
});

describe("recordPushAttempt — TELEGRAM sender", () => {
  it("writes one ok row carrying payload.userId when Telegram accepts the message", async () => {
    hoisted.sendTelegramMessageMock.mockResolvedValue({
      ok: true,
      messageId: 42,
    });

    const outcome = await sendViaTelegram(
      { botToken: "bot:test", chatId: "chat-1" },
      {
        userId: "user-tg-1",
        title: "T",
        message: "M",
        eventType: "MEDICATION_REMINDER",
      },
    );
    await flushMicrotasks();

    expect(outcome.ok).toBe(true);
    const rows = pushAttemptCalls().filter((c) => c.channel === "TELEGRAM");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: "user-tg-1",
      channel: "TELEGRAM",
      eventType: "MEDICATION_REMINDER",
      result: "ok",
    });
  });

  it("writes one error row with the classified reason on Telegram failure", async () => {
    hoisted.sendTelegramMessageMock.mockResolvedValue({
      ok: false,
      errorDescription: "Forbidden: bot was blocked by the user",
    });

    await sendViaTelegram(
      { botToken: "bot:test", chatId: "chat-1" },
      {
        userId: "user-tg-2",
        title: "T",
        message: "M",
        eventType: "MOOD_REMINDER",
      },
    );
    await flushMicrotasks();

    const rows = pushAttemptCalls().filter((c) => c.channel === "TELEGRAM");
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toBe("error");
    expect(rows[0].reason).toBeTruthy();
  });

  it("does NOT surface a ledger DB error to the caller", async () => {
    hoisted.sendTelegramMessageMock.mockResolvedValue({
      ok: true,
      messageId: 99,
    });
    vi.mocked(prisma.pushAttempt.create).mockRejectedValue(
      new Error("connection refused"),
    );

    const outcome = await sendViaTelegram(
      { botToken: "bot:test", chatId: "chat-1" },
      {
        userId: "user-tg-3",
        title: "T",
        message: "M",
        eventType: "SYSTEM_ALERT",
      },
    );
    await flushMicrotasks();

    expect(outcome.ok).toBe(true);
  });
});

describe("recordPushAttempt — NTFY sender", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch") as never;
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("writes one ok row when ntfy returns 200", async () => {
    (fetchSpy as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("", { status: 200 }),
    );

    const outcome = await sendViaNtfy(
      { serverUrl: "https://ntfy.test", topic: "hl" },
      {
        userId: "user-ntfy-1",
        title: "T",
        message: "M",
        eventType: "PERSONAL_RECORD",
      },
    );
    await flushMicrotasks();

    expect(outcome.ok).toBe(true);
    const rows = pushAttemptCalls().filter((c) => c.channel === "NTFY");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: "user-ntfy-1",
      channel: "NTFY",
      eventType: "PERSONAL_RECORD",
      result: "ok",
    });
  });

  it("writes one error row when ntfy returns 5xx", async () => {
    (fetchSpy as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("", { status: 503 }),
    );

    await sendViaNtfy(
      { serverUrl: "https://ntfy.test", topic: "hl" },
      {
        userId: "user-ntfy-2",
        title: "T",
        message: "M",
        eventType: "SYSTEM_ALERT",
      },
    );
    await flushMicrotasks();

    const rows = pushAttemptCalls().filter((c) => c.channel === "NTFY");
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toBe("error");
  });

  it("does NOT surface a ledger DB error to the caller", async () => {
    (fetchSpy as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("", { status: 200 }),
    );
    vi.mocked(prisma.pushAttempt.create).mockRejectedValue(
      new Error("connection refused"),
    );

    const outcome = await sendViaNtfy(
      { serverUrl: "https://ntfy.test", topic: "hl" },
      {
        userId: "user-ntfy-3",
        title: "T",
        message: "M",
        eventType: "PERSONAL_RECORD",
      },
    );
    await flushMicrotasks();

    expect(outcome.ok).toBe(true);
  });
});
