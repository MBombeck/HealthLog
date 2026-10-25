/**
 * Recovery readiness, end to end against Postgres: a weekly copy that stopped
 * reaches every admin exactly once per state change, through the real
 * readiness reader, the real notice ledger, the real dispatcher with its
 * preference lookup and ledger, and the real APNs sender (vendor client
 * stubbed, the shape `delegated-intake-notification.test.ts` uses).
 *
 * The facts:
 *
 *  1. A stale copy becomes one `BACKUP_HEALTH` delivery per admin; the next
 *     hourly runs at the same state add none.
 *  2. Escalating to failing adds one; a reminder comes a day later and not
 *     sooner; the recovery adds one; ok after that adds none.
 *  3. An admin who switched the event off on the channel gets nothing, and
 *     the notice is still spent, so switching it back on later does not
 *     replay an old alarm.
 *  4. The hourly job runs the same path from its handler.
 *
 * The ledger write is fire-and-forget in `recordPushAttempt`, so counts are
 * polled up to the expected number and then asserted exactly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const apnsSendMock = vi.fn();

vi.mock("@parse/node-apn", () => {
  class Provider {
    constructor(_opts: unknown) {
      void _opts;
    }
    send(...args: unknown[]) {
      return apnsSendMock(...args);
    }
    shutdown() {}
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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

import { getPrismaClient, truncateAllTables } from "./setup";

const ADMIN_ID = "user-readiness-admin";
const SECOND_ADMIN_ID = "user-readiness-admin-2";
const MEMBER_ID = "user-readiness-member";
const DAY = 86_400_000;
const HOUR = 3_600_000;

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

async function seedApnsChannel(userId: string): Promise<string> {
  const { encrypt } = await import("@/lib/crypto");
  const channel = await getPrismaClient().notificationChannel.create({
    data: { userId, type: "APNS", enabled: true, config: encrypt("{}") },
  });
  await getPrismaClient().device.create({
    data: {
      userId,
      platform: "ios",
      token: `device-${userId}`,
      bundleId: APNS_ENV.APNS_BUNDLE_ID,
      apnsToken: `apns-${userId}`,
      apnsEnvironment: "sandbox",
    },
  });
  return channel.id;
}

async function backupAttempts(
  userId: string,
  expected: number,
): Promise<number> {
  const count = () =>
    getPrismaClient().pushAttempt.count({
      where: { userId, eventType: "BACKUP_HEALTH" },
    });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await count()) >= expected) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  // A short settle, so a delivery that should NOT have happened has the same
  // chance to land as one that should.
  await new Promise((r) => setTimeout(r, 75));
  return count();
}

/** Put the member's weekly copy `ageDays` before `now`. */
async function weeklyCopyAged(ageDays: number, now: Date): Promise<void> {
  await getPrismaClient().dataBackup.upsert({
    where: { userId_type: { userId: MEMBER_ID, type: "WEEKLY_AUTO" } },
    create: {
      userId: MEMBER_ID,
      type: "WEEKLY_AUTO",
      data: "sealed",
      createdAt: new Date(now.getTime() - ageDays * DAY),
    },
    update: { createdAt: new Date(now.getTime() - ageDays * DAY) },
  });
}

/** One hourly evaluation at `now`, through the reader and the notifier. */
async function evaluateAt(now: Date) {
  const { readRecoveryReadiness } = await import("@/lib/recovery/readiness");
  const { notifyReadinessChanges } =
    await import("@/lib/recovery/readiness-notify");
  const readiness = await readRecoveryReadiness({ now });
  await notifyReadinessChanges(readiness, now);
  return readiness;
}

beforeEach(async () => {
  vi.clearAllMocks();
  for (const [k, v] of Object.entries(APNS_ENV)) process.env[k] = v;
  delete process.env.APNS_PRODUCTION;
  for (const name of [
    "BACKUP_S3_ENDPOINT",
    "BACKUP_S3_BUCKET",
    "BACKUP_S3_ACCESS_KEY",
    "BACKUP_S3_SECRET_KEY",
    "BACKUP_ENCRYPTION_KEY",
  ]) {
    delete process.env[name];
  }
  const apns = await import("@/lib/notifications/senders/apns");
  apns.resetApnsForTesting();
  const { __resetDispatchLocaleCacheForTests } =
    await import("@/lib/notifications/dispatch-localised");
  __resetDispatchLocaleCacheForTests();

  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  // Admins created "now": the setup grace keeps the off-host and kit signals
  // quiet, so the weekly copy is the only signal that moves.
  await prisma.user.createMany({
    data: [
      {
        id: ADMIN_ID,
        username: "readiness-admin",
        email: "readiness-admin@example.test",
        role: "ADMIN",
        locale: "en",
      },
      {
        id: SECOND_ADMIN_ID,
        username: "readiness-admin-2",
        email: "readiness-admin-2@example.test",
        role: "ADMIN",
        locale: "de",
      },
      {
        id: MEMBER_ID,
        username: "readiness-member",
        email: "readiness-member@example.test",
        createdAt: new Date(Date.now() - 90 * DAY),
      },
    ],
  });
  // An admin's own account needs a fresh copy too, or it would age from its
  // creation and move the verdict on its own.
  const now = new Date();
  for (const userId of [ADMIN_ID, SECOND_ADMIN_ID]) {
    await prisma.dataBackup.create({
      data: { userId, type: "WEEKLY_AUTO", data: "sealed", createdAt: now },
    });
  }

  apnsSendMock.mockImplementation(async (note: unknown) => {
    void note;
    return { sent: [{ device: "x" }], failed: [] };
  });
});

