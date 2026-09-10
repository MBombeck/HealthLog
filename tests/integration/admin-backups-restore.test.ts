/**
 * Integration test for `POST /api/admin/backups/[id]/restore`.
 *
 * Round-trip:
 *   1. Seed a user with measurements + medications + intake events +
 *      mood entries + notification channel + push subscription.
 *   2. Snapshot the data into a `DataBackup` row using the same shape
 *      the worker writes.
 *   3. Mutate the user's data (delete some, add others, change some).
 *   4. Call the restore endpoint with `confirm: "RESTORE"`.
 *   5. Assert the user's state matches the original snapshot.
 *
 * Plus negative paths:
 *   - 422 when `confirm` is missing.
 *   - 404 when the backup id is unknown.
 *   - the singleton `app_settings` row stays where it is unless the request
 *     asks for it: restoring one account is not a reason to reconfigure the
 *     installation for everybody on it.
 *   - audit-log entries for start, success, denial.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function seedAdminSession() {
  const prisma = getPrismaClient();
  const admin = await prisma.user.create({
    data: {
      username: "restore-admin",
      email: "restore-admin@example.test",
      role: "ADMIN",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: admin.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return admin;
}

function makeRequest(id: string, body: Record<string, unknown>) {
  return new Request(`http://localhost/api/admin/backups/${id}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/backups/[id]/restore", () => {
  it("replaces current user data with the snapshot contents", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();

    // ── arrange: build a backup of the admin's intended "good" state ──
    const payload = {
      schemaVersion: "1",
      exportedAt: "2026-05-09T10:00:00.000Z",
      userId: admin.id,
      measurements: [
        {
          type: "WEIGHT",
          value: 80.5,
          unit: "kg",
          measuredAt: "2026-05-08T07:00:00.000Z",
          source: "MANUAL",
          notes: "private legacy note",
          notesEncrypted: null,
        },
        {
          type: "PULSE",
          value: 64,
          unit: "bpm",
          measuredAt: "2026-05-08T07:01:00.000Z",
          source: "MANUAL",
          notes: null,
        },
      ],
      medications: [
        {
          name: "Ramipril",
          dose: "5mg",
          active: true,
          schedules: [
            {
              windowStart: "08:00",
              windowEnd: "10:00",
              label: "Morning",
              dose: null,
            },
          ],
        },
      ],
      intakeEvents: [
        {
          medication: "Ramipril",
          scheduledFor: "2026-05-08T08:00:00.000Z",
          takenAt: "2026-05-08T08:05:00.000Z",
          skipped: false,
          source: "WEB",
        },
      ],
      moodEntries: [
        {
          date: "2026-05-08",
          mood: "GUT",
          score: 4,
          tags: null,
          source: "MOODLOG",
          loggedAt: "2026-05-08T20:00:00.000Z",
        },
      ],
    };
    const backup = await prisma.dataBackup.create({
      data: {
        userId: admin.id,
        type: "MANUAL_UPLOAD_RESTORE_TEST",
        data: encrypt(JSON.stringify(payload)),
      },
    });

    // ── seed *different* current state that should be wiped ──
    await prisma.measurement.create({
      data: {
        userId: admin.id,
        type: "WEIGHT",
        value: 99.9,
        unit: "kg",
        measuredAt: new Date("2026-05-01T07:00:00.000Z"),
        source: "MANUAL",
      },
    });
    const oldMed = await prisma.medication.create({
      data: {
        userId: admin.id,
        name: "Ibuprofen",
        dose: "200mg",
        schedules: {
          create: { windowStart: "12:00", windowEnd: "13:00" },
        },
      },
    });
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: admin.id,
        medicationId: oldMed.id,
        scheduledFor: new Date("2026-05-01T12:00:00.000Z"),
      },
    });
    await prisma.moodEntry.create({
      data: {
        userId: admin.id,
        date: "2026-05-01",
        mood: "OKAY",
        score: 3,
        moodLoggedAt: new Date("2026-05-01T20:00:00.000Z"),
      },
    });
    await prisma.notificationChannel.create({
      data: { userId: admin.id, type: "TELEGRAM", config: "encrypted:test" },
    });
    await prisma.pushSubscription.create({
      data: {
        userId: admin.id,
        endpoint: "https://push.example/abc",
        p256dh: "p",
        auth: "a",
      },
    });

    // ── act: restore ──
    const { POST } = await import("@/app/api/admin/backups/[id]/restore/route");
    const req = makeRequest(backup.id, { confirm: "RESTORE" });
    const res = await POST(req as unknown as Parameters<typeof POST>[0], {
      params: Promise.resolve({ id: backup.id }),
    });

    expect(res.status).toBe(200);

    // ── assert: state matches the snapshot ──
    const measurements = await prisma.measurement.findMany({
      where: { userId: admin.id },
      orderBy: { measuredAt: "asc" },
    });
    expect(measurements).toHaveLength(2);
    expect(measurements[0]!.type).toBe("WEIGHT");
    expect(measurements[0]!.value).toBe(80.5);
    expect(measurements[1]!.type).toBe("PULSE");
    expect(measurements[0]!.notes).toBeNull();
    expect(measurements[0]!.notesEncrypted).not.toBeNull();

    const medications = await prisma.medication.findMany({
      where: { userId: admin.id },
    });
    expect(medications).toHaveLength(1);
    expect(medications[0]!.name).toBe("Ramipril");
    // Schedules: query with only the columns the deployed migrations
    // know about. (A sibling branch added `days_of_week` to the schema
    // without a matching migration; selecting `*` from the model in
    // the test DB would 500 on the missing column. Round-tripping the
    // window fields is enough to prove the restore wired schedules to
    // the right parent.)
    const schedules = await prisma.medicationSchedule.findMany({
      where: { medicationId: medications[0]!.id },
      select: { windowStart: true, windowEnd: true, label: true },
    });
    expect(schedules).toHaveLength(1);
    expect(schedules[0]!.windowStart).toBe("08:00");
    expect(schedules[0]!.label).toBe("Morning");

    const intake = await prisma.medicationIntakeEvent.findMany({
      where: { userId: admin.id },
    });
    expect(intake).toHaveLength(1);
    expect(intake[0]!.medicationId).toBe(medications[0]!.id);

    const moods = await prisma.moodEntry.findMany({
      where: { userId: admin.id },
    });
    expect(moods).toHaveLength(1);
    expect(moods[0]!.mood).toBe("GUT");
    expect(moods[0]!.score).toBe(4);

    const channels = await prisma.notificationChannel.count({
      where: { userId: admin.id },
    });
    expect(channels).toBe(0);
    const subs = await prisma.pushSubscription.count({
      where: { userId: admin.id },
    });
    expect(subs).toBe(0);

    // ── assert: audit trail captures start + success ──
    const start = await prisma.auditLog.count({
      where: { action: "admin.backups.restore.start", userId: admin.id },
    });
    expect(start).toBe(1);
    const success = await prisma.auditLog.count({
      where: { action: "admin.backups.restore", userId: admin.id },
    });
    expect(success).toBe(1);
  });

  it("rejects a request without `confirm: 'RESTORE'` and audits the denial", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();

    const backup = await prisma.dataBackup.create({
      data: {
        userId: admin.id,
        type: "MANUAL_UPLOAD_DENY_TEST",
        data: encrypt(
          JSON.stringify({
            schemaVersion: "1",
            exportedAt: "2026-05-09T00:00:00.000Z",
            userId: admin.id,
            measurements: [],
            medications: [],
            intakeEvents: [],
            moodEntries: [],
          }),
        ),
      },
    });

    const { POST } = await import("@/app/api/admin/backups/[id]/restore/route");
    const req = makeRequest(backup.id, { confirm: "yes" });
    const res = await POST(req as unknown as Parameters<typeof POST>[0], {
      params: Promise.resolve({ id: backup.id }),
    });

    expect(res.status).toBe(422);
    const error = (await res.json()) as { error: string };
    expect(error.error).toMatch(/confirm: 'RESTORE'/);
    const denied = await prisma.auditLog.count({
      where: {
        action: "admin.backups.restore.denied",
        userId: admin.id,
      },
    });
    expect(denied).toBe(1);
  });

  it("leaves the instance settings alone unless the restore asks for them", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();

    // What the host is configured to do today.
    const live = await prisma.appSettings.create({
      data: {
        id: "singleton",
        registrationEnabled: false,
        documentMaxFileBytes: 1_048_576,
      },
    });

    // What the file says, which is the other answer to both.
    const backup = await prisma.dataBackup.create({
      data: {
        userId: admin.id,
        type: "MANUAL_UPLOAD_SETTINGS_TEST",
        data: encrypt(
          JSON.stringify({
            schemaVersion: "1",
            exportedAt: "2026-05-09T00:00:00.000Z",
            userId: admin.id,
            measurements: [],
            medications: [],
            intakeEvents: [],
            moodEntries: [],
            appSettings: {
              ...live,
              documentQuotaBytes: String(live.documentQuotaBytes),
              registrationEnabled: true,
              documentMaxFileBytes: 4 * 1_048_576,
            },
          }),
        ),
      },
    });

    const { POST } = await import("@/app/api/admin/backups/[id]/restore/route");
    const restore = (body: Record<string, unknown>) =>
      POST(
        makeRequest(backup.id, body) as unknown as Parameters<typeof POST>[0],
        { params: Promise.resolve({ id: backup.id }) },
      );

    // The default answer: this account's data, and nobody else's settings.
    expect((await restore({ confirm: "RESTORE" })).status).toBe(200);
    const untouched = await prisma.appSettings.findUniqueOrThrow({
      where: { id: "singleton" },
    });
    expect(untouched.registrationEnabled).toBe(false);
    expect(untouched.documentMaxFileBytes).toBe(1_048_576);

    // And the second decision, when the operator makes it.
    expect(
      (await restore({ confirm: "RESTORE", restoreInstanceSettings: true }))
        .status,
    ).toBe(200);
    const rewritten = await prisma.appSettings.findUniqueOrThrow({
      where: { id: "singleton" },
    });
    expect(rewritten.registrationEnabled).toBe(true);
    expect(rewritten.documentMaxFileBytes).toBe(4 * 1_048_576);
  });

  it("returns 404 when the backup id is unknown", async () => {
    const admin = await seedAdminSession();
    void admin;

    const { POST } = await import("@/app/api/admin/backups/[id]/restore/route");
    const req = makeRequest("does-not-exist", { confirm: "RESTORE" });
    const res = await POST(req as unknown as Parameters<typeof POST>[0], {
      params: Promise.resolve({ id: "does-not-exist" }),
    });

    expect(res.status).toBe(404);
  });
});
