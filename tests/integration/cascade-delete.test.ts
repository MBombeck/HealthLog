/**
 * Integration regression guard for the GDPR Art. 17 erasure path.
 *
 * Deleting a user must wipe every personal-data row that references
 * them. The schema declares `onDelete: Cascade` for personal data and
 * `onDelete: SetNull` for audit-style rows (AuditLog, Feedback). This
 * test verifies the actual database FKs match those declarations — a
 * missing CASCADE would leave orphan rows behind, violating GDPR.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("user.delete cascades to all personal-data tables", () => {
  it("removes every personal-data row when the user is deleted", async () => {
    const prisma = getPrismaClient();

    const user = await prisma.user.create({
      data: {
        username: "erasure-target",
        email: "erasure@example.test",
      },
    });

    // Seed personal data across every cascading relation.
    await prisma.session.create({
      data: {
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await prisma.passkey.create({
      data: {
        userId: user.id,
        credentialId: "cred-1",
        credentialPublicKey: Buffer.from("pubkey"),
        counter: BigInt(0),
        credentialDeviceType: "singleDevice",
        transports: ["internal"],
      },
    });

    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date(),
      },
    });

    const med = await prisma.medication.create({
      data: { userId: user.id, name: "Aspirin", dose: "100mg" },
    });

    await prisma.medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: med.id,
        scheduledFor: new Date(),
      },
    });

    await prisma.moodEntry.create({
      data: {
        userId: user.id,
        date: "2026-05-08",
        mood: "GUT",
        score: 4,
        moodLoggedAt: new Date(),
      },
    });

    await prisma.apiToken.create({
      data: {
        userId: user.id,
        name: "test-token",
        tokenHash: "hash-" + user.id,
      },
    });

    await prisma.dataBackup.create({
      data: { userId: user.id, type: "MANUAL", data: "{}" },
    });

    await prisma.userAchievement.create({
      data: {
        userId: user.id,
        achievementId: "first-login",
        unlockedAt: new Date(),
      },
    });

    await prisma.idempotencyKey.create({
      data: {
        userId: user.id,
        key: "abcdef12345678",
        method: "POST",
        path: "/api/test",
        responseStatus: 200,
        responseBody: "{}",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await prisma.device.create({
      data: {
        userId: user.id,
        platform: "ios",
        token: "apns-token-" + user.id,
        bundleId: "app.healthlog.ios",
      },
    });

    await prisma.pushSubscription.create({
      data: {
        userId: user.id,
        endpoint: "https://push.example/sub-" + user.id,
        p256dh: "p256dh",
        auth: "auth",
      },
    });

    // Audit logs / feedback are intentionally SetNull, not Cascade —
    // they survive deletion with a null userId for compliance triage.
    const auditRow = await prisma.auditLog.create({
      data: { userId: user.id, action: "auth.login" },
    });
    const feedbackRow = await prisma.feedback.create({
      data: {
        userId: user.id,
        category: "BUG",
        subject: "test",
        description: "test",
      },
    });

    // ── act ──
    await prisma.user.delete({ where: { id: user.id } });

    // ── assert: every cascading table is empty for that user id ──
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.passkey.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.measurement.count({ where: { userId: user.id } })).toBe(
      0,
    );
    expect(await prisma.medication.count({ where: { userId: user.id } })).toBe(
      0,
    );
    expect(
      await prisma.medicationIntakeEvent.count({
        where: { userId: user.id },
      }),
    ).toBe(0);
    expect(await prisma.moodEntry.count({ where: { userId: user.id } })).toBe(
      0,
    );
    expect(await prisma.apiToken.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.dataBackup.count({ where: { userId: user.id } })).toBe(
      0,
    );
    expect(
      await prisma.userAchievement.count({ where: { userId: user.id } }),
    ).toBe(0);
    expect(
      await prisma.idempotencyKey.count({ where: { userId: user.id } }),
    ).toBe(0);
    expect(await prisma.device.count({ where: { userId: user.id } })).toBe(0);
    expect(
      await prisma.pushSubscription.count({ where: { userId: user.id } }),
    ).toBe(0);

    // SetNull rows survive but lose their userId.
    const auditAfter = await prisma.auditLog.findUnique({
      where: { id: auditRow.id },
    });
    expect(auditAfter?.userId).toBeNull();

    const feedbackAfter = await prisma.feedback.findUnique({
      where: { id: feedbackRow.id },
    });
    expect(feedbackAfter?.userId).toBeNull();
  });
});
