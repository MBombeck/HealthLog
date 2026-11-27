/**
 * APNs dispatch integration test (v1.4.23).
 *
 * Drives `dispatchNotification` against a real Postgres testcontainer
 * with a stubbed `@parse/node-apn` Provider. Asserts:
 *
 *  1. Round-trip: a user with an APNS NotificationChannel + a Device
 *     row that carries `apnsToken` + `apnsEnvironment` receives an APNs
 *     push and the channel-state machine records success.
 *  2. Failure path: when APNs returns `Unregistered` for every device,
 *     the Device row is deleted, the channel is auto-disabled with the
 *     captured reason, and an audit-log entry is written.
 *  3. Cascade: when APNs is auto-disabled, the dispatcher falls through
 *     to Telegram on the next dispatch (different audit / different
 *     sender invoked).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Crypto module reads ENCRYPTION_KEY lazily on first encrypt(); seed a
// deterministic 32-byte test key before any test imports @/lib/crypto.
// Mirrors the pattern used by admin-backups-download.test.ts et al.
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const apnsSendMock = vi.fn();
const apnsShutdownMock = vi.fn();

vi.mock("@parse/node-apn", () => {
  class Provider {
    constructor(_opts: unknown) {
      void _opts;
    }
    send(...args: unknown[]) {
      return apnsSendMock(...args);
    }
    shutdown() {
      return apnsShutdownMock();
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
  }
  return { default: { Provider, Notification }, Provider, Notification };
});

const telegramSendMock = vi.fn();

vi.mock("@/lib/notifications/senders/telegram", () => ({
  sendViaTelegram: (...args: unknown[]) => telegramSendMock(...args),
}));

import { getPrismaClient, truncateAllTables } from "./setup";

const TEST_USER_ID = "user-apns-dispatch-test";

// v1.4.47.2 — `loadApnsConfig` verifies the key parses as an ES256-compatible
// asymmetric key via `crypto.createPrivateKey`, so the fixture must be a real
// EC P-256 PEM (test-only, generated for this suite). Mirrors the constant
// used by the unit-level apns.test.ts so both layers exercise the live guard.
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
  // 12-factor `\n`-escaped single-line form a typical Coolify / docker-compose
  // `env_file` round-trip produces; `normaliseApnsPem` turns it back into the
  // multi-line PEM the EC parser expects.
  APNS_KEY: TEST_EC_PEM_LINES.join("\\n"),
};

beforeEach(async () => {
  vi.clearAllMocks();
  for (const [k, v] of Object.entries(APNS_ENV)) {
    process.env[k] = v;
  }
  delete process.env.APNS_PRODUCTION;
  // Reset the apns-sender module so the env-var loader re-reads.
  const apns = await import("@/lib/notifications/senders/apns");
  apns.resetApnsForTesting();

  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "apns-dispatch",
      email: "apns-dispatch@example.test",
    },
  });
});

afterEach(async () => {
  for (const k of [
    "APNS_KEY_ID",
    "APNS_TEAM_ID",
    "APNS_BUNDLE_ID",
    "APNS_KEY",
    "APNS_KEY_FILE",
    "APNS_PRODUCTION",
  ]) {
    delete process.env[k];
  }
  const apns = await import("@/lib/notifications/senders/apns");
  apns.resetApnsForTesting();
});

async function seedApnsChannel(): Promise<string> {
  const { encrypt } = await import("@/lib/crypto");
  const channel = await getPrismaClient().notificationChannel.create({
    data: {
      userId: TEST_USER_ID,
      type: "APNS",
      enabled: true,
      // APNS channel config is the empty record by design (per-device
      // token + environment live on the Device row), but the dispatcher
      // still decrypts it before the type switch — store an encrypted
      // empty JSON object so the path stays symmetric.
      config: encrypt("{}"),
    },
  });
  return channel.id;
}

async function seedDevice(opts: {
  apnsToken: string;
  apnsEnvironment?: "sandbox" | "production";
  token?: string;
  medicationDelivery?: "server" | "client" | null;
  lastSeen?: Date;
  localRunwayUntil?: Date | null;
}): Promise<string> {
  const device = await getPrismaClient().device.create({
    data: {
      userId: TEST_USER_ID,
      platform: "ios",
      token: opts.token ?? `legacy-${opts.apnsToken}`,
      bundleId: APNS_ENV.APNS_BUNDLE_ID,
      apnsToken: opts.apnsToken,
      apnsEnvironment: opts.apnsEnvironment ?? "sandbox",
      medicationDelivery: opts.medicationDelivery ?? null,
      ...(opts.lastSeen ? { lastSeen: opts.lastSeen } : {}),
      localRunwayUntil: opts.localRunwayUntil ?? null,
    },
  });
  return device.id;
}

describe("APNs dispatcher integration", () => {
  it("delivers a push end-to-end, records success, and clears cooldown", async () => {
    await seedApnsChannel();
    await seedDevice({ apnsToken: "abc123" });

    apnsSendMock.mockResolvedValueOnce({
      sent: [{ device: "abc123" }],
      failed: [],
    });

    const { dispatchNotification } =
      await import("@/lib/notifications/dispatcher");
    await dispatchNotification({
      userId: TEST_USER_ID,
      eventType: "MEDICATION_REMINDER",
      title: "Time for your meds",
      message: "Tylenol — 1 tablet",
    });

    expect(apnsSendMock).toHaveBeenCalledTimes(1);
    const note = apnsSendMock.mock.calls[0][0];
    expect(note.topic).toBe(APNS_ENV.APNS_BUNDLE_ID);
    expect(note.alert.title).toBe("Time for your meds");
    expect(note.alert.body).toBe("Tylenol — 1 tablet");
    expect(note.payload).toMatchObject({ eventType: "MEDICATION_REMINDER" });

    const ch = await getPrismaClient().notificationChannel.findFirst({
      where: { userId: TEST_USER_ID, type: "APNS" },
    });
    expect(ch?.enabled).toBe(true);
    expect(ch?.consecutiveFailures).toBe(0);
    expect(ch?.lastSuccessAt).toBeInstanceOf(Date);
    expect(ch?.nextRetryAt).toBeNull();
  });

  it("auto-disables the channel + deletes the dead Device on Unregistered", async () => {
    await seedApnsChannel();
    await seedDevice({ apnsToken: "dead-tok" });

    apnsSendMock.mockResolvedValueOnce({
      sent: [],
      failed: [
        {
          device: "dead-tok",
          status: 410,
          response: { reason: "Unregistered" },
        },
      ],
    });

    const { dispatchNotification } =
      await import("@/lib/notifications/dispatcher");
    await dispatchNotification({
      userId: TEST_USER_ID,
      eventType: "SYSTEM_ALERT",
      title: "test",
      message: "test",
    });

    const ch = await getPrismaClient().notificationChannel.findFirst({
      where: { userId: TEST_USER_ID, type: "APNS" },
    });
    expect(ch?.enabled).toBe(false);
    expect(ch?.disabledReason).toBe("Unregistered");

    const deadDevice = await getPrismaClient().device.findFirst({
      where: { apnsToken: "dead-tok" },
    });
    expect(deadDevice).toBeNull();

    const audit = await getPrismaClient().auditLog.findFirst({
      where: {
        userId: TEST_USER_ID,
        action: "notification.channel.auto_disabled",
      },
    });
    expect(audit).toBeTruthy();
  });

  it("keeps every device and the channel when APNs calls all of them not for this topic", async () => {
    const { GONE_LIMIT, readGoneHolds } =
      await import("@/lib/notifications/gone-registrations");
    await seedApnsChannel();
    const count = GONE_LIMIT + 3;
    for (let i = 0; i < count; i++) {
      await seedDevice({ apnsToken: `topic-${i}` });
    }
    apnsSendMock.mockImplementation(async (_note: unknown, token: string) => ({
      sent: [],
      failed: [
        {
          device: token,
          status: 400,
          response: { reason: "DeviceTokenNotForTopic" },
        },
      ],
    }));

    const { dispatchNotification } =
      await import("@/lib/notifications/dispatcher");
    await dispatchNotification({
      userId: TEST_USER_ID,
      eventType: "SYSTEM_ALERT",
      title: "test",
      message: "test",
    });
    apnsSendMock.mockReset();

    expect(await getPrismaClient().device.count()).toBe(count);
    const ch = await getPrismaClient().notificationChannel.findFirst({
      where: { userId: TEST_USER_ID, type: "APNS" },
    });
    expect(ch?.enabled).toBe(true);
    expect((await readGoneHolds()).map((h) => h.channel)).toEqual(["apns"]);
  });

  it("bounds a hung APNs provider and falls through to Telegram", async () => {
    const { encrypt } = await import("@/lib/crypto");
    await seedApnsChannel();
    await seedDevice({ apnsToken: "hung-apns-token" });
    await getPrismaClient().notificationChannel.create({
      data: {
        userId: TEST_USER_ID,
        type: "TELEGRAM",
        enabled: true,
        config: encrypt(
          JSON.stringify({ botToken: "telegram-token", chatId: "chat-id" }),
        ),
      },
    });

    apnsSendMock.mockImplementationOnce(() => new Promise(() => undefined));
    telegramSendMock.mockResolvedValueOnce({ ok: true, messageId: 42 });

    const { dispatchNotification } =
      await import("@/lib/notifications/dispatcher");
    const result = await dispatchNotification({
      userId: TEST_USER_ID,
      eventType: "MEDICATION_REMINDER",
      title: "fallback",
      message: "fallback",
    });

    expect(apnsSendMock).toHaveBeenCalledTimes(1);
    expect(telegramSendMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      dispatched: true,
      channelsAttempted: 2,
      channelsSucceeded: 1,
    });
  }, 7_000);

  it("falls through to Telegram when APNS is disabled", async () => {
    const { encrypt } = await import("@/lib/crypto");
    // Pre-existing disabled APNS channel from a previous failure run.
    await getPrismaClient().notificationChannel.create({
      data: {
        userId: TEST_USER_ID,
        type: "APNS",
        enabled: false,
        disabledReason: "Unregistered",
        config: encrypt("{}"),
      },
    });
    // Healthy Telegram channel.
    await getPrismaClient().notificationChannel.create({
      data: {
        userId: TEST_USER_ID,
        type: "TELEGRAM",
        enabled: true,
        config: encrypt(JSON.stringify({ botToken: "tok", chatId: "chat" })),
      },
    });

    telegramSendMock.mockResolvedValueOnce({ ok: true, messageId: 42 });

    const { dispatchNotification } =
      await import("@/lib/notifications/dispatcher");
    await dispatchNotification({
      userId: TEST_USER_ID,
      eventType: "MEDICATION_REMINDER",
      title: "fallback",
      message: "fallback",
    });

    expect(apnsSendMock).not.toHaveBeenCalled();
    expect(telegramSendMock).toHaveBeenCalledTimes(1);

    const tg = await getPrismaClient().notificationChannel.findFirst({
      where: { userId: TEST_USER_ID, type: "TELEGRAM" },
    });
    expect(tg?.lastSuccessAt).toBeInstanceOf(Date);
  });
});

/**
 * #179 — `Device.medicationDelivery` decides per device whether the server
 * pushes a medication reminder to it: `client` never, `server` always, and no
 * override follows the account-wide switch (`notificationPrefs.medication
 * .clientManaged` / `deliveryDefault`). Every other push reaches every device.
 */
