/**
 * APNs dispatch integration test (v1.4.23 Wave 3 / F4).
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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
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
}): Promise<string> {
  const device = await getPrismaClient().device.create({
    data: {
      userId: TEST_USER_ID,
      platform: "ios",
      token: opts.token ?? `legacy-${opts.apnsToken}`,
      bundleId: APNS_ENV.APNS_BUNDLE_ID,
      apnsToken: opts.apnsToken,
      apnsEnvironment: opts.apnsEnvironment ?? "sandbox",
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
