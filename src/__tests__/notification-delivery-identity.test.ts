import { beforeEach, describe, expect, it, vi } from "vitest";

const transactionMock = vi.fn();
const authorizationClaimQueryMock = vi.fn();
const authorizationUpdateMock = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    notificationChannel: {
      findMany: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    user: { findUnique: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    accountGrant: { findMany: vi.fn() },
    notificationEgressAuthorization: {
      update: (...args: unknown[]) => authorizationUpdateMock(...args),
    },
    auditLog: { create: vi.fn() },
    $transaction: (...args: unknown[]) => transactionMock(...args),
  },
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: (value: string) => value,
  encrypt: (value: string) => value,
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({
    addWarning: vi.fn(),
    addMeta: vi.fn(),
  }),
}));

const sendViaWebPushMock = vi.fn();
const sendViaNtfyMock = vi.fn();
const sendViaApnsMock = vi.fn();

vi.mock("@/lib/notifications/senders/apns", () => ({
  sendViaApns: (...args: unknown[]) => sendViaApnsMock(...args),
}));
vi.mock("@/lib/notifications/senders/email", () => ({
  sendViaEmail: vi.fn(),
}));
vi.mock("@/lib/notifications/senders/ntfy", () => ({
  sendViaNtfy: (...args: unknown[]) => sendViaNtfyMock(...args),
}));
vi.mock("@/lib/notifications/senders/telegram", () => ({
  sendViaTelegram: vi.fn(),
}));
vi.mock("@/lib/notifications/senders/web-push", () => ({
  sendViaWebPush: (...args: unknown[]) => sendViaWebPushMock(...args),
}));
vi.mock("@/lib/notifications/senders/webhook", () => ({
  sendViaWebhook: vi.fn(),
}));
vi.mock("@/lib/notifications/senders/push-attempt-record", () => ({
  recordPushAttempt: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { dispatchNotification } from "@/lib/notifications/dispatcher";

const recordUserId = "managed-record";
const recipientUserId = "guardian-recipient";

beforeEach(() => {
  vi.resetAllMocks();
  authorizationClaimQueryMock.mockResolvedValue([{ id: "authorization" }]);
  authorizationUpdateMock.mockResolvedValue({ id: "authorization" });
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    managedProfileAt: new Date(),
  } as never);
  vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
    {
      id: "recipient-channel",
      userId: recipientUserId,
      type: "WEB_PUSH",
      config: "{}",
      nextRetryAt: null,
      preferences: [],
    },
  ] as never);
  vi.mocked(prisma.notificationChannel.update).mockResolvedValue({
    consecutiveFailures: 0,
  } as never);
  transactionMock.mockImplementation(
    async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        $queryRaw: (...args: unknown[]) => authorizationClaimQueryMock(...args),
        user: {
          findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
            where.id === recordUserId
              ? { managedProfileAt: new Date() }
              : { managedProfileAt: null },
          ),
        },
        accountGrant: { findFirst: vi.fn(async () => ({ id: "grant" })) },
      }),
  );
  sendViaWebPushMock.mockResolvedValue({ ok: true });
  sendViaNtfyMock.mockResolvedValue({ ok: true });
  sendViaApnsMock.mockResolvedValue({ ok: true });
});