describe("APNs per-device medication delivery", () => {
  async function setAccountClientManaged(on: boolean): Promise<void> {
    await getPrismaClient().user.update({
      where: { id: TEST_USER_ID },
      data: { notificationPrefs: { medication: { clientManaged: on } } },
    });
  }

  async function dispatch(
    eventType:
      "MEDICATION_REMINDER" | "PERSONAL_RECORD" = "MEDICATION_REMINDER",
    metadata: Record<string, unknown> = {
      medicationId: "med-1",
      scheduledAt: "2026-11-17T08:00:00.000Z",
    },
  ): Promise<string[]> {
    apnsSendMock.mockImplementation(async (_note: unknown, token: string) => ({
      sent: [{ device: token }],
      failed: [],
    }));
    const { dispatchNotification } =
      await import("@/lib/notifications/dispatcher");
    await dispatchNotification({
      userId: TEST_USER_ID,
      eventType,
      title: "Time for your meds",
      message: "1 tablet",
      metadata,
    });
    return apnsSendMock.mock.calls.map((c) => c[1] as string).sort();
  }

  it("skips a device set to client and pushes to the one that inherits a server account", async () => {
    await seedApnsChannel();
    await seedDevice({ apnsToken: "phone", medicationDelivery: "client" });
    await seedDevice({ apnsToken: "pad", medicationDelivery: null });
    await setAccountClientManaged(false);
    expect(await dispatch()).toEqual(["pad"]);
  });

  it("pushes to a device set to server even when the account leaves reminders to the app", async () => {
    await seedApnsChannel();
    await seedDevice({ apnsToken: "phone", medicationDelivery: "server" });
    await seedDevice({ apnsToken: "pad", medicationDelivery: null });
    await setAccountClientManaged(true);
    expect(await dispatch()).toEqual(["phone"]);
  });

  it("falls back to the account switch for devices without an override", async () => {
    await seedApnsChannel();
    await seedDevice({ apnsToken: "phone" });
    await seedDevice({ apnsToken: "pad" });
    await setAccountClientManaged(false);
    expect(await dispatch()).toEqual(["pad", "phone"]);
  });

  it("sends nothing over APNs and records the skip when every device delivers locally", async () => {
    await seedApnsChannel();
    await seedDevice({ apnsToken: "phone", medicationDelivery: "client" });
    await seedDevice({ apnsToken: "pad", medicationDelivery: null });
    await setAccountClientManaged(true);
    expect(await dispatch()).toEqual([]);
    // The ledger write is fire-and-forget; wait for it to land.
    let attempts: Array<{ result: string; reason: string | null }> = [];
    for (let i = 0; i < 40 && attempts.length === 0; i++) {
      attempts = await getPrismaClient().pushAttempt.findMany({
        where: { userId: TEST_USER_ID, channel: "APNS" },
      });
      if (attempts.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(attempts.map((a) => [a.result, a.reason])).toEqual([
      ["skipped", "client_managed"],
    ]);
  });

  it("hands a client device quiet for over 3 days back to the server until it shows up", async () => {
    const day = 86_400_000;
    await seedApnsChannel();
    await seedDevice({
      apnsToken: "quiet",
      medicationDelivery: "client",
      lastSeen: new Date(Date.now() - 3 * day - 60_000),
    });
    await seedDevice({
      apnsToken: "inherits",
      lastSeen: new Date(Date.now() - 4 * day),
    });
    await seedDevice({
      apnsToken: "recent",
      medicationDelivery: "client",
      lastSeen: new Date(Date.now() - 2 * day),
    });
    await setAccountClientManaged(true);
    expect(await dispatch()).toEqual(["inherits", "quiet"]);

    // It shows up again: local again.
    await getPrismaClient().device.updateMany({
      where: { userId: TEST_USER_ID },
      data: { lastSeen: new Date() },
    });
    apnsSendMock.mockClear();
    expect(await dispatch()).toEqual([]);
  });

  it("follows the runway a client device reported instead of the 3 days", async () => {
    const day = 86_400_000;
    await seedApnsChannel();
    // Quiet for 5 days, but planned for 2 more: still local.
    await seedDevice({
      apnsToken: "planned",
      medicationDelivery: "client",
      lastSeen: new Date(Date.now() - 5 * day),
      localRunwayUntil: new Date(Date.now() + 2 * day),
    });
    // Seen just now, but its plan ran out an hour ago: the server reminds.
    await seedDevice({
      apnsToken: "dry",
      medicationDelivery: "client",
      lastSeen: new Date(),
      localRunwayUntil: new Date(Date.now() - 3_600_000),
    });
    await setAccountClientManaged(false);
    expect(await dispatch()).toEqual(["dry"]);
  });

  it("pushes a follow-up for an open dose to every device", async () => {
    await seedApnsChannel();
    await seedDevice({ apnsToken: "phone", medicationDelivery: "client" });
    await seedDevice({ apnsToken: "pad", medicationDelivery: null });
    await setAccountClientManaged(true);
    expect(
      await dispatch("MEDICATION_REMINDER", {
        medicationId: "med-1",
        scheduledAt: "2026-11-17T08:00:00.000Z",
        followUp: true,
      }),
    ).toEqual(["pad", "phone"]);
  });

  it("never filters a push that is not a medication reminder", async () => {
    await seedApnsChannel();
    await seedDevice({ apnsToken: "phone", medicationDelivery: "client" });
    await seedDevice({ apnsToken: "pad", medicationDelivery: "client" });
    await setAccountClientManaged(true);
    const apns = await getPrismaClient().notificationChannel.findFirstOrThrow({
      where: { userId: TEST_USER_ID, type: "APNS" },
    });
    // Personal records are opt-in; switch them on for this channel.
    await getPrismaClient().notificationPreference.create({
      data: { channelId: apns.id, eventType: "PERSONAL_RECORD", enabled: true },
    });
    expect(await dispatch("PERSONAL_RECORD", {})).toEqual(["pad", "phone"]);
  });
});
