import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  claimManagedGuardianEgressAuthorization,
  resolveNotificationDeliveryIdentity,
} from "@/lib/notifications/delivery-identity";
import { claimNotificationEvent } from "@/lib/notifications/reminder-dedup";
import { recordPushAttempt } from "@/lib/notifications/senders/push-attempt-record";

let sequence = 0;

async function createUser(label: string, managed = false) {
  const suffix = sequence++;
  return getPrismaClient().user.create({
    data: {
      username: `${label}-${suffix}`,
      email: `${label}-${suffix}@example.test`,
      managedProfileAt: managed ? new Date() : null,
    },
  });
}

async function createGuardianGrant(input: {
  recordUserId: string;
  recipientUserId: string;
  access?: "READ" | "WRITE" | "MANAGE";
  acceptedAt?: Date | null;
  revokedAt?: Date | null;
  expiresAt?: Date | null;
}) {
  return getPrismaClient().accountGrant.create({
    data: {
      grantorId: input.recordUserId,
      granteeId: input.recipientUserId,
      access: input.access ?? "MANAGE",
      acceptedAt:
        input.acceptedAt === undefined ? new Date() : input.acceptedAt,
      revokedAt: input.revokedAt ?? null,
      revokedBy: input.revokedAt ? "GRANTOR" : null,
      expiresAt: input.expiresAt ?? null,
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("notification attribution (real Postgres)", () => {
  it("persistence retains distinct record and recipient principals", async () => {
    const recordUser = await createUser("record", true);
    const recipientUser = await createUser("recipient");

    recordPushAttempt({
      recordUserId: recordUser.id,
      recipientUserId: recipientUser.id,
      channel: "NTFY",
      eventType: "MEDICATION_REMINDER",
      result: "ok",
    });

    await vi.waitFor(async () => {
      const attempt = await getPrismaClient().pushAttempt.findFirstOrThrow({
        where: {
          recordUserId: recordUser.id,
          recipientUserId: recipientUser.id,
        },
        select: {
          recordUserId: true,
          recipientUserId: true,
          channel: true,
          eventType: true,
        },
      });

      expect(attempt).toEqual({
        recordUserId: recordUser.id,
        recipientUserId: recipientUser.id,
        channel: "NTFY",
        eventType: "MEDICATION_REMINDER",
      });
    });
  });

  it("persistence leaves explicit self attribution unchanged", async () => {
    const self = await createUser("self");

    const attempt = await getPrismaClient().pushAttempt.create({
      data: {
        userId: self.id,
        recordUserId: self.id,
        recipientUserId: self.id,
        channel: "NTFY",
        eventType: "MEDICATION_REMINDER",
        result: "ok",
      },
      select: {
        userId: true,
        recordUserId: true,
        recipientUserId: true,
      },
    });

    expect(attempt).toEqual({
      userId: self.id,
      recordUserId: self.id,
      recipientUserId: self.id,
    });
  });

  it("persists a managed reminder anchor as a record event without a delivery attempt", async () => {
    const recordUser = await createUser("managed-record", true);
    const client = getPrismaClient();
    const now = new Date();

    await expect(
      claimNotificationEvent(client, {
        recordUserId: recordUser.id,
        eventType: "MEDICATION_REMINDER",
        dedupKey: "med:slot",
        since: new Date(now.getTime() - 48 * 60 * 60 * 1000),
      }),
    ).resolves.toBe(true);
    await expect(
      claimNotificationEvent(client, {
        recordUserId: recordUser.id,
        eventType: "MEDICATION_REMINDER",
        dedupKey: "med:slot",
        since: new Date(now.getTime() - 48 * 60 * 60 * 1000),
      }),
    ).resolves.toBe(false);

    const event = await client.notificationEvent.findFirstOrThrow({
      where: { recordUserId: recordUser.id, dedupKey: "med:slot" },
      select: { id: true },
    });
    expect(await client.pushAttempt.count()).toBe(0);
    await client.user.delete({ where: { id: recordUser.id } });
    expect(
      await client.notificationEvent.findUnique({ where: { id: event.id } }),
    ).toBeNull();
  });

  it("provides the created-at index used by global notification event retention", async () => {
    const indexes = await getPrismaClient().$queryRaw<
      Array<{ indexname: string }>
    >`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'notification_events'
    `;

    expect(indexes.map(({ indexname }) => indexname)).toContain(
      "notification_events_created_at_idx",
    );
  });

  it("refuses a revoked Guardian after identity preflight but before the final egress claim", async () => {
    const recordUser = await createUser("expiry-record", true);
    const recipientUser = await createUser("expiry-recipient");
    const grant = await createGuardianGrant({
      recordUserId: recordUser.id,
      recipientUserId: recipientUser.id,
    });
    const delivery = await resolveNotificationDeliveryIdentity({
      eventType: "MEDICATION_REMINDER",
      userId: recordUser.id,
      recordUserId: recordUser.id,
      recipientUserId: recipientUser.id,
      title: "record reminder",
      message: "record message",
    });
    expect(delivery).toMatchObject({ managed: true });

    await getPrismaClient().accountGrant.update({
      where: { id: grant.id },
      data: { revokedAt: new Date(), revokedBy: "GRANTOR" },
    });

    await expect(
      claimManagedGuardianEgressAuthorization(
        delivery!,
        "NTFY",
        "MEDICATION_REMINDER",
      ),
    ).resolves.toBeNull();
    expect(
      await getPrismaClient().notificationEgressAuthorization.count(),
    ).toBe(0);
    expect(await getPrismaClient().pushAttempt.count()).toBe(0);
  });

  it("refuses an expired Guardian after identity preflight but before the final egress claim", async () => {
    const recordUser = await createUser("expiry-record", true);
    const recipientUser = await createUser("expiry-recipient");
    const grant = await createGuardianGrant({
      recordUserId: recordUser.id,
      recipientUserId: recipientUser.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const delivery = await resolveNotificationDeliveryIdentity({
      eventType: "MEDICATION_REMINDER",
      userId: recordUser.id,
      recordUserId: recordUser.id,
      recipientUserId: recipientUser.id,
      title: "record reminder",
      message: "record message",
    });
    expect(delivery).toMatchObject({ managed: true });

    await getPrismaClient().accountGrant.update({
      where: { id: grant.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });

    await expect(
      claimManagedGuardianEgressAuthorization(
        delivery!,
        "NTFY",
        "MEDICATION_REMINDER",
      ),
    ).resolves.toBeNull();
    expect(
      await getPrismaClient().notificationEgressAuthorization.count(),
    ).toBe(0);
    expect(await getPrismaClient().pushAttempt.count()).toBe(0);
  });

  it("uses database time for expiry at the final egress claim", async () => {
    const recordUser = await createUser("database-clock-record", true);
    const recipientUser = await createUser("database-clock-recipient");
    const actualNow = Date.now();
    await createGuardianGrant({
      recordUserId: recordUser.id,
      recipientUserId: recipientUser.id,
      expiresAt: new Date(actualNow - 1_000),
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(actualNow - 60_000));
    try {
      const delivery = await resolveNotificationDeliveryIdentity({
        eventType: "MEDICATION_REMINDER",
        userId: recordUser.id,
        recordUserId: recordUser.id,
        recipientUserId: recipientUser.id,
        title: "record reminder",
        message: "record message",
      });
      expect(delivery).toMatchObject({ managed: true });

      await expect(
        claimManagedGuardianEgressAuthorization(
          delivery!,
          "NTFY",
          "MEDICATION_REMINDER",
        ),
      ).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }

    expect(
      await getPrismaClient().notificationEgressAuthorization.count(),
    ).toBe(0);
    expect(await getPrismaClient().pushAttempt.count()).toBe(0);
  });

  it("allows exactly one concurrent claim for a notification event", async () => {
    const recordUser = await createUser("claim-record", true);
    const client = getPrismaClient();
    const since = new Date(Date.now() - 60_000);
    const input = {
      recordUserId: recordUser.id,
      eventType: "MEDICATION_REMINDER",
      dedupKey: "med:race",
      since,
    };

    const results = await Promise.all([
      claimNotificationEvent(client, input),
      claimNotificationEvent(client, input),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await client.notificationEvent.count({
        where: {
          recordUserId: recordUser.id,
          eventType: "MEDICATION_REMINDER",
          dedupKey: "med:race",
        },
      }),
    ).toBe(1);
  });

  it("uses the rolling window and allows a retry after a failed claim", async () => {
    const client = getPrismaClient();
    const missingRecordId = `missing-claim-${sequence++}`;
    const missingInput = {
      recordUserId: missingRecordId,
      eventType: "SYSTEM_ALERT",
      dedupKey: "safety:retry",
      since: new Date(Date.now() - 24 * 60 * 60 * 1000),
    };

    await expect(claimNotificationEvent(client, missingInput)).resolves.toBe(
      false,
    );
    await client.user.create({
      data: {
        id: missingRecordId,
        username: `claim-retry-${sequence++}`,
        email: `claim-retry-${sequence++}@example.test`,
      },
    });
    await expect(claimNotificationEvent(client, missingInput)).resolves.toBe(
      true,
    );

    const recordUser = await createUser("expired-claim", true);
    const now = new Date();
    await client.notificationEvent.create({
      data: {
        recordUserId: recordUser.id,
        eventType: "SYSTEM_ALERT",
        dedupKey: "safety:window",
        createdAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
      },
    });

    await expect(
      claimNotificationEvent(client, {
        recordUserId: recordUser.id,
        eventType: "SYSTEM_ALERT",
        dedupKey: "safety:window",
        since: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      }),
    ).resolves.toBe(true);
  });

  it("keeps Telegram reminder tracking independent for each recipient slot", async () => {
    const recordUser = await createUser("telegram-record", true);
    const firstRecipient = await createUser("telegram-recipient-a");
    const secondRecipient = await createUser("telegram-recipient-b");
    const client = getPrismaClient();
    const medication = await client.medication.create({
      data: {
        userId: recordUser.id,
        name: "Tracking medication",
        dose: "1 tablet",
        schedules: {
          create: { windowStart: "08:00", windowEnd: "08:00" },
        },
      },
      include: { schedules: true },
    });
    const scheduleId = medication.schedules[0]!.id;
    const slot = {
      medicationId: medication.id,
      scheduleId,
      date: "2026-08-06",
      phase: "YELLOW" as const,
      timeOfDay: "08:00",
    };

    await client.telegramReminderMessage.createMany({
      data: [
        {
          recipientUserId: firstRecipient.id,
          ...slot,
          chatId: "first-chat",
          messageId: 101,
        },
        {
          recipientUserId: secondRecipient.id,
          ...slot,
          chatId: "second-chat",
          messageId: 202,
        },
      ],
    });

    await client.telegramReminderMessage.upsert({
      where: {
        recipientUserId_medicationId_scheduleId_date_phase_timeOfDay: {
          recipientUserId: firstRecipient.id,
          ...slot,
        },
      },
      create: {
        recipientUserId: firstRecipient.id,
        ...slot,
        chatId: "unused-create-chat",
        messageId: 303,
      },
      update: { chatId: "first-chat-new", messageId: 303 },
    });

    expect(
      await client.telegramReminderMessage.findMany({
        where: { medicationId: medication.id },
        orderBy: { recipientUserId: "asc" },
        select: { recipientUserId: true, chatId: true, messageId: true },
      }),
    ).toEqual([
      {
        recipientUserId: firstRecipient.id,
        chatId: "first-chat-new",
        messageId: 303,
      },
      {
        recipientUserId: secondRecipient.id,
        chatId: "second-chat",
        messageId: 202,
      },
    ]);

    await client.user.delete({ where: { id: firstRecipient.id } });
    expect(
      await client.telegramReminderMessage.count({
        where: { medicationId: medication.id },
      }),
    ).toBe(1);
  });

  it("persistence maps an omitted pair from the legacy recipient", async () => {
    const self = await createUser("legacy");

    // The app always names both principals, so the schema requires them; a
    // writer that names only user_id is a raw insert, which the trigger maps.
    const [attempt] = await getPrismaClient().$queryRaw<
      Array<{ recordUserId: string; recipientUserId: string }>
    >`
      INSERT INTO push_attempts (id, user_id, channel, event_type, result)
      VALUES (${`legacy-${self.id}`}, ${self.id}, 'NTFY', 'MEDICATION_REMINDER', 'ok')
      RETURNING record_user_id AS "recordUserId", recipient_user_id AS "recipientUserId"
    `;

    expect(attempt).toEqual({
      recordUserId: self.id,
      recipientUserId: self.id,
    });
  });

  it("persistence rejects a partial or contradictory principal pair atomically", async () => {
    const recordUser = await createUser("record", true);
    const recipientUser = await createUser("recipient");
    const otherUser = await createUser("other");

    await expect(
      getPrismaClient().$executeRaw`
        INSERT INTO push_attempts (id, user_id, record_user_id, channel, event_type, result)
        VALUES ('partial-pair', ${recipientUser.id}, ${recordUser.id}, 'NTFY', 'MEDICATION_REMINDER', 'ok')
      `,
    ).rejects.toThrow("push attempt attribution requires both principals");

    await expect(
      getPrismaClient().pushAttempt.create({
        data: {
          userId: otherUser.id,
          recordUserId: recordUser.id,
          recipientUserId: recipientUser.id,
          channel: "NTFY",
          eventType: "MEDICATION_REMINDER",
          result: "ok",
        },
      }),
    ).rejects.toThrow("push attempt recipient must match user_id");

    expect(await getPrismaClient().pushAttempt.count()).toBe(0);
  });

  it("persistence refuses a managed recipient and cascades an attributed recipient deletion", async () => {
    const recordUser = await createUser("record", true);
    const recipientUser = await createUser("recipient");
    const managedRecipient = await createUser("managed-recipient", true);

    await expect(
      getPrismaClient().pushAttempt.create({
        data: {
          userId: managedRecipient.id,
          recordUserId: recordUser.id,
          recipientUserId: managedRecipient.id,
          channel: "NTFY",
          eventType: "MEDICATION_REMINDER",
          result: "ok",
        },
      }),
    ).rejects.toThrow("managed profile cannot receive notification delivery");

    const attempt = await getPrismaClient().pushAttempt.create({
      data: {
        userId: recipientUser.id,
        recordUserId: recordUser.id,
        recipientUserId: recipientUser.id,
        channel: "NTFY",
        eventType: "MEDICATION_REMINDER",
        result: "ok",
      },
    });
    await getPrismaClient().user.delete({ where: { id: recipientUser.id } });

    expect(
      await getPrismaClient().pushAttempt.findUnique({
        where: { id: attempt.id },
      }),
    ).toBeNull();
  });

  it("principal resolution requires an active MANAGE grant for managed delivery", async () => {
    const recordUser = await createUser("record", true);
    const recipientUser = await createUser("recipient");
    const ordinaryRecord = await createUser("ordinary");

    await expect(
      resolveNotificationDeliveryIdentity({
        eventType: "MEDICATION_REMINDER",
        userId: recordUser.id,
        recordUserId: recordUser.id,
        recipientUserId: recipientUser.id,
        title: "Record content",
        message: "Record schedule",
      }),
    ).resolves.toBeNull();

    await createGuardianGrant({
      recordUserId: recordUser.id,
      recipientUserId: recipientUser.id,
    });

    await expect(
      resolveNotificationDeliveryIdentity({
        eventType: "MEDICATION_REMINDER",
        userId: recordUser.id,
        recordUserId: recordUser.id,
        recipientUserId: recipientUser.id,
        title: "Record content",
        message: "Record schedule",
      }),
    ).resolves.toEqual({
      recordUserId: recordUser.id,
      recipientUserId: recipientUser.id,
      managed: true,
    });

    await expect(
      resolveNotificationDeliveryIdentity({
        eventType: "MEDICATION_REMINDER",
        userId: recordUser.id,
        title: "Record content",
        message: "Record schedule",
      }),
    ).resolves.toBeNull();

    await expect(
      resolveNotificationDeliveryIdentity({
        eventType: "MEDICATION_REMINDER",
        userId: ordinaryRecord.id,
        recordUserId: ordinaryRecord.id,
        recipientUserId: recipientUser.id,
        title: "Record content",
        message: "Record schedule",
      }),
    ).resolves.toBeNull();
  });

  it("principal resolution rejects inactive, insufficient, wrong-record, and managed-recipient grants", async () => {
    const recordUser = await createUser("record", true);
    const otherRecord = await createUser("other-record", true);
    const pendingRecipient = await createUser("pending-recipient");
    const revokedRecipient = await createUser("revoked-recipient");
    const expiredRecipient = await createUser("expired-recipient");
    const writeRecipient = await createUser("write-recipient");
    const wrongRecordRecipient = await createUser("wrong-record-recipient");
    const managedRecipient = await createUser("managed-recipient", true);

    await Promise.all([
      createGuardianGrant({
        recordUserId: recordUser.id,
        recipientUserId: pendingRecipient.id,
        acceptedAt: null,
      }),
      createGuardianGrant({
        recordUserId: recordUser.id,
        recipientUserId: revokedRecipient.id,
        revokedAt: new Date(),
      }),
      createGuardianGrant({
        recordUserId: recordUser.id,
        recipientUserId: expiredRecipient.id,
        expiresAt: new Date(Date.now() - 1_000),
      }),
      createGuardianGrant({
        recordUserId: recordUser.id,
        recipientUserId: writeRecipient.id,
        access: "WRITE",
      }),
      createGuardianGrant({
        recordUserId: otherRecord.id,
        recipientUserId: wrongRecordRecipient.id,
      }),
      createGuardianGrant({
        recordUserId: recordUser.id,
        recipientUserId: managedRecipient.id,
      }),
    ]);

    for (const recipientUserId of [
      pendingRecipient.id,
      revokedRecipient.id,
      expiredRecipient.id,
      writeRecipient.id,
      wrongRecordRecipient.id,
      managedRecipient.id,
    ]) {
      await expect(
        resolveNotificationDeliveryIdentity({
          eventType: "MEDICATION_REMINDER",
          userId: recordUser.id,
          recordUserId: recordUser.id,
          recipientUserId,
          title: "Record content",
          message: "Record schedule",
        }),
      ).resolves.toBeNull();
    }

    const ordinaryUser = await createUser("ordinary-self");
    await expect(
      resolveNotificationDeliveryIdentity({
        eventType: "MEDICATION_REMINDER",
        userId: ordinaryUser.id,
        title: "Personal content",
        message: "Personal schedule",
      }),
    ).resolves.toEqual({
      recordUserId: ordinaryUser.id,
      recipientUserId: ordinaryUser.id,
      managed: false,
    });
  });
});
