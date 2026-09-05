import { Buffer } from "node:buffer";
import type { Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OFFHOST_ENCRYPTION_KEY =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
process.env.BACKUP_S3_ENDPOINT = "https://s3.example.test";
process.env.BACKUP_S3_BUCKET = "healthlog-test";
process.env.BACKUP_S3_ACCESS_KEY = "test-access";
process.env.BACKUP_S3_SECRET_KEY = "test-secret";
process.env.BACKUP_ENCRYPTION_KEY = OFFHOST_ENCRYPTION_KEY;

import { encrypt, encryptBytes } from "@/lib/crypto";
import { encryptToBytes, decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import {
  decryptBackup,
  runOffhostBackup,
  type S3Like,
} from "@/lib/jobs/offhost-backup";
import {
  backupPayloadSchema,
  parseBackupPayload,
} from "@/lib/validations/backup";
import { POST } from "@/app/api/admin/backups/[id]/restore/route";
import { invalidateUserData } from "@/lib/cache/invalidate";

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
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserData: vi.fn(),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  vi.mocked(invalidateUserData).mockClear();
});

async function seedAdminSession() {
  const prisma = getPrismaClient();
  const admin = await prisma.user.create({
    data: {
      username: "canonical-restore-admin",
      email: "canonical-restore-admin@example.test",
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

function makeRequest(id: string) {
  return new Request(`http://localhost/api/admin/backups/${id}/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "RESTORE" }),
  });
}

function makeS3Store(): S3Like & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    putStream: vi.fn(async (key: string, body: Readable) => {
      const chunks: Buffer[] = [];
      for await (const c of body) chunks.push(Buffer.from(c as Uint8Array));
      objects.set(key, Buffer.concat(chunks));
    }),
    putObject: vi.fn(async (key, body) => {
      objects.set(key, Buffer.from(body));
    }),
    getObject: vi.fn(async (key) => {
      const body = objects.get(key);
      if (!body) throw new Error(`Missing S3 object: ${key}`);
      return body;
    }),
    headObject: vi.fn(async (key) => objects.has(key)),
    listObjects: vi.fn(async (prefix) =>
      [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
    ),
    deleteObject: vi.fn(async (key) => {
      objects.delete(key);
    }),
  };
}

describe("canonical disaster-recovery backup round-trip", () => {
  it("restores an off-host payload with tombstones and encrypted documents", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();
    const ownerId = admin.id;
    const settings = await prisma.appSettings.create({
      data: {
        id: "singleton",
        registrationEnabled: false,
        mfaRequired: true,
        defaultLocale: "en",
        telegramGlobal: false,
        ntfyGlobal: false,
        webPushGlobal: false,
        webPushVapidPublicKey: "public-dr",
        webPushVapidPrivateKeyEncrypted: "private-dr",
        webPushVapidSubject: "mailto:dr@example.test",
        apiGlobal: false,
        umamiEnabled: true,
        umamiScriptUrl: "https://analytics.example.test/script.js",
        umamiWebsiteId: "website-dr",
        glitchtipEnabled: true,
        glitchtipDsn: "https://glitchtip.example.test/1",
        glitchtipEnvironment: "dr",
        reminderLateMinutes: 47,
        reminderMissedMinutes: 93,
        adminAiKeyEncrypted: "ai-key-dr",
        adminAiModel: "model-dr",
        adminAiBaseUrl: "https://ai.example.test/v1",
        adminCodexAccessTokenEncrypted: "access-dr",
        adminCodexRefreshTokenEncrypted: "refresh-dr",
        adminCodexAccountIdEncrypted: "account-dr",
        adminCodexTokenExpiresAt: new Date("2026-07-03T00:00:00.000Z"),
        adminCodexConnectedAt: new Date("2026-07-01T00:00:00.000Z"),
        adminCodexConnectionStatus: "connected",
        adminAiInsightsFeedbackSummary: { helpful: 8, total: 10 },
        defaultUserTimezone: "Europe/London",
        assistantEnabled: false,
        assistantCoachEnabled: false,
        assistantBriefingEnabled: false,
        assistantInsightStatusEnabled: false,
        assistantCorrelationsEnabled: false,
        moduleAvailabilityJson: { insights: true, nutrients: false },
        documentMaxFileBytes: 12_345_678,
        documentQuotaBytes: BigInt("9876543210"),
      },
    });

    const measurement = await prisma.measurement.create({
      data: {
        id: "measurement-dr",
        userId: ownerId,
        type: "WEIGHT",
        value: 72.4,
        unit: "kg",
        measuredAt: new Date("2026-07-01T07:00:00.000Z"),
        source: "MANUAL",
      },
    });
    const tombstoneDeletedAt = new Date("2026-07-01T12:00:00.000Z");
    const deletedMeasurement = await prisma.measurement.create({
      data: {
        id: "measurement-deleted-dr",
        userId: ownerId,
        type: "PULSE",
        value: 61,
        unit: "bpm",
        measuredAt: new Date("2026-07-01T08:00:00.000Z"),
        source: "MANUAL",
        deletedAt: tombstoneDeletedAt,
      },
    });

    const factorCategory = await prisma.moodTagCategory.create({
      data: {
        id: "category-dr",
        key: "dr_restore_factors",
        labelKey: "mood.tagCategory.drRestore",
      },
    });
    const factor = await prisma.moodTag.create({
      data: {
        id: "factor-dr",
        categoryId: factorCategory.id,
        key: "dr_sleep_quality",
        labelKey: "mood.tag.drSleepQuality",
        kind: "RATED",
        scaleMin: 1,
        scaleMax: 5,
      },
    });
    const mood = await prisma.moodEntry.create({
      data: {
        id: "mood-dr",
        userId: ownerId,
        date: "2026-07-01",
        mood: "GUT",
        score: 4,
        source: "MOODLOG",
        moodLoggedAt: new Date("2026-07-01T20:00:00.000Z"),
        tagLinks: {
          create: { moodTagId: factor.id, rating: 5 },
        },
      },
      include: {
        tagLinks: {
          select: { rating: true, moodTag: { select: { key: true } } },
        },
      },
    });
    const deletedMood = await prisma.moodEntry.create({
      data: {
        id: "mood-deleted-dr",
        userId: ownerId,
        date: "2026-06-30",
        mood: "OKAY",
        score: 3,
        source: "MOODLOG",
        moodLoggedAt: new Date("2026-06-30T20:00:00.000Z"),
        deletedAt: tombstoneDeletedAt,
      },
    });

    const medication = await prisma.medication.create({
      data: {
        id: "medication-dr",
        userId: ownerId,
        name: "Canonical medicine",
        dose: "2 mg",
        treatmentClass: "GENERIC",
        dosesPerUnit: 4,
        unitsPerDose: "0.5000",
        active: false,
        notificationsEnabled: false,
        pausedAt: new Date("2026-06-25T08:00:00.000Z"),
        snoozedUntil: new Date("2026-07-05T08:00:00.000Z"),
        startsOn: new Date("2026-06-01T00:00:00.000Z"),
        endsOn: new Date("2026-08-01T00:00:00.000Z"),
        asNeeded: false,
        deliveryForm: "INJECTION",
        trackInjectionSites: true,
        allowedInjectionSites: ["THIGH_LEFT", "THIGH_RIGHT"],
        liveActivityEnabled: true,
        criticalAlarmEnabled: true,
        atcCode: "A10BX10",
        rxNormCode: "12345",
        lowStockNotifiedAt: new Date("2026-06-26T08:00:00.000Z"),
        lowStockNotifiedThresholdDays: 7,
        reorderLeadDays: 3,
        externalSource: "APPLE_HEALTH",
        externalId: "medication-external-dr",
        schedules: {
          create: {
            id: "schedule-dr",
            windowStart: "08:00",
            windowEnd: "10:00",
            label: "Morning",
            dose: "1 mg",
            daysOfWeek: "i2;1,3,5",
            timesOfDay: ["08:00", "20:00"],
            reminderGraceMinutes: 90,
            rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR",
            scheduleType: "CYCLIC",
            cyclicOnWeeks: 3,
            cyclicOffWeeks: 1,
            doseWindows: [{ timeOfDay: "08:00", start: "07:30", end: "09:00" }],
          },
        },
      },
      include: { schedules: true },
    });
    const sideEffect = await prisma.medicationSideEffect.create({
      data: {
        id: "side-effect-dr",
        userId: ownerId,
        medicationId: medication.id,
        occurredAt: new Date("2026-06-27T21:00:00.000Z"),
        category: "INJECTION_SITE",
        entry: "INJECTION_SWELLING",
        severity: 4,
        notesEncrypted: encryptToBytes("swollen for a day after the injection"),
        createdAt: new Date("2026-06-27T21:10:00.000Z"),
      },
    });
    const intake = await prisma.medicationIntakeEvent.create({
      data: {
        id: "intake-dr",
        userId: ownerId,
        medicationId: medication.id,
        scheduledFor: new Date("2026-06-29T08:00:00.000Z"),
        takenAt: new Date("2026-06-29T08:05:00.000Z"),
        autoMissed: false,
        attributionSource: "USER_PIN",
        source: "APPLE_HEALTH",
        idempotencyKey: "intake-idempotency-dr",
        injectionSite: "THIGH_LEFT",
        doseTaken: "1 mg",
        inventoryConsumption: [{ itemId: "pen-dr", units: 0.5 }],
        externalId: "intake-external-dr",
        syncVersion: 5,
        deletedAt: tombstoneDeletedAt,
      },
    });

    const cycleProfile = await prisma.cycleProfile.create({
      data: {
        id: "cycle-profile-dr",
        userId: ownerId,
        goal: "GENERAL_HEALTH",
        cycleTrackingEnabled: true,
        typicalCycleLength: 28,
        typicalPeriodLength: 5,
        lutealPhaseLength: 14,
        secondarySymptom: "CERVIX",
        predictionEnabled: false,
        rawChartMode: true,
        discreetNotifications: true,
        sensitiveCategoryEncryption: true,
      },
    });
    const cycle = await prisma.menstrualCycle.create({
      data: {
        id: "cycle-dr",
        userId: ownerId,
        startDate: "2026-06-01",
        endDate: "2026-06-28",
        periodEndDate: "2026-06-05",
        lengthDays: 28,
        ovulationDate: "2026-06-14",
        ovulationConfirmed: true,
        isPredicted: false,
        tz: "Europe/London",
        syncVersion: 6,
        deletedAt: tombstoneDeletedAt,
      },
    });
    const cycleCategory = await prisma.cycleSymptomCategory.findFirstOrThrow();
    const cycleSymptom = await prisma.cycleSymptom.create({
      data: {
        id: "cycle-symptom-dr",
        userId: ownerId,
        categoryId: cycleCategory.id,
        key: "cycle_cramps_dr",
        labelKey: "cycle.symptom.crampsDr",
      },
    });
    const cycleDay = await prisma.cycleDayLog.create({
      data: {
        id: "cycle-day-dr",
        userId: ownerId,
        cycleId: cycle.id,
        date: "2026-06-02",
        flow: "HEAVY",
        intermenstrualBleeding: true,
        basalBodyTempC: 36.7,
        temperatureExcluded: true,
        ovulationTest: "NEGATIVE",
        cervicalMucus: "CREAMY",
        cervixPosition: "LOW",
        cervixFirmness: "FIRM",
        cervixOpening: "CLOSED",
        sexualActivity: false,
        sensitiveEncrypted: "sensitive-cycle-dr",
        notesEncrypted: "notes-cycle-dr",
        source: "APPLE_HEALTH",
        externalId: "cycle-day-external-dr",
        tz: "Europe/London",
        syncVersion: 7,
        deletedAt: tombstoneDeletedAt,
        symptomLinks: { create: { symptomId: cycleSymptom.id } },
      },
    });

    const biomarker = await prisma.biomarker.create({
      data: {
        id: "biomarker-dr",
        userId: ownerId,
        name: "Ferritin",
        unit: "ng/mL",
        lowerBound: 30,
        upperBound: 300,
        panel: "Iron",
        contextEncrypted: encryptToBytes("Iron storage context"),
      },
    });
    const lab = await prisma.labResult.create({
      data: {
        id: "lab-dr",
        userId: ownerId,
        biomarkerId: biomarker.id,
        panel: "Iron",
        analyte: "Ferritin",
        value: 88,
        unit: "ng/mL",
        referenceLow: 30,
        referenceHigh: 300,
        takenAt: new Date("2026-06-30T09:00:00.000Z"),
        source: "MANUAL",
        noteEncrypted: encryptToBytes("Fasted"),
        deletedAt: tombstoneDeletedAt,
      },
    });

    const illness = await prisma.illnessEpisode.create({
      data: {
        id: "illness-dr",
        userId: ownerId,
        label: "Cold",
        type: "INFECTION",
        lifecycle: "ACUTE",
        onsetAt: new Date("2026-06-20T00:00:00.000Z"),
        resolvedAt: new Date("2026-06-24T00:00:00.000Z"),
        noteEncrypted: encryptToBytes("Recovered fully"),
        deletedAt: tombstoneDeletedAt,
      },
    });
    const symptom = await prisma.illnessSymptom.create({
      data: {
        id: "symptom-dr",
        key: "dr_cough",
        labelKey: "illness.symptom.drCough",
      },
    });
    const illnessDay = await prisma.illnessDayLog.create({
      data: {
        id: "illness-day-dr",
        userId: ownerId,
        episodeId: illness.id,
        date: "2026-06-21",
        functionalImpact: 2,
        feverC: 38.1,
        noteEncrypted: encryptToBytes("Rest day"),
        tz: "Europe/London",
        deletedAt: tombstoneDeletedAt,
        symptomLinks: {
          create: { symptomId: symptom.id, severity: 2 },
        },
      },
    });

    const allergy = await prisma.allergy.create({
      data: {
        id: "allergy-dr",
        userId: ownerId,
        substance: "Penicillin",
        category: "MEDICATION",
        type: "ALLERGY",
        severity: "SEVERE",
        status: "ACTIVE",
        onsetAt: new Date("2020-01-01T00:00:00.000Z"),
        reactionEncrypted: encryptToBytes("Hives"),
        notesEncrypted: encryptToBytes("Avoid beta-lactams"),
        deletedAt: tombstoneDeletedAt,
      },
    });
    const family = await prisma.familyHistoryEntry.create({
      data: {
        id: "family-dr",
        userId: ownerId,
        relationship: "MOTHER",
        condition: "Type 2 diabetes",
        ageAtOnset: 55,
        notesEncrypted: encryptToBytes("Diet controlled"),
      },
    });
    const workout = await prisma.workout.create({
      data: {
        id: "workout-dr",
        userId: ownerId,
        sportType: "RUNNING",
        startedAt: new Date("2026-06-29T06:00:00.000Z"),
        endedAt: new Date("2026-06-29T06:30:00.000Z"),
        durationSec: 1800,
        totalEnergyKcal: 250,
        totalDistanceM: 5000,
        avgHeartRate: 145,
        maxHeartRate: 170,
        source: "IMPORT",
        externalId: "run-external-dr",
      },
    });

    const encryptedBuffer = encryptBytes(Buffer.from("private PDF bytes"));
    const contentEncrypted = new Uint8Array(
      new ArrayBuffer(encryptedBuffer.byteLength),
    );
    contentEncrypted.set(encryptedBuffer);
    const summaryEncrypted = encryptToBytes("Encrypted summary");
    const document = await prisma.inboundDocument.create({
      data: {
        id: "document-dr",
        userId: ownerId,
        kind: "LAB_RESULT",
        title: "June labs",
        filename: "june-labs.pdf",
        mimeType: "application/pdf",
        byteSize: 17,
        contentEncrypted,
        contentSha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        contentCodec: "binary2",
        status: "EXTRACTED",
        providerType: "local",
        reportDate: new Date("2026-06-30T00:00:00.000Z"),
        documentDate: new Date("2026-06-30T00:00:00.000Z"),
        summaryEncrypted,
        summaryGeneratedAt: new Date("2026-07-01T08:00:00.000Z"),
        summaryState: "READY",
        createdAt: new Date("2026-07-01T07:30:00.000Z"),
        updatedAt: new Date("2026-07-01T08:00:00.000Z"),
      },
    });

    const s3 = makeS3Store();
    const snapshotAt = new Date("2026-07-02T00:00:00.000Z");
    const offhostReport = await runOffhostBackup(prisma, s3, snapshotAt);
    expect(offhostReport).toMatchObject({
      uploaded: 1,
      failed: 0,
      totalUsers: 1,
    });
    const offhostObject = s3.objects.get(`2026-07-02/user-${ownerId}.json.enc`);
    expect(offhostObject).toBeDefined();
    const payload = parseBackupPayload(
      decryptBackup(offhostObject!, Buffer.from(OFFHOST_ENCRYPTION_KEY, "hex")),
    );
    expect(payload).toMatchObject({
      schemaVersion: "2",
      userId: ownerId,
      appSettings: { id: settings.id },
    });
    expect(payload.documents[0]).not.toHaveProperty("summary");
    expect(JSON.stringify(payload.documents[0])).not.toContain(
      "private PDF bytes",
    );

    await prisma.appSettings.deleteMany();
    await prisma.medicationIntakeEvent.deleteMany({
      where: { userId: ownerId },
    });
    await prisma.medication.deleteMany({ where: { userId: ownerId } });
    await prisma.cycleDayLog.deleteMany({ where: { userId: ownerId } });
    await prisma.menstrualCycle.deleteMany({ where: { userId: ownerId } });
    await prisma.cycleProfile.deleteMany({ where: { userId: ownerId } });
    await prisma.inboundDocument.deleteMany({ where: { userId: ownerId } });
    await prisma.workout.deleteMany({ where: { userId: ownerId } });
    await prisma.familyHistoryEntry.deleteMany({ where: { userId: ownerId } });
    await prisma.allergy.deleteMany({ where: { userId: ownerId } });
    await prisma.illnessEpisode.deleteMany({ where: { userId: ownerId } });
    await prisma.labResult.deleteMany({ where: { userId: ownerId } });
    await prisma.biomarker.deleteMany({ where: { userId: ownerId } });

    const backup = await prisma.dataBackup.create({
      data: {
        userId: ownerId,
        type: "CANONICAL_DR_ROUND_TRIP",
        data: encrypt(JSON.stringify(payload)),
      },
    });

    const restore = async () =>
      POST(makeRequest(backup.id) as unknown as Parameters<typeof POST>[0], {
        params: Promise.resolve({ id: backup.id }),
      });

    expect((await restore()).status).toBe(200);

    expect(
      await prisma.appSettings.findUniqueOrThrow({
        where: { id: settings.id },
      }),
    ).toEqual(settings);
    expect(
      await prisma.medication.findUniqueOrThrow({
        where: { id: medication.id },
        include: { schedules: true },
      }),
    ).toEqual(medication);
    expect(
      await prisma.medicationIntakeEvent.findUniqueOrThrow({
        where: { id: intake.id },
      }),
    ).toEqual(intake);
    // Byte-for-byte, ciphertext included: a canonical payload carries the
    // encrypted note verbatim, so the same instance's key reads back exactly
    // what it wrote. Re-encrypting here would still decrypt to the same words
    // and would still be a different row than the one the file described.
    expect(
      await prisma.medicationSideEffect.findUniqueOrThrow({
        where: { id: sideEffect.id },
      }),
    ).toEqual(sideEffect);
    expect(
      await prisma.cycleProfile.findUniqueOrThrow({
        where: { id: cycleProfile.id },
      }),
    ).toEqual(cycleProfile);
    expect(
      await prisma.menstrualCycle.findUniqueOrThrow({
        where: { id: cycle.id },
      }),
    ).toEqual(cycle);
    expect(
      await prisma.cycleDayLog.findUniqueOrThrow({
        where: { id: cycleDay.id },
      }),
    ).toEqual(cycleDay);
    expect(
      await prisma.cycleSymptomLink.findMany({
        where: { dayLogId: cycleDay.id },
        select: { symptomId: true },
      }),
    ).toEqual([{ symptomId: cycleSymptom.id }]);

    expect(await prisma.labResult.count({ where: { userId: ownerId } })).toBe(
      1,
    );
    expect(await prisma.biomarker.count({ where: { userId: ownerId } })).toBe(
      1,
    );
    expect(
      await prisma.illnessEpisode.count({ where: { userId: ownerId } }),
    ).toBe(1);
    expect(
      await prisma.illnessDayLog.count({ where: { userId: ownerId } }),
    ).toBe(1);
    expect(await prisma.allergy.count({ where: { userId: ownerId } })).toBe(1);
    expect(
      await prisma.familyHistoryEntry.count({ where: { userId: ownerId } }),
    ).toBe(1);
    expect(await prisma.workout.count({ where: { userId: ownerId } })).toBe(1);
    expect(
      await prisma.inboundDocument.count({ where: { userId: ownerId } }),
    ).toBe(1);
    expect(
      await prisma.measurement.findUniqueOrThrow({
        where: { id: measurement.id },
      }),
    ).toEqual(measurement);
    expect(
      await prisma.measurement.findUniqueOrThrow({
        where: { id: deletedMeasurement.id },
      }),
    ).toEqual(deletedMeasurement);

    const restoredLab = await prisma.labResult.findUniqueOrThrow({
      where: { id: lab.id },
    });
    expect(decryptFromBytes(restoredLab.noteEncrypted!)).toBe("Fasted");
    expect(restoredLab.biomarkerId).toBe(biomarker.id);
    expect(restoredLab).toEqual(lab);
    const restoredBiomarker = await prisma.biomarker.findUniqueOrThrow({
      where: { id: biomarker.id },
    });
    expect(restoredBiomarker).toEqual(
      expect.objectContaining({
        name: biomarker.name,
        unit: biomarker.unit,
        lowerBound: biomarker.lowerBound,
        upperBound: biomarker.upperBound,
        panel: biomarker.panel,
        hidden: biomarker.hidden,
      }),
    );
    expect(decryptFromBytes(restoredBiomarker.contextEncrypted!)).toBe(
      "Iron storage context",
    );

    const restoredIllness = await prisma.illnessEpisode.findUniqueOrThrow({
      where: { id: illness.id },
    });
    expect(restoredIllness).toEqual(illness);
    expect(decryptFromBytes(restoredIllness.noteEncrypted!)).toBe(
      "Recovered fully",
    );
    const restoredIllnessDay = await prisma.illnessDayLog.findUniqueOrThrow({
      where: { id: illnessDay.id },
    });
    expect(restoredIllnessDay).toEqual(illnessDay);
    expect(decryptFromBytes(restoredIllnessDay.noteEncrypted!)).toBe(
      "Rest day",
    );
    expect(
      await prisma.illnessSymptomLink.findMany({
        where: { dayLogId: illnessDay.id },
      }),
    ).toEqual([
      expect.objectContaining({ symptomId: symptom.id, severity: 2 }),
    ]);

    const restoredAllergy = await prisma.allergy.findUniqueOrThrow({
      where: { id: allergy.id },
    });
    expect(decryptFromBytes(restoredAllergy.reactionEncrypted!)).toBe("Hives");
    expect(restoredAllergy).toEqual(allergy);
    const restoredFamily = await prisma.familyHistoryEntry.findUniqueOrThrow({
      where: { id: family.id },
    });
    expect(decryptFromBytes(restoredFamily.notesEncrypted!)).toBe(
      "Diet controlled",
    );
    expect(restoredFamily).toEqual(
      expect.objectContaining({
        relationship: family.relationship,
        condition: family.condition,
        ageAtOnset: family.ageAtOnset,
      }),
    );
    expect(
      await prisma.workout.findUniqueOrThrow({ where: { id: workout.id } }),
    ).toEqual(
      expect.objectContaining({
        sportType: workout.sportType,
        startedAt: workout.startedAt,
        endedAt: workout.endedAt,
        durationSec: workout.durationSec,
        totalEnergyKcal: workout.totalEnergyKcal,
        totalDistanceM: workout.totalDistanceM,
        avgHeartRate: workout.avgHeartRate,
        maxHeartRate: workout.maxHeartRate,
        source: workout.source,
        externalId: workout.externalId,
      }),
    );

    const restoredDocument = await prisma.inboundDocument.findUniqueOrThrow({
      where: { id: document.id },
    });
    expect(Buffer.from(restoredDocument.contentEncrypted)).toEqual(
      Buffer.from(document.contentEncrypted),
    );
    expect(Buffer.from(restoredDocument.summaryEncrypted!)).toEqual(
      Buffer.from(document.summaryEncrypted!),
    );
    expect(restoredDocument).toEqual(
      expect.objectContaining({
        title: document.title,
        filename: document.filename,
        mimeType: document.mimeType,
        byteSize: document.byteSize,
        contentSha256: document.contentSha256,
        contentCodec: document.contentCodec,
        status: document.status,
        providerType: document.providerType,
        summaryState: document.summaryState,
        reportDate: document.reportDate,
        documentDate: document.documentDate,
        errorReason: document.errorReason,
        summaryGeneratedAt: document.summaryGeneratedAt,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      }),
    );

    const restoredMood = await prisma.moodEntry.findUniqueOrThrow({
      where: { id: mood.id },
      include: {
        tagLinks: {
          include: { moodTag: { select: { key: true } } },
        },
      },
    });
    expect(restoredMood).toEqual(
      expect.objectContaining({
        date: mood.date,
        mood: mood.mood,
        score: mood.score,
        source: mood.source,
        moodLoggedAt: mood.moodLoggedAt,
      }),
    );
    expect(restoredMood.tagLinks).toEqual([
      expect.objectContaining({
        rating: 5,
        moodTag: { key: "dr_sleep_quality" },
      }),
    ]);
    expect(
      await prisma.moodEntry.findUniqueOrThrow({
        where: { id: deletedMood.id },
      }),
    ).toEqual(
      expect.objectContaining({
        userId: ownerId,
        deletedAt: tombstoneDeletedAt,
      }),
    );

    expect((await restore()).status).toBe(200);
    expect(
      await prisma.inboundDocument.findMany({
        where: { userId: ownerId },
        select: { id: true },
      }),
    ).toEqual([{ id: document.id }]);
    expect(
      await prisma.workout.findMany({
        where: { userId: ownerId },
        select: { id: true },
      }),
    ).toEqual([{ id: workout.id }]);
    expect(
      await prisma.labResult.findMany({
        where: { userId: ownerId },
        select: { id: true },
      }),
    ).toEqual([{ id: lab.id }]);
    expect(
      await prisma.illnessEpisode.findMany({
        where: { userId: ownerId },
        select: { id: true },
      }),
    ).toEqual([{ id: illness.id }]);
  });

  it("rejects a stable measurement id owned by another account without clearing either owner", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();
    const other = await prisma.user.create({
      data: { username: "stable-id-owner-other" },
    });
    const original = await prisma.measurement.create({
      data: {
        id: "owner-original-measurement",
        userId: admin.id,
        type: "PULSE",
        value: 70,
        unit: "bpm",
        measuredAt: new Date("2026-07-08T10:00:00.000Z"),
      },
    });
    const conflicting = await prisma.measurement.create({
      data: {
        id: "cross-owner-stable-id",
        userId: other.id,
        type: "PULSE",
        value: 65,
        unit: "bpm",
        measuredAt: new Date("2026-07-08T11:00:00.000Z"),
      },
    });
    const payload = backupPayloadSchema.parse({
      schemaVersion: "2",
      exportedAt: "2026-07-12T00:00:00.000Z",
      userId: admin.id,
      measurements: [
        {
          id: conflicting.id,
          type: "PULSE",
          value: 80,
          unit: "bpm",
          measuredAt: "2026-07-08T12:00:00.000Z",
          source: "IMPORT",
        },
      ],
    });
    const backup = await prisma.dataBackup.create({
      data: {
        userId: admin.id,
        type: "STABLE_ID_OWNER_CONFLICT",
        data: encrypt(JSON.stringify(payload)),
      },
    });

    const response = await POST(
      makeRequest(backup.id) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );

    expect(response.status).toBe(500);
    expect(
      await prisma.measurement.findUnique({ where: { id: original.id } }),
    ).toEqual(original);
    expect(
      await prisma.measurement.findUnique({ where: { id: conflicting.id } }),
    ).toEqual(conflicting);
  });

  it("restores many stable-id measurements with a bounded number of writes", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();
    const measurements = Array.from({ length: 250 }, (_, index) => ({
      id: `stable-measurement-${index}`,
      type: "PULSE" as const,
      value: 60 + (index % 20),
      unit: "bpm",
      measuredAt: new Date(Date.UTC(2026, 6, 10, 0, 0, 0, index)).toISOString(),
      source: "IMPORT" as const,
      externalId: `external-${index}`,
      syncVersion: 3,
      deletedAt: index % 10 === 0 ? "2026-07-11T00:00:00.000Z" : null,
    }));
    const payload = backupPayloadSchema.parse({
      schemaVersion: "2",
      exportedAt: "2026-07-12T00:00:00.000Z",
      userId: admin.id,
      measurements,
    });
    const backup = await prisma.dataBackup.create({
      data: {
        userId: admin.id,
        type: "BOUNDED_STABLE_ID_RESTORE",
        data: encrypt(JSON.stringify(payload)),
      },
    });
    let stableWriteQueries = 0;
    const originalTransaction = prisma.$transaction.bind(prisma) as unknown as (
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: { maxWait?: number; timeout?: number },
    ) => Promise<unknown>;
    const transactionSpy = vi.spyOn(prisma, "$transaction");
    transactionSpy.mockImplementation((async (
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: { maxWait?: number; timeout?: number },
    ) =>
      originalTransaction(async (tx) => {
        const originalUpsert = tx.measurement.upsert.bind(tx.measurement);
        const originalCreateMany = tx.measurement.createMany.bind(
          tx.measurement,
        );
        vi.spyOn(tx.measurement, "upsert").mockImplementation((args) => {
          stableWriteQueries += 1;
          return originalUpsert(args);
        });
        vi.spyOn(tx.measurement, "createMany").mockImplementation((args) => {
          stableWriteQueries += 1;
          return originalCreateMany(args);
        });
        return callback(tx);
      }, options)) as never);

    const response = await POST(
      makeRequest(backup.id) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );

    expect(response.status).toBe(200);
    transactionSpy.mockRestore();
    expect(stableWriteQueries).toBeLessThanOrEqual(2);
    expect(
      await prisma.measurement.findMany({
        where: { userId: admin.id },
        orderBy: { id: "asc" },
        select: { id: true },
      }),
    ).toEqual(
      measurements
        .map(({ id }) => ({ id }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
  });
  it.each([
    {
      label: "invalid enum",
      mutate: (payload: Record<string, unknown>) => {
        payload.measurements = [
          {
            type: "INVALID_MEASUREMENT_TYPE",
            value: 72,
            unit: "kg",
            measuredAt: "2026-07-03T07:00:00.000Z",
            source: "MANUAL",
          },
        ];
      },
    },
    {
      label: "unsupported schema version",
      mutate: (payload: Record<string, unknown>) => {
        payload.schemaVersion = "999";
      },
    },
  ])(
    "rejects $label with 422 before writes or invalidation",
    async ({ mutate }) => {
      const prisma = getPrismaClient();
      const admin = await seedAdminSession();
      const existing = await prisma.measurement.create({
        data: {
          id: "pre-validation-measurement",
          userId: admin.id,
          type: "WEIGHT",
          value: 91,
          unit: "kg",
          source: "MANUAL",
          measuredAt: new Date("2026-07-03T06:00:00.000Z"),
        },
      });
      const payload: Record<string, unknown> = {
        schemaVersion: "1",
        exportedAt: "2026-07-03T08:00:00.000Z",
        userId: admin.id,
        measurements: [],
        moodEntries: [],
      };
      mutate(payload);
      const backup = await prisma.dataBackup.create({
        data: {
          userId: admin.id,
          type: `INVALID_BOUNDARY_${String(payload.schemaVersion)}`,
          data: encrypt(JSON.stringify(payload)),
        },
      });

      const response = await POST(
        makeRequest(backup.id) as unknown as Parameters<typeof POST>[0],
        { params: Promise.resolve({ id: backup.id }) },
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        data: null,
        error: expect.any(String),
      });
      expect(
        await prisma.measurement.findMany({
          where: { userId: admin.id },
          select: { id: true },
        }),
      ).toEqual([{ id: existing.id }]);
      expect(invalidateUserData).not.toHaveBeenCalled();
    },
  );

  it("rejects metadata-only documents before mutation or invalidation", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();
    await prisma.measurement.create({
      data: {
        userId: admin.id,
        type: "WEIGHT",
        value: 91,
        unit: "kg",
        source: "MANUAL",
        measuredAt: new Date("2026-07-03T07:00:00.000Z"),
      },
    });
    const payload = backupPayloadSchema.parse({
      schemaVersion: "1",
      exportedAt: "2026-07-03T08:00:00.000Z",
      userId: admin.id,
      measurements: [],
      moodEntries: [],
      documents: [
        {
          id: "metadata-only-document",
          kind: "OTHER",
          title: null,
          filename: "metadata.pdf",
          mimeType: "application/pdf",
          byteSize: 12,
          status: "STORED",
          reportDate: null,
          documentDate: null,
          summary: null,
          createdAt: "2026-07-03T08:00:00.000Z",
        },
      ],
      manifest: {
        documents: { included: "metadata-only", note: "Portable export" },
        workouts: { included: "summary-only", note: "Summary only" },
      },
    });
    const backup = await prisma.dataBackup.create({
      data: {
        userId: admin.id,
        type: "PORTABLE_METADATA_ONLY",
        data: encrypt(JSON.stringify(payload)),
      },
    });

    const response = await POST(
      makeRequest(backup.id) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );

    expect(response.status).toBe(422);
    expect(
      await prisma.measurement.count({ where: { userId: admin.id } }),
    ).toBe(1);
    expect(invalidateUserData).not.toHaveBeenCalled();
  });

  /**
   * The contract here is the rollback, not the trigger. The trigger used to be
   * a mood factor key the instance did not know, and that is no longer a
   * failure at all: a seeded catalogue legitimately drifts between the day a
   * backup is written and the day it is read, so an unresolvable catalogue key
   * now drops one link and names it in the response rather than costing the
   * whole file.
   *
   * An intake event naming a medication the file does not carry is a different
   * animal and still throws. That reference points at a row THIS FILE was
   * supposed to contain, so a dangling one means the file contradicts itself,
   * and writing a dose history against a medication that does not exist is not
   * a recoverable restore. It is the honest trigger for the rollback contract.
   */
  it("rolls back a failed full restore before invalidating caches", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();
    const measurement = await prisma.measurement.create({
      data: {
        userId: admin.id,
        type: "WEIGHT",
        value: 91,
        unit: "kg",
        source: "MANUAL",
        measuredAt: new Date("2026-07-04T07:00:00.000Z"),
      },
    });
    const payload = backupPayloadSchema.parse({
      schemaVersion: "1",
      exportedAt: "2026-07-04T08:00:00.000Z",
      userId: admin.id,
      measurements: [],
      medications: [],
      intakeEvents: [
        {
          id: "failed-restore-intake",
          medication: "a medication this file never carried",
          scheduledFor: "2026-07-04T08:00:00.000Z",
          takenAt: "2026-07-04T08:05:00.000Z",
        },
      ],
      moodEntries: [
        {
          id: "failed-restore-mood",
          date: "2026-07-04",
          mood: "OKAY",
          score: 3,
          tags: null,
          loggedAt: "2026-07-04T08:00:00.000Z",
          factors: [],
        },
      ],
    });
    const backup = await prisma.dataBackup.create({
      data: {
        userId: admin.id,
        type: "FAILED_FULL_RESTORE",
        data: encrypt(JSON.stringify(payload)),
      },
    });

    const response = await POST(
      makeRequest(backup.id) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );

    expect(response.status).toBe(500);
    expect(
      await prisma.measurement.findMany({
        where: { userId: admin.id },
        select: { id: true },
      }),
    ).toEqual([{ id: measurement.id }]);
    expect(await prisma.moodEntry.count({ where: { userId: admin.id } })).toBe(
      0,
    );
    expect(invalidateUserData).not.toHaveBeenCalled();
  });

  /**
   * `aggregationProvenance` is what keeps an export.xml source-day estimate
   * from overwriting a native HealthKit statistic. A backup that drops it
   * restores a flattened authority ladder, so it has to survive the round
   * trip — and a backup written before it rode the payload has to land in the
   * documented repairable state rather than reproduce the ambiguity migration
   * 0263 already repaired once.
   *
   * Mutation check: drop `aggregationProvenance` from the backup select or
   * from the restore mapping and the first case goes red; drop the
   * Apple-Health `stats:` fallback and the second goes red.
   */
  it("round-trips the aggregation provenance of a stats aggregate", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();
    const payload = backupPayloadSchema.parse({
      schemaVersion: "2",
      exportedAt: "2026-07-25T00:00:00.000Z",
      userId: admin.id,
      measurements: [
        {
          id: "provenance-native",
          type: "ACTIVITY_STEPS",
          value: 8_600,
          unit: "steps",
          measuredAt: "2026-07-20T10:00:00.000Z",
          source: "APPLE_HEALTH",
          externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-07-20",
          aggregationProvenance: "HEALTHKIT_STATISTICS",
        },
        {
          id: "provenance-xml",
          type: "ACTIVITY_STEPS",
          value: 8_526,
          unit: "steps",
          measuredAt: "2026-07-21T10:00:00.000Z",
          source: "APPLE_HEALTH",
          externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-07-21",
          aggregationProvenance: "EXPORT_XML_SOURCE_MAX",
        },
      ],
    });
    const backup = await prisma.dataBackup.create({
      data: {
        userId: admin.id,
        type: "PROVENANCE_ROUNDTRIP",
        data: encrypt(JSON.stringify(payload)),
      },
    });

    const response = await POST(
      makeRequest(backup.id) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );
    expect(response.status).toBe(200);

    expect(
      await prisma.measurement.findMany({
        where: { userId: admin.id },
        orderBy: { measuredAt: "asc" },
        select: { id: true, aggregationProvenance: true },
      }),
    ).toEqual([
      {
        id: "provenance-native",
        aggregationProvenance: "HEALTHKIT_STATISTICS",
      },
      { id: "provenance-xml", aggregationProvenance: "EXPORT_XML_SOURCE_MAX" },
    ]);
  });

  it("marks an unlabelled Apple Health stats aggregate as legacy-unknown on restore", async () => {
    const prisma = getPrismaClient();
    const admin = await seedAdminSession();
    // A backup taken before the provenance rode the payload: no field at all.
    const payload = backupPayloadSchema.parse({
      schemaVersion: "2",
      exportedAt: "2026-07-25T00:00:00.000Z",
      userId: admin.id,
      measurements: [
        {
          id: "legacy-apple-stats",
          type: "ACTIVITY_STEPS",
          value: 8_526,
          unit: "steps",
          measuredAt: "2026-07-20T10:00:00.000Z",
          source: "APPLE_HEALTH",
          externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-07-20",
        },
        {
          // Another provider's cumulative daily. It mints a `stats:` id too but
          // has never carried provenance, so inventing one would be a lie.
          id: "legacy-fitbit-stats",
          type: "ACTIVITY_STEPS",
          value: 7_100,
          unit: "steps",
          measuredAt: "2026-07-21T10:00:00.000Z",
          source: "FITBIT",
          externalId: "stats:steps",
        },
        {
          // An ordinary point reading never had provenance either.
          id: "legacy-point-row",
          type: "PULSE",
          value: 61,
          unit: "bpm",
          measuredAt: "2026-07-22T10:00:00.000Z",
          source: "MANUAL",
        },
      ],
    });
    const backup = await prisma.dataBackup.create({
      data: {
        userId: admin.id,
        type: "PROVENANCE_LEGACY",
        data: encrypt(JSON.stringify(payload)),
      },
    });

    const response = await POST(
      makeRequest(backup.id) as unknown as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: backup.id }) },
    );
    expect(response.status).toBe(200);

    expect(
      await prisma.measurement.findMany({
        where: { userId: admin.id },
        orderBy: { measuredAt: "asc" },
        select: { id: true, aggregationProvenance: true },
      }),
    ).toEqual([
      { id: "legacy-apple-stats", aggregationProvenance: "LEGACY_UNKNOWN" },
      { id: "legacy-fitbit-stats", aggregationProvenance: null },
      { id: "legacy-point-row", aggregationProvenance: null },
    ]);
  });
});