describe("notification delivery identity", () => {
  it("principal resolution uses the recipient channel for a managed record", async () => {
    const outcome = await dispatchNotification({
      eventType: "MEDICATION_REMINDER",
      userId: recordUserId,
      recordUserId,
      recipientUserId,
      title: "Record content",
      message: "Record schedule",
    });

    expect(outcome).toEqual({
      dispatched: true,
      channelsAttempted: 1,
      channelsSucceeded: 1,
    });
    expect(prisma.notificationChannel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: recipientUserId, enabled: true },
      }),
    );
    expect(sendViaWebPushMock).toHaveBeenCalledWith(
      recipientUserId,
      expect.objectContaining({
        userId: recordUserId,
        recordUserId,
        recipientUserId,
        title: "Record content",
        message: "Record schedule",
      }),
    );
    // Preflight chooses recipient channels, then a short locked transaction
    // records the final authorization claim before provider I/O starts.
    expect(transactionMock).toHaveBeenCalledTimes(2);
    expect(transactionMock).toHaveBeenLastCalledWith(expect.any(Function));
    expect(authorizationClaimQueryMock).toHaveBeenCalledTimes(3);
    expect(authorizationUpdateMock).toHaveBeenCalledWith({
      where: { id: "authorization" },
      data: { completedAt: expect.any(Date), outcome: "ok" },
    });
  });

  it("does not invoke a provider when final Guardian authorization is revoked", async () => {
    let transactionCount = 0;
    transactionMock.mockImplementation(
      async (operation: (tx: unknown) => Promise<unknown>) => {
        transactionCount += 1;
        return operation({
          $queryRaw: (...args: unknown[]) =>
            authorizationClaimQueryMock(...args),
          user: {
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
              where.id === recordUserId
                ? { managedProfileAt: new Date() }
                : { managedProfileAt: null },
            ),
          },
          accountGrant: {
            findFirst: vi.fn(async () =>
              transactionCount === 1 ? { id: "grant" } : null,
            ),
          },
        });
      },
    );

    const outcome = await dispatchNotification({
      eventType: "MEDICATION_REMINDER",
      userId: recordUserId,
      recordUserId,
      recipientUserId,
      title: "Record content",
      message: "Record schedule",
    });

    expect(outcome).toEqual({
      dispatched: false,
      channelsAttempted: 0,
      channelsSucceeded: 0,
    });
    expect(authorizationClaimQueryMock).toHaveBeenCalledTimes(2);
    expect(sendViaWebPushMock).not.toHaveBeenCalled();
  });

  it("records a provider timeout on the claim without retaining the lifecycle lock", async () => {
    sendViaWebPushMock.mockRejectedValue(new Error("provider timeout"));

    const outcome = await dispatchNotification({
      eventType: "MEDICATION_REMINDER",
      userId: recordUserId,
      recordUserId,
      recipientUserId,
      title: "Record content",
      message: "Record schedule",
    });

    expect(outcome).toEqual({
      dispatched: false,
      channelsAttempted: 1,
      channelsSucceeded: 0,
    });
    expect(authorizationUpdateMock).toHaveBeenCalledWith({
      where: { id: "authorization" },
      data: { completedAt: expect.any(Date), outcome: "sender_threw" },
    });
  });

  it("refuses a managed record without an explicit recipient", async () => {
    const outcome = await dispatchNotification({
      eventType: "MEDICATION_REMINDER",
      userId: recordUserId,
      title: "Record content",
      message: "Record schedule",
    });

    expect(outcome).toEqual({
      dispatched: false,
      channelsAttempted: 0,
      channelsSucceeded: 0,
    });
    expect(prisma.notificationChannel.findMany).not.toHaveBeenCalled();
    expect(sendViaWebPushMock).not.toHaveBeenCalled();
  });

  it("uses the recipient preference without changing record content", async () => {
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      {
        id: "recipient-channel",
        userId: recipientUserId,
        type: "WEB_PUSH",
        config: "{}",
        nextRetryAt: null,
        preferences: [{ eventType: "MEDICATION_REMINDER", enabled: false }],
      },
    ] as never);

    const outcome = await dispatchNotification({
      eventType: "MEDICATION_REMINDER",
      userId: recordUserId,
      recordUserId,
      recipientUserId,
      title: "Record content",
      message: "Record schedule",
    });

    expect(outcome).toEqual({
      dispatched: false,
      channelsAttempted: 0,
      channelsSucceeded: 0,
    });
    expect(prisma.notificationChannel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: recipientUserId, enabled: true },
      }),
    );
    expect(sendViaWebPushMock).not.toHaveBeenCalled();
  });

  it("renders for each Guardian while isolating channel preferences", async () => {
    const firstGuardian = "guardian-en";
    const secondGuardian = "guardian-de";

    (
      prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === recordUserId) {
        return { managedProfileAt: new Date() } as never;
      }
      if (where.id === firstGuardian) {
        return {
          managedProfileAt: null,
          locale: "en",
          notificationPrefs: { medication: { clientManaged: true } },
        } as never;
      }
      return {
        managedProfileAt: null,
        locale: "de",
        notificationPrefs: { medication: { clientManaged: true } },
      } as never;
    });
    vi.mocked(prisma.accountGrant.findMany).mockResolvedValue([
      { granteeId: firstGuardian, grantee: { managedProfileAt: null } },
      { granteeId: secondGuardian, grantee: { managedProfileAt: null } },
    ] as never);
    (
      prisma.notificationChannel.findMany as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(async ({ where }: { where: { userId: string } }) => {
      if (where.userId === firstGuardian) {
        return [
          {
            id: "first-web-disabled",
            userId: firstGuardian,
            type: "WEB_PUSH",
            config: "{}",
            nextRetryAt: null,
            preferences: [{ eventType: "MEDICATION_REMINDER", enabled: false }],
          },
          {
            id: "first-ntfy-enabled",
            userId: firstGuardian,
            type: "NTFY",
            config: "{}",
            nextRetryAt: null,
            preferences: [],
          },
        ] as never;
      }
      return [
        {
          id: "second-web-enabled",
          userId: secondGuardian,
          type: "WEB_PUSH",
          config: "{}",
          nextRetryAt: null,
          preferences: [],
        },
        {
          id: "second-ntfy-disabled",
          userId: secondGuardian,
          type: "NTFY",
          config: "{}",
          nextRetryAt: null,
          preferences: [{ eventType: "MEDICATION_REMINDER", enabled: false }],
        },
      ] as never;
    });

    const outcome = await dispatchNotification({
      eventType: "MEDICATION_REMINDER",
      userId: recordUserId,
      title: "record-language-title",
      message: "record-language-message",
      renderForRecipient: (locale) => ({
        title: `title-${locale}`,
        message: `message-${locale}`,
      }),
    });

    expect(outcome).toEqual({
      dispatched: true,
      channelsAttempted: 2,
      channelsSucceeded: 2,
    });
    expect(sendViaNtfyMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        recipientUserId: firstGuardian,
        title: "title-en",
        message: "message-en",
      }),
    );
    expect(sendViaWebPushMock).toHaveBeenCalledWith(
      secondGuardian,
      expect.objectContaining({
        recipientUserId: secondGuardian,
        title: "title-de",
        message: "message-de",
      }),
    );
    expect(sendViaWebPushMock).toHaveBeenCalledTimes(1);
    expect(sendViaNtfyMock).toHaveBeenCalledTimes(1);
  });

  it("bypasses client-managed APNs suppression only for managed Guardian delivery", async () => {
    const guardian = "guardian-apns";
    (
      prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        (where.id === recordUserId
          ? { managedProfileAt: new Date() }
          : {
              managedProfileAt: null,
              notificationPrefs: { medication: { clientManaged: true } },
            }) as never,
    );
    vi.mocked(prisma.accountGrant.findMany).mockResolvedValue([
      { granteeId: guardian, grantee: { managedProfileAt: null } },
    ] as never);
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      {
        id: "guardian-apns",
        userId: guardian,
        type: "APNS",
        config: "{}",
        nextRetryAt: null,
        preferences: [],
      },
    ] as never);

    await expect(
      dispatchNotification({
        eventType: "MEDICATION_REMINDER",
        userId: recordUserId,
        title: "Record content",
        message: "Record schedule",
      }),
    ).resolves.toMatchObject({ dispatched: true, channelsSucceeded: 1 });

    expect(sendViaApnsMock).toHaveBeenCalledWith(
      guardian,
      expect.objectContaining({
        recordUserId,
        recipientUserId: guardian,
      }),
    );
  });
});
