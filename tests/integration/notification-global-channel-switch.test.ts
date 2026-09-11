/**
 * The operator's instance-wide channel switches, against a real settings row.
 *
 * The unit suite stubs `prisma.appSettings.findUnique`; this one writes the
 * actual `app_settings` singleton, dispatches through the real cascade, and
 * reads the `push_attempts` ledger back out of Postgres. It is the layer that
 * proves the column the admin route writes is the column the dispatcher
 * reads — a unit mock would agree with itself even if those two drifted apart.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const ntfySendMock = vi.fn();

vi.mock("@/lib/notifications/senders/ntfy", () => ({
  sendViaNtfy: (...args: unknown[]) => ntfySendMock(...args),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

import { getPrismaClient, truncateAllTables } from "./setup";

const TEST_USER_ID = "user-global-channel-switch";

async function seedNtfyChannel(): Promise<void> {
  const { encrypt } = await import("@/lib/crypto");
  await getPrismaClient().notificationChannel.create({
    data: {
      userId: TEST_USER_ID,
      type: "NTFY",
      enabled: true,
      config: encrypt(
        JSON.stringify({ serverUrl: "https://ntfy.example", topic: "health" }),
      ),
    },
  });
}

async function setNtfyGlobal(ntfyGlobal: boolean): Promise<void> {
  await getPrismaClient().appSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ntfyGlobal },
    update: { ntfyGlobal },
  });
}

async function dispatch() {
  const { dispatchNotification } =
    await import("@/lib/notifications/dispatcher");
  return dispatchNotification({
    userId: TEST_USER_ID,
    eventType: "MEASUREMENT_REMINDER",
    title: "Time to weigh in",
    message: "Your morning reading is due",
  });
}

/**
 * The ledger write is fire-and-forget, so the row appears some time after the
 * dispatch returns. This used to wait a flat 50 ms, which is enough on a warm
 * machine and not enough on a cold container: the suite failed here once with
 * an empty ledger while nothing about the dispatch had changed. It waits for
 * the rows instead, and gives up loudly rather than letting the assertion
 * below report the absence as a product defect.
 */
async function settleLedger(expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const seen = await getPrismaClient().pushAttempt.count({
      where: { userId: TEST_USER_ID },
    });
    if (seen >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(
        `the delivery ledger still holds ${seen} of ${expected} rows after five seconds`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "global-channel-switch",
      email: "global-channel-switch@example.test",
    },
  });
});

describe("instance-wide notification channel switch", () => {
  it("delivers nothing and records the skip when the operator switched ntfy off", async () => {
    await seedNtfyChannel();
    await setNtfyGlobal(false);

    const outcome = await dispatch();
    await settleLedger(1);

    expect(ntfySendMock).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      dispatched: false,
      channelsAttempted: 0,
      channelsSucceeded: 0,
    });

    const attempts = await getPrismaClient().pushAttempt.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      channel: "NTFY",
      eventType: "MEASUREMENT_REMINDER",
      result: "skipped",
      reason: "globally_disabled",
    });

    // The switch is the operator's, not the user's: the account's own
    // channel row is left enabled so flipping the switch back restores
    // delivery without every user having to re-enable anything.
    const channel = await getPrismaClient().notificationChannel.findFirst({
      where: { userId: TEST_USER_ID, type: "NTFY" },
    });
    expect(channel?.enabled).toBe(true);
  });

  it("delivers on the same channel once the switch is back on", async () => {
    await seedNtfyChannel();
    await setNtfyGlobal(true);
    ntfySendMock.mockResolvedValueOnce({ ok: true });

    const outcome = await dispatch();

    expect(ntfySendMock).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      dispatched: true,
      channelsAttempted: 1,
      channelsSucceeded: 1,
    });
  });

  it("delivers when no settings row exists at all", async () => {
    await seedNtfyChannel();
    ntfySendMock.mockResolvedValueOnce({ ok: true });

    const outcome = await dispatch();

    expect(ntfySendMock).toHaveBeenCalledTimes(1);
    expect(outcome.dispatched).toBe(true);
  });
});
