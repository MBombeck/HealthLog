import { describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";

process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const mocks = vi.hoisted(() => ({
  iterateMeasurementPages: vi.fn(),
  buildCycleBackupSection: vi.fn(),
  buildRecordsBackupSection: vi.fn(),
}));

vi.mock("@/lib/export/paged-measurements", () => ({
  iterateMeasurementPages: mocks.iterateMeasurementPages,
}));
vi.mock("@/lib/cycle/backup", () => ({
  buildCycleBackupSection: mocks.buildCycleBackupSection,
}));
vi.mock("@/lib/export/records-backup", () => ({
  buildRecordsBackupSection: mocks.buildRecordsBackupSection,
  countRecordsBackupSection: vi.fn(() => ({
    labResults: 0,
    biomarkers: 0,
    illnessEpisodes: 0,
    illnessDayLogs: 0,
    allergies: 0,
    familyHistory: 0,
    workouts: 0,
    documents: 0,
  })),
}));

import { buildFullBackupPayload } from "../full-backup-payload";

const deletedAt = new Date("2026-07-19T12:00:00.000Z");
const measurementNote = encryptToBytes("canonical measurement note");

const appSettings = {
  id: "singleton",
  registrationEnabled: false,
  mfaRequired: true,
  defaultLocale: "en",
  telegramGlobal: false,
  ntfyGlobal: false,
  webPushGlobal: false,
  webPushVapidPublicKey: "public-key",
  webPushVapidPrivateKeyEncrypted: "encrypted-private-key",
  webPushVapidSubject: "mailto:ops@example.test",
  apiGlobal: false,
  moodLogGlobal: false,
  umamiEnabled: true,
  umamiScriptUrl: "https://analytics.example.test/script.js",
  umamiWebsiteId: "website-id",
  glitchtipEnabled: true,
  glitchtipDsn: "https://dsn.example.test/1",
  glitchtipEnvironment: "recovery",
  reminderLateMinutes: 45,
  reminderMissedMinutes: 90,
  adminAiKeyEncrypted: "encrypted-ai-key",
  adminAiModel: "gpt-test",
  adminAiBaseUrl: "https://ai.example.test/v1",
  adminCodexAccessTokenEncrypted: "encrypted-access",
  adminCodexRefreshTokenEncrypted: "encrypted-refresh",
  adminCodexAccountIdEncrypted: "encrypted-account",
  adminCodexTokenExpiresAt: new Date("2026-07-21T08:00:00.000Z"),
  adminCodexConnectedAt: new Date("2026-07-20T08:00:00.000Z"),
  adminCodexConnectionStatus: "connected",
  adminAiInsightsFeedbackSummary: { helpful: 7, total: 9 },
  defaultUserTimezone: "Europe/London",
  assistantEnabled: false,
  assistantCoachEnabled: false,
  assistantBriefingEnabled: false,
  assistantInsightStatusEnabled: false,
  assistantCorrelationsEnabled: false,
  assistantHealthScoreExplainerEnabled: false,
  moduleAvailabilityJson: { nutrients: false, insights: true },
  documentMaxFileBytes: 12_345_678,
  documentQuotaBytes: BigInt("9876543210"),
};

function makePrisma() {
  return {
    appSettings: { findUnique: vi.fn().mockResolvedValue(appSettings) },
    medication: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "medication-canonical",
          name: "Example",
          dose: "2 mg",
          treatmentClass: "GENERIC",
          dosesPerUnit: 4,
          unitsPerDose: { toString: () => "0.5000" },
          active: false,
          notificationsEnabled: false,
          pausedAt: new Date("2026-07-18T10:00:00.000Z"),
          snoozedUntil: new Date("2026-07-22T10:00:00.000Z"),
          startsOn: new Date("2026-07-01T00:00:00.000Z"),
          endsOn: new Date("2026-08-01T00:00:00.000Z"),
          oneShot: false,
          asNeeded: false,
          deliveryForm: "INJECTION",
          trackInjectionSites: true,
          allowedInjectionSites: ["THIGH_LEFT", "THIGH_RIGHT"],
          liveActivityEnabled: true,
          criticalAlarmEnabled: true,
          atcCode: "A10BX10",
          rxNormCode: "12345",
          lowStockNotifiedAt: new Date("2026-07-17T10:00:00.000Z"),
          lowStockNotifiedThresholdDays: 7,
          reorderLeadDays: 3,
          externalSource: "APPLE_HEALTH",
          externalId: "med-external",
          createdAt: new Date("2026-06-01T10:00:00.000Z"),
          updatedAt: new Date("2026-07-19T10:00:00.000Z"),
          schedules: [
            {
              id: "schedule-canonical",
              windowStart: "08:00",
              windowEnd: "10:00",
              label: "Morning",
              dose: "1 mg",
              daysOfWeek: "i2;1,3,5",
              timesOfDay: ["08:00", "20:00"],
              reminderGraceMinutes: 90,
              rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR",
              rollingIntervalDays: null,
              scheduleType: "CYCLIC",
              cyclicOnWeeks: 3,
              cyclicOffWeeks: 1,
              doseWindows: [
                { timeOfDay: "08:00", start: "07:30", end: "09:00" },
              ],
            },
          ],
        },
      ]),
    },
    medicationIntakeEvent: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "intake-canonical",
          medicationId: "medication-canonical",
          medication: { name: "Example" },
          scheduledFor: new Date("2026-07-19T08:00:00.000Z"),
          takenAt: new Date("2026-07-19T08:05:00.000Z"),
          skipped: false,
          autoMissed: false,
          attributionSource: "USER_PIN",
          source: "APPLE_HEALTH",
          idempotencyKey: "intake-idempotency",
          createdAt: new Date("2026-07-19T08:05:00.000Z"),
          injectionSite: "THIGH_LEFT",
          doseTaken: "1 mg",
          inventoryConsumption: [{ itemId: "pen-1", units: 0.5 }],
          externalId: "intake-external",
          updatedAt: new Date("2026-07-19T08:06:00.000Z"),
          syncVersion: 4,
          deletedAt,
        },
      ]),
    },
    moodEntry: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "mood-tombstone",
          date: "2026-07-19",
          mood: "OKAY",
          score: 3,
          tags: null,
          source: "MOODLOG",
          externalId: "moodlog-42",
          moodLoggedAt: new Date("2026-07-19T08:00:00.000Z"),
          deletedAt,
          tagLinks: [{ rating: 4, moodTag: { key: "sleep_quality" } }],
        },
      ]),
    },
  };
}