describe("recovery readiness push", () => {
  it("notifies every admin once per state change, reminds daily while failing, and announces the recovery once", async () => {
    await seedApnsChannel(ADMIN_ID);
    await seedApnsChannel(SECOND_ADMIN_ID);
    const t0 = new Date();
    const at = (hours: number) => new Date(t0.getTime() + hours * HOUR);

    // Ten days: attention.
    await weeklyCopyAged(10, t0);
    const first = await evaluateAt(t0);
    expect(first.signals.find((s) => s.id === "weekly_copy")).toMatchObject({
      state: "attention",
      reason: "stale",
    });
    expect(first.signals.find((s) => s.id === "recovery_kit")?.state).toBe(
      "ok",
    );
    await evaluateAt(at(1));
    await evaluateAt(at(2));
    expect(await backupAttempts(ADMIN_ID, 1)).toBe(1);
    expect(await backupAttempts(SECOND_ADMIN_ID, 1)).toBe(1);

    // Each admin in their own language.
    const titles = apnsSendMock.mock.calls.map(
      ([note]) => (note as { alert: { title: string } }).alert.title,
    );
    expect(titles).toContain("Backups need attention");
    expect(titles).toContain("Sicherungen brauchen Aufmerksamkeit");

    // Fifteen days: failing, once.
    await weeklyCopyAged(15, at(3));
    await evaluateAt(at(3));
    await evaluateAt(at(4));
    expect(await backupAttempts(ADMIN_ID, 2)).toBe(2);

    // Still failing: nothing until a day after the last notice, then one.
    await evaluateAt(at(3 + 23));
    expect(await backupAttempts(ADMIN_ID, 3)).toBe(2);
    await evaluateAt(at(3 + 24));
    await evaluateAt(at(3 + 25));
    expect(await backupAttempts(ADMIN_ID, 3)).toBe(3);

    // A fresh copy: one recovery notice, then silence.
    await weeklyCopyAged(0, at(30));
    await evaluateAt(at(30));
    await evaluateAt(at(31));
    expect(await backupAttempts(ADMIN_ID, 4)).toBe(4);
    expect(await backupAttempts(SECOND_ADMIN_ID, 4)).toBe(4);

    const notice = await getPrismaClient().recoveryReadinessNotice.findUnique({
      where: { signal: "weekly_copy" },
    });
    expect(notice?.notifiedState).toBe("ok");
  });

  it("respects an admin's per-channel opt-out and still spends the notice", async () => {
    const channelId = await seedApnsChannel(ADMIN_ID);
    await getPrismaClient().notificationPreference.create({
      data: { channelId, eventType: "BACKUP_HEALTH", enabled: false },
    });
    const t0 = new Date();
    await weeklyCopyAged(10, t0);
    await evaluateAt(t0);
    expect(await backupAttempts(ADMIN_ID, 1)).toBe(0);

    await getPrismaClient().notificationPreference.updateMany({
      where: { channelId },
      data: { enabled: true },
    });
    await evaluateAt(new Date(t0.getTime() + HOUR));
    expect(await backupAttempts(ADMIN_ID, 1)).toBe(0);
    const notice = await getPrismaClient().recoveryReadinessNotice.findUnique({
      where: { signal: "weekly_copy" },
    });
    expect(notice?.notifiedState).toBe("attention");
  });

  it("runs the same path from the hourly job", async () => {
    await seedApnsChannel(ADMIN_ID);
    await weeklyCopyAged(10, new Date());
    const { handleRecoveryReadiness } =
      await import("@/lib/jobs/recovery-readiness");
    const outcome = await handleRecoveryReadiness([]);
    expect(outcome).toMatchObject({
      ok: true,
      did: {
        recovery_readiness_state: "attention",
        recovery_readiness_notices: 1,
        recovery_readiness_admins: 2,
      },
    });
    await handleRecoveryReadiness([]);
    expect(await backupAttempts(ADMIN_ID, 1)).toBe(1);
  });
});
