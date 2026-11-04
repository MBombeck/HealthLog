/**
 * v1.36.x — the delegated-dose notification, end to end against Postgres.
 *
 * The helper is exercised through the real dispatcher, the real preference
 * lookup and the real APNs sender (with the vendor client stubbed, the same
 * shape `apns-dispatch.test.ts` uses), so what is asserted is the row the
 * ledger actually holds rather than the call the helper meant to make.
 *
 * The three facts:
 *
 *  1. The owner gets exactly ONE `push_attempts` row for the event, and the
 *     delegate gets none. There is no delegate-directed push; the caregiver
 *     learns what they did from the response in their own session.
 *  2. An owner marking their own dose produces no send and no row at all.
 *  3. The owner's per-channel opt-out row suppresses it, which is what makes
 *     "default ON" a defaulted decision rather than an unconditional one.
 *
 * The ledger write is deliberately fire-and-forget in `recordPushAttempt`, so
 * the assertions poll for the expected row instead of reading once and hoping.
 * The poll is bounded and then asserted exactly: a helper that stops
 * dispatching times out and fails on the count, it does not pass on an empty
 * table.
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

import { getPrismaClient, truncateAllTables } from "./setup";

const OWNER_ID = "user-delegated-intake-owner";
const DELEGATE_ID = "user-delegated-intake-delegate";

// Test-only EC P-256 key — `loadApnsConfig` parses it before the sender will
// talk to the stubbed provider. Same fixture shape as `apns-dispatch.test.ts`.
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

async function seedMedication(): Promise<string> {
  const med = await getPrismaClient().medication.create({
    data: {
      userId: OWNER_ID,
      name: "Ramipril",
      dose: "5 mg",
    },
  });
  return med.id;
}

async function seedApnsChannel(): Promise<void> {
  const { encrypt } = await import("@/lib/crypto");
  await getPrismaClient().notificationChannel.create({
    data: {
      userId: OWNER_ID,
      type: "APNS",
      enabled: true,
      config: encrypt("{}"),
    },
  });
  await getPrismaClient().device.create({
    data: {
      userId: OWNER_ID,
      platform: "ios",
      token: "device-owner",
      bundleId: APNS_ENV.APNS_BUNDLE_ID,
      apnsToken: "owner-apns-token",
      apnsEnvironment: "sandbox",
    },
  });
}

/** Poll the ledger until it holds `expected` rows for the user, or give up. */
async function pushAttemptsFor(
  userId: string,
  expected: number,
): Promise<{ channel: string; eventType: string; result: string }[]> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const rows = await getPrismaClient().pushAttempt.findMany({
      where: { userId },
      select: { channel: true, eventType: true, result: true },
    });
    if (rows.length >= expected) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  return getPrismaClient().pushAttempt.findMany({
    where: { userId },
    select: { channel: true, eventType: true, result: true },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  for (const [k, v] of Object.entries(APNS_ENV)) process.env[k] = v;
  delete process.env.APNS_PRODUCTION;
  const apns = await import("@/lib/notifications/senders/apns");
  apns.resetApnsForTesting();
  const { __resetDispatchLocaleCacheForTests } =
    await import("@/lib/notifications/dispatch-localised");
  __resetDispatchLocaleCacheForTests();

  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.createMany({
    data: [
      {
        id: OWNER_ID,
        username: "owner-delegated-intake",
        email: "owner-delegated-intake@example.test",
        locale: "en",
      },
      {
        id: DELEGATE_ID,
        username: "wren",
        displayName: "Wren",
        email: "wren-delegated-intake@example.test",
        locale: "de",
      },
    ],
  });

  apnsSendMock.mockResolvedValue({
    sent: [{ device: "owner-apns-token" }],
    failed: [],
  });
});

describe("delegated intake notification", () => {
  it("notifies the owner once and the acting delegate not at all", async () => {
    await seedApnsChannel();
    const medicationId = await seedMedication();

    const { notifyDelegatedIntake } =
      await import("@/lib/notifications/delegated-intake");
    await notifyDelegatedIntake({
      ownerId: OWNER_ID,
      actorId: DELEGATE_ID,
      medicationId,
      status: "taken",
    });

    // The ledger first, deliberately: a dispatch that never landed and a
    // dispatch nobody recorded look identical from the mock's side.
    const ownerRows = await pushAttemptsFor(OWNER_ID, 1);
    expect(ownerRows).toEqual([
      { channel: "APNS", eventType: "SHARED_RECORD_INTAKE", result: "ok" },
    ]);

    const delegateRows = await getPrismaClient().pushAttempt.findMany({
      where: { userId: DELEGATE_ID },
    });
    expect(delegateRows).toEqual([]);

    expect(apnsSendMock).toHaveBeenCalledTimes(1);
    const note = apnsSendMock.mock.calls[0][0];
    // The owner's locale, not the delegate's, and the medication named the
    // way MEDICATION_REMINDER names one.
    expect(note.alert.title).toBe("Wren marked a dose");
    expect(note.alert.body).toBe("Ramipril: marked as taken by Wren.");
    expect(note.payload).toMatchObject({
      eventType: "SHARED_RECORD_INTAKE",
      medicationId,
    });
  });

  it("sends nothing when the owner marks their own dose", async () => {
    await seedApnsChannel();
    const medicationId = await seedMedication();

    const { notifyDelegatedIntake } =
      await import("@/lib/notifications/delegated-intake");
    await notifyDelegatedIntake({
      ownerId: OWNER_ID,
      actorId: OWNER_ID,
      medicationId,
      status: "taken",
    });

    expect(apnsSendMock).not.toHaveBeenCalled();
    // Wait out the ledger's fire-and-forget window before asserting absence,
    // so "no row" means no row rather than "not yet".
    await new Promise((r) => setTimeout(r, 250));
    expect(await getPrismaClient().pushAttempt.count()).toBe(0);
  });

  it("honours the owner's per-channel opt-out", async () => {
    await seedApnsChannel();
    const medicationId = await seedMedication();
    const channel =
      await getPrismaClient().notificationChannel.findFirstOrThrow({
        where: { userId: OWNER_ID, type: "APNS" },
      });
    await getPrismaClient().notificationPreference.create({
      data: {
        channelId: channel.id,
        eventType: "SHARED_RECORD_INTAKE",
        enabled: false,
      },
    });

    const { notifyDelegatedIntake } =
      await import("@/lib/notifications/delegated-intake");
    await notifyDelegatedIntake({
      ownerId: OWNER_ID,
      actorId: DELEGATE_ID,
      medicationId,
      status: "taken",
    });

    expect(apnsSendMock).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 250));
    expect(await getPrismaClient().pushAttempt.count()).toBe(0);
  });
});