function installSectionMocks() {
  void measurementNote;
  const measurement = {
    id: "measurement-tombstone",
    type: "SLEEP_DURATION",
    value: 75,
    valueMin: 60,
    valueMax: 90,
    unit: "minutes",
    measuredAt: new Date("2026-07-19T07:00:00.000Z"),
    source: "IMPORT",
    notes: null,
    notesEncrypted: measurementNote,
    externalId: "oura-stage-deep",
    externalSourceVersion: "oura-v3",
    glucoseContext: null,
    sleepStage: "DEEP",
    rhythmClassification: null,
    deviceType: "ring",
    syncVersion: 7,
    deletedAt,
    createdAt: new Date("2026-07-19T07:01:00.000Z"),
    updatedAt: new Date("2026-07-19T07:02:00.000Z"),
  };
  mocks.iterateMeasurementPages.mockImplementation(async function* () {
    yield [measurement];
    yield [
      {
        ...measurement,
        id: "measurement-page-2",
        measuredAt: new Date("2026-07-18T07:00:00.000Z"),
      },
    ];
  });
  mocks.buildCycleBackupSection.mockResolvedValue({
    cycleProfile: null,
    cycles: [],
    cycleDayLogs: [],
  });
  mocks.buildRecordsBackupSection.mockResolvedValue({
    labResults: [],
    biomarkers: [],
    illnessEpisodes: [],
    allergies: [],
    familyHistory: [],
    workouts: [],
    documents: [],
    manifest: {
      documents: { included: "encrypted-content", note: "included" },
      workouts: { included: "summary-only", note: "included" },
    },
  });
  return measurement;
}

describe("buildFullBackupPayload disaster-recovery mode", () => {
  it("preserves tombstones while consuming measurement pages into the final payload", async () => {
    installSectionMocks();
    const prisma = makePrisma();

    const { payload } = await buildFullBackupPayload(
      prisma as never,
      "user-1",
      {
        purpose: "disaster-recovery",
        exportedAt: new Date("2026-07-20T00:00:00.000Z"),
      },
    );

    expect(mocks.iterateMeasurementPages).toHaveBeenCalledWith(
      prisma,
      { userId: "user-1" },
      expect.objectContaining({ id: true, deletedAt: true }),
    );
    expect(prisma.moodEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1" },
        include: expect.any(Object),
      }),
    );
    expect(mocks.buildRecordsBackupSection).toHaveBeenCalledWith(
      prisma,
      "user-1",
      { purpose: "disaster-recovery" },
    );
    expect(payload).toMatchObject({
      schemaVersion: "2",
      exportedAt: "2026-07-20T00:00:00.000Z",
      appSettings: {
        ...appSettings,
        adminCodexTokenExpiresAt:
          appSettings.adminCodexTokenExpiresAt.toISOString(),
        adminCodexConnectedAt: appSettings.adminCodexConnectedAt.toISOString(),
        documentQuotaBytes: appSettings.documentQuotaBytes.toString(),
      },
      measurements: [
        {
          id: "measurement-tombstone",
          type: "SLEEP_DURATION",
          value: 75,
          valueMin: 60,
          valueMax: 90,
          unit: "minutes",
          measuredAt: "2026-07-19T07:00:00.000Z",
          source: "IMPORT",
          notesEncrypted: Buffer.from(measurementNote).toString("base64"),
          externalId: "oura-stage-deep",
          externalSourceVersion: "oura-v3",
          glucoseContext: null,
          sleepStage: "DEEP",
          rhythmClassification: null,
          deviceType: "ring",
          syncVersion: 7,
          deletedAt: deletedAt.toISOString(),
          createdAt: "2026-07-19T07:01:00.000Z",
          updatedAt: "2026-07-19T07:02:00.000Z",
        },
        {
          id: "measurement-page-2",
          measuredAt: "2026-07-18T07:00:00.000Z",
        },
      ],
      medications: [
        expect.objectContaining({
          id: "medication-canonical",
          asNeeded: false,
          deliveryForm: "INJECTION",
          unitsPerDose: "0.5000",
          schedules: [
            expect.objectContaining({
              id: "schedule-canonical",
              rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR",
              scheduleType: "CYCLIC",
              cyclicOnWeeks: 3,
              cyclicOffWeeks: 1,
            }),
          ],
        }),
      ],
      intakeEvents: [
        expect.objectContaining({
          id: "intake-canonical",
          medicationId: "medication-canonical",
          syncVersion: 4,
          deletedAt: deletedAt.toISOString(),
        }),
      ],
      moodEntries: [
        {
          id: "mood-tombstone",
          externalId: "moodlog-42",
          deletedAt: deletedAt.toISOString(),
          factors: [{ key: "sleep_quality", rating: 4 }],
        },
      ],
    });
  });

  it("propagates a failure from a later measurement page", async () => {
    const measurement = installSectionMocks();
    const failure = new Error("backup measurement page failed");
    mocks.iterateMeasurementPages.mockImplementation(async function* () {
      yield [measurement];
      throw failure;
    });

    await expect(
      buildFullBackupPayload(makePrisma() as never, "user-1", {
        purpose: "disaster-recovery",
      }),
    ).rejects.toBe(failure);
  });
});
