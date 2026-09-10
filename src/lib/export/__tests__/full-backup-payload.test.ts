import { describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { parseBackupPayload } from "@/lib/validations/backup";

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
import { restoreProfileData } from "../profile-backup";

const deletedAt = new Date("2026-07-19T12:00:00.000Z");
const measurementNote = encryptToBytes("canonical measurement note");
const sideEffectNote = encryptToBytes("nausea after the evening dose");
const doseChangeNote = encryptToBytes("titration note, encrypted at rest");
const inventoryNote = encryptToBytes("second pack, kept in the kitchen drawer");
const moodNotePlaintext = "quiet evening, slept badly";
const moodNote = encryptToBytes(moodNotePlaintext);

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
              // #219 — per-schedule units per dose (a half tablet at this slot).
              unitsPerDose: { toString: () => "0.5000" },
              doseWindows: [
                { timeOfDay: "08:00", start: "07:30", end: "09:00" },
              ],
            },
          ],
          sideEffects: [
            {
              id: "side-effect-canonical",
              occurredAt: new Date("2026-07-18T21:00:00.000Z"),
              category: "GI",
              entry: "NAUSEA",
              severity: 3,
              notes: null,
              notesEncrypted: sideEffectNote,
              createdAt: new Date("2026-07-18T21:05:00.000Z"),
            },
            {
              // A row the note backfill has not reached: plaintext only.
              id: "side-effect-legacy",
              occurredAt: new Date("2026-07-17T21:00:00.000Z"),
              category: "COGNITIVE",
              entry: "DIZZINESS",
              severity: 1,
              notes: "legacy plaintext note",
              notesEncrypted: null,
              createdAt: new Date("2026-07-17T21:05:00.000Z"),
            },
          ],
          // One closed era and one still running. The open one is why
          // `resumedAt` is nullable rather than absent: a reader treats null
          // as "paused right now" and runs the span to the present, so a
          // payload that dropped the distinction would report a resumption
          // that never happened.
          pauseEras: [
            {
              id: "pause-closed",
              pausedAt: new Date("2026-05-02T08:00:00.000Z"),
              resumedAt: new Date("2026-05-20T08:00:00.000Z"),
              createdAt: new Date("2026-05-02T08:01:00.000Z"),
            },
            {
              id: "pause-open",
              pausedAt: new Date("2026-07-15T08:00:00.000Z"),
              resumedAt: null,
              createdAt: new Date("2026-07-15T08:01:00.000Z"),
            },
          ],
          // A two-step ramp, one row carrying an encrypted note and one
          // without, so both arms of the note contract are exercised.
          doseChanges: [
            {
              id: "dose-ramp-up",
              effectiveFrom: new Date("2026-04-01T08:00:00.000Z"),
              doseValue: 5,
              doseUnit: "mg",
              note: null,
              noteEncrypted: doseChangeNote,
              createdAt: new Date("2026-04-01T08:01:00.000Z"),
            },
            {
              id: "dose-ramp-hold",
              effectiveFrom: new Date("2026-06-01T08:00:00.000Z"),
              doseValue: 10,
              doseUnit: "mg",
              note: null,
              noteEncrypted: null,
              createdAt: new Date("2026-06-01T08:01:00.000Z"),
            },
          ],
          // One open pack and one used up, so the state enum is exercised on
          // both arms, plus two ledger rows behind the open one.
          inventoryItems: [
            {
              id: "pack-open",
              state: "ACTIVE",
              containerType: "BLISTER",
              unitsTotal: { toString: () => "30.0000" },
              unitsRemaining: { toString: () => "21.0000" },
              firstUseAt: new Date("2026-07-01T08:00:00.000Z"),
              expiresAt: new Date("2027-01-31T00:00:00.000Z"),
              printedExpiry: null,
              purchasedAt: null,
              manufacturer: "Fixture Pharma",
              doseStrength: "10 mg",
              notes: null,
              notesEncrypted: inventoryNote,
              createdAt: new Date("2026-07-01T08:01:00.000Z"),
              updatedAt: new Date("2026-07-09T08:01:00.000Z"),
            },
          ],
          phaseConfig: {
            id: "phase-canonical",
            greenValue: 45,
            greenMode: "MINUTES",
            yellowValue: 20,
            yellowMode: "PERCENT",
            orangeValue: 5,
            orangeMode: "MINUTES",
            redValue: 180,
            redMode: "MINUTES",
          },
          // Two archived eras, the first corrected by the second. The
          // pointer is what makes this more than two rows: the payload has
          // to carry it as the SECOND era's position, not as its id.
          scheduleRevisions: [
            {
              id: "era-original",
              validFrom: new Date("2026-01-01T00:00:00.000Z"),
              validUntil: new Date("2026-03-01T00:00:00.000Z"),
              payload: [{ windowStart: "07:00", windowEnd: "09:00" }],
              source: "ARCHIVED",
              supersededByRevisionId: "era-correction",
              createdAt: new Date("2026-03-01T00:00:01.000Z"),
            },
            {
              id: "era-correction",
              validFrom: new Date("2026-03-01T00:00:00.000Z"),
              validUntil: new Date("2026-05-01T00:00:00.000Z"),
              payload: [{ windowStart: "08:00", windowEnd: "10:00" }],
              source: "MANUAL",
              supersededByRevisionId: null,
              createdAt: new Date("2026-05-02T00:00:01.000Z"),
            },
          ],
          // One pinned efficacy target, on the lab arm. The biomarker rides
          // as a NAME, the way a lab result's cross-reference does.
          efficacyTargets: [
            {
              id: "target-canonical",
              measurementType: null,
              biomarker: { name: "Ferritin" },
              primary: true,
              createdAt: new Date("2026-07-01T08:00:00.000Z"),
              updatedAt: new Date("2026-07-01T08:00:00.000Z"),
            },
          ],
          inventoryEvents: [
            {
              id: "stock-in",
              delta: 30,
              reason: "purchased",
              occurredAt: new Date("2026-07-01T07:00:00.000Z"),
            },
            {
              id: "stock-out",
              delta: -8,
              reason: "consumed",
              occurredAt: new Date("2026-07-09T07:00:00.000Z"),
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
    moodTag: { findMany: vi.fn().mockResolvedValue([]) },
    moodEntry: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "mood-tombstone",
          date: "2026-07-19",
          mood: "OKAY",
          score: 3,
          tags: null,
          note: null,
          noteEncrypted: moodNote,
          source: "MOODLOG",
          externalId: "moodlog-42",
          moodLoggedAt: new Date("2026-07-19T08:00:00.000Z"),
          tz: "America/New_York",
          syncedAt: new Date("2026-07-19T08:00:01.000Z"),
          syncVersion: 3,
          deletedAt,
          createdAt: new Date("2026-07-19T08:00:00.000Z"),
          updatedAt: new Date("2026-07-19T09:00:00.000Z"),
          tagLinks: [
            {
              rating: 4,
              moodTag: { key: "sleep_quality", kind: "RATED" },
            },
            {
              rating: null,
              moodTag: { key: "headache", kind: "BINARY" },
            },
          ],
        },
      ]),
    },
    nutrientIntakeDay: {
      findMany: vi.fn().mockResolvedValue([
        {
          day: "2026-07-19",
          nutrient: "water",
          amount: 1500,
          unit: "ml",
          source: "MANUAL",
        },
      ]),
    },
    intradayCumulativeProfile: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "shape-1",
          userId: "user-1",
          type: "ACTIVITY_STEPS",
          dateKey: "2026-07-18",
          hourlyCumulative: Array.from({ length: 24 }, (_, h) => h * 300),
          dayTotal: 6900,
          sampleCount: 96,
          timezone: "Europe/Berlin",
          createdAt: new Date("2026-07-19T02:00:00.000Z"),
          updatedAt: new Date("2026-07-19T02:00:00.000Z"),
        },
      ]),
    },
    healthScoreRecord: { findMany: vi.fn().mockResolvedValue([]) },
    onboardingRecord: { findUnique: vi.fn().mockResolvedValue(null) },
    // The visit tables. Empty here: this file asserts the sections it seeds,
    // and an account with no visits is the ordinary case the builder must
    // still answer for.
    practitioner: { findMany: vi.fn().mockResolvedValue([]) },
    encounter: { findMany: vi.fn().mockResolvedValue([]) },
    encounterDocumentLink: { findMany: vi.fn().mockResolvedValue([]) },
    encounterLabLink: { findMany: vi.fn().mockResolvedValue([]) },
    encounterConditionLink: { findMany: vi.fn().mockResolvedValue([]) },
    vaccinationRecord: { findMany: vi.fn().mockResolvedValue([]) },
    vaccinationDocumentLink: { findMany: vi.fn().mockResolvedValue([]) },
    // The reminder engine tables (v1.37.20, #223 / iOS #68). Empty for the
    // same reason as the visit tables above.
    measurementReminder: { findMany: vi.fn().mockResolvedValue([]) },
    measurementReminderEvent: { findMany: vi.fn().mockResolvedValue([]) },
    // The bests, the badges, and the environmental history with the location
    // periods that explain it. Empty for the same reason as the tables above.
    personalRecord: { findMany: vi.fn().mockResolvedValue([]) },
    userAchievement: { findMany: vi.fn().mockResolvedValue([]) },
    environmentContext: { findMany: vi.fn().mockResolvedValue([]) },
    environmentTravelLocation: { findMany: vi.fn().mockResolvedValue([]) },
    // The Coach transcript. Deliberately NOT `?? []` at the call site, so a
    // future `include` that forgets the relation fails here loudly instead of
    // exporting an account whose Coach never spoke.
    coachConversation: { findMany: vi.fn().mockResolvedValue([]) },
    moodTagCategory: { findMany: vi.fn().mockResolvedValue([]) },
    moodTagHidden: { findMany: vi.fn().mockResolvedValue([]) },
    mentalHealthAssessment: { findMany: vi.fn().mockResolvedValue([]) },
    consentReceipt: { findMany: vi.fn().mockResolvedValue([]) },
    coachFact: { findMany: vi.fn().mockResolvedValue([]) },
    coachPlan: { findMany: vi.fn().mockResolvedValue([]) },
    coachReminder: { findMany: vi.fn().mockResolvedValue([]) },
    // What a document was filed against, and what was read out of it.
    // Empty for the same reason as the sections above.
    documentConditionLink: { findMany: vi.fn().mockResolvedValue([]) },
    extractedFact: { findMany: vi.fn().mockResolvedValue([]) },
    // The ECG strips. Empty for the same reason as the sections above:
    // an account whose watch has never taken one is the ordinary case the
    // builder must still answer for.
    ecgRecording: { findMany: vi.fn().mockResolvedValue([]) },
    // Left unmocked on purpose: `buildProfileBackupSection` runs for real
    // against these, so the assertions below exercise the builder rather than
    // a stand-in that would agree with whatever the payload happened to do.
    userHealthProfile: {
      findUnique: vi.fn().mockResolvedValue({
        id: "profile-1",
        userId: "user-1",
        aboutMeEncrypted: encryptToBytes("desk job, two kids"),
        conditionsEncrypted: null,
        allergiesEncrypted: encryptToBytes("penicillin"),
        coachFocusEncrypted: null,
        pendingQuestionsEncrypted: encryptToBytes('["How is your sleep?"]'),
        aiIncludedSections: ["ABOUT_ME", "CONDITIONS"],
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        updatedAt: new Date("2026-07-19T00:00:00.000Z"),
      }),
    },
    healthProfileFactRevision: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "fact-1",
          userId: "user-1",
          kind: "SMOKING_STATUS",
          valueEncrypted: encryptToBytes("FORMER"),
          validFrom: new Date("2026-07-01T00:00:00.000Z"),
          validUntil: null,
          provenance: "USER_REPORTED",
          supersededByRevisionId: null,
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ]),
    },
    customMetric: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "metric-1",
          userId: "user-1",
          name: "Morning grip strength",
          unit: "kg",
          targetLow: 40,
          targetHigh: null,
          decimals: 1,
          description: "Right hand, before breakfast",
          correlationEnabled: true,
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
          updatedAt: new Date("2026-07-19T00:00:00.000Z"),
          deletedAt: null,
          entries: [
            {
              id: "entry-1",
              value: 44.5,
              unit: "kg",
              measuredAt: new Date("2026-07-19T06:30:00.000Z"),
              note: "felt strong",
              createdAt: new Date("2026-07-19T06:31:00.000Z"),
            },
          ],
        },
      ]),
    },
    correlationPattern: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "pattern-1",
          userId: "user-1",
          canonicalKey: `p1:${"a".repeat(64)}`,
          family: "DISCOVERY_RETROSPECTIVE",
          factorKey: "CUSTOM_METRIC:metric-1",
          outcomeKey: "RESTING_HEART_RATE",
          lagDays: 1,
          sampleSize: 42,
          effectSize: 0.34,
          pValue: 0.01,
          qValue: 0.04,
          evidenceHash: "b".repeat(64),
          isCurrent: true,
          lastComputedAt: new Date("2026-07-19T08:00:00.000Z"),
          dismissedAt: new Date("2026-07-19T09:00:00.000Z"),
          dismissedEvidenceHash: "b".repeat(64),
          dismissedEffectSize: 0.34,
          dismissedSampleSize: 42,
          createdAt: new Date("2026-07-19T08:00:00.000Z"),
          updatedAt: new Date("2026-07-19T09:00:00.000Z"),
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
    aggregationProvenance: "HEALTHKIT_STATISTICS",
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
    // The key the payload assembly used to drop on the floor.
    customSymptoms: [
      {
        id: "symptom-1",
        key: "custom:jaw_tension",
        labelKey: "custom",
        categoryId: "cat-1",
        icon: null,
        sortOrder: 0,
        isActive: true,
        labelEncrypted: "Y2lwaGVy",
      },
    ],
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
        select: expect.objectContaining({
          id: true,
          noteEncrypted: true,
          tz: true,
          syncVersion: true,
          deletedAt: true,
        }),
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
          aggregationProvenance: "HEALTHKIT_STATISTICS",
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
              // #219 — Decimal → string, round-tripped through the DR payload.
              unitsPerDose: "0.5000",
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
          tz: "America/New_York",
          syncedAt: "2026-07-19T08:00:01.000Z",
          syncVersion: 3,
          createdAt: "2026-07-19T08:00:00.000Z",
          updatedAt: "2026-07-19T09:00:00.000Z",
          note: null,
          noteEncrypted: Buffer.from(moodNote).toString("base64"),
          factors: [{ key: "sleep_quality", rating: 4 }],
          // The BINARY link the old `rating: { not: null }` filter excluded.
          structuredTags: ["headache"],
        },
      ],
      nutrientDays: [
        {
          day: "2026-07-19",
          nutrient: "water",
          amount: 1500,
          unit: "ml",
          source: "MANUAL",
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

/**
 * Side effects ride inside their medication, and the note rides with them.
 *
 * The two shapes differ on purpose: a portable export is the human-readable
 * artefact, so it carries the DECRYPTED note and no ciphertext at all; the
 * disaster-recovery file carries the ciphertext verbatim so the same instance's
 * key reads it back unchanged. Both are asserted, because emitting ciphertext
 * into a portable export and losing the note are opposite failures of the same
 * decision.
 */
describe("buildFullBackupPayload — medication side effects", () => {
  it("decrypts the note and emits no ciphertext in a portable export", async () => {
    installSectionMocks();

    const { payload, counts } = await buildFullBackupPayload(
      makePrisma() as never,
      "user-1",
      {
        purpose: "portable-export",
        exportedAt: new Date("2026-07-20T00:00:00.000Z"),
      },
    );
    const parsed = parseBackupPayload(payload);

    expect(parsed.medications[0].sideEffects).toEqual([
      {
        occurredAt: "2026-07-18T21:00:00.000Z",
        category: "GI",
        entry: "NAUSEA",
        severity: 3,
        notes: "nausea after the evening dose",
      },
      {
        occurredAt: "2026-07-17T21:00:00.000Z",
        category: "COGNITIVE",
        entry: "DIZZINESS",
        severity: 1,
        notes: "legacy plaintext note",
      },
    ]);
    expect(JSON.stringify(payload)).not.toContain(
      Buffer.from(sideEffectNote).toString("base64"),
    );
    expect(counts.medicationSideEffects).toBe(2);
  });

  it("carries the ciphertext verbatim in a disaster-recovery payload", async () => {
    installSectionMocks();

    const { payload } = await buildFullBackupPayload(
      makePrisma() as never,
      "user-1",
      {
        purpose: "disaster-recovery",
        exportedAt: new Date("2026-07-20T00:00:00.000Z"),
      },
    );
    const parsed = parseBackupPayload(payload);

    expect(parsed.medications[0].sideEffects).toEqual([
      {
        id: "side-effect-canonical",
        occurredAt: "2026-07-18T21:00:00.000Z",
        category: "GI",
        entry: "NAUSEA",
        severity: 3,
        notes: null,
        notesEncrypted: Buffer.from(sideEffectNote).toString("base64"),
        createdAt: "2026-07-18T21:05:00.000Z",
      },
      {
        id: "side-effect-legacy",
        occurredAt: "2026-07-17T21:00:00.000Z",
        category: "COGNITIVE",
        entry: "DIZZINESS",
        severity: 1,
        notes: "legacy plaintext note",
        notesEncrypted: null,
        createdAt: "2026-07-17T21:05:00.000Z",
      },
    ]);
  });
});

/**
 * `aggregationProvenance` is what stops an export.xml source-day estimate from
 * overwriting a native HealthKit statistic. A disaster-recovery backup that
 * drops it restores a flattened authority ladder, so it rides the select and
 * the disaster-recovery serialization the same way `externalSourceVersion`
 * does — and stays out of the reduced portable shape, also like
 * `externalSourceVersion`.
 *
 * Mutation check: drop `aggregationProvenance: true` from the select, or drop
 * the field from the disaster-recovery arm, and the first two cases go red.
 */
describe("buildFullBackupPayload — aggregation provenance", () => {
  it("selects the provenance column", async () => {
    installSectionMocks();
    const prisma = makePrisma();

    await buildFullBackupPayload(prisma as never, "user-1", {
      purpose: "disaster-recovery",
      exportedAt: new Date("2026-07-20T00:00:00.000Z"),
    });

    expect(mocks.iterateMeasurementPages).toHaveBeenCalledWith(
      prisma,
      expect.anything(),
      expect.objectContaining({ aggregationProvenance: true }),
    );
  });

  it("carries the provenance into the disaster-recovery payload", async () => {
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

    const rows = payload.measurements as Array<Record<string, unknown>>;
    expect(rows[0]).toHaveProperty(
      "aggregationProvenance",
      "HEALTHKIT_STATISTICS",
    );
  });

  it("leaves the provenance out of the reduced portable shape", async () => {
    installSectionMocks();
    const prisma = makePrisma();

    const { payload } = await buildFullBackupPayload(
      prisma as never,
      "user-1",
      {
        purpose: "portable-export",
        exportedAt: new Date("2026-07-20T00:00:00.000Z"),
      },
    );

    const rows = payload.measurements as Array<Record<string, unknown>>;
    // The portable arm carries the human-readable subset only — no
    // externalSourceVersion, no glucoseContext, and no provenance either.
    expect(rows[0]).not.toHaveProperty("aggregationProvenance");
    expect(rows[0]).not.toHaveProperty("externalSourceVersion");
  });
});

/**
 * The assembly step must carry EVERY key its sections produce.
 *
 * The custom cycle symptoms were lost here and nowhere else: the section
 * builder returned them, the wire schema declared them, the restore read them,
 * and the payload was assembled by copying keys out one at a time. Nothing in
 * the tree compared the two lists, so the omission survived a release that was
 * specifically about that data.
 *
 * Mutation check: hand-pick the cycle keys again instead of spreading the
 * section, and this goes red naming the key that fell out.
 */
describe("buildFullBackupPayload — section keys reach the payload", () => {
  it("carries every key of every section it builds", async () => {
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

    const sectionKeys = [
      ...Object.keys(await mocks.buildCycleBackupSection.mock.results[0].value),
      ...Object.keys(
        await mocks.buildRecordsBackupSection.mock.results[0].value,
      ),
      // The profile and intraday sections run for real, so their keys come
      // from the builders.
      "healthProfile",
      "healthProfileFacts",
      "customMetrics",
      "correlationPatterns",
      "intradayProfiles",
    ];

    const missing = sectionKeys.filter((key) => !(key in payload));
    expect(
      missing,
      "a section key that never reaches the payload is data the file does not carry, however complete the builder is",
    ).toEqual([]);
  });

  it("carries the account's own cycle symptoms", async () => {
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

    expect(payload.customSymptoms).toEqual([
      expect.objectContaining({
        key: "custom:jaw_tension",
        labelEncrypted: "Y2lwaGVy",
      }),
    ]);
  });
});

/**
 * Durable self-context and user-defined metrics ride the file.
 *
 * Both were classified `BACKED_UP` and carried by nothing. The custom metric is
 * the live loss: a series the account defined itself is the one kind no
 * integration can re-sync, so a restore without it rebuilt the account minus
 * the metric AND every reading, and reported success.
 */
describe("buildFullBackupPayload — profile and custom metrics", () => {
  it("carries ciphertext verbatim and no plaintext in the recovery payload", async () => {
    installSectionMocks();
    const prisma = makePrisma();

    const { payload, counts } = await buildFullBackupPayload(
      prisma as never,
      "user-1",
      {
        purpose: "disaster-recovery",
        exportedAt: new Date("2026-07-20T00:00:00.000Z"),
      },
    );

    const profile = payload.healthProfile as Record<string, unknown>;
    expect(profile.id).toBe("profile-1");
    // The envelope travels; the plaintext of a column carried encrypted must
    // not be duplicated beside it.
    expect(typeof profile.aboutMeEncrypted).toBe("string");
    expect(profile.aboutMe).toBeNull();
    expect(profile.conditionsEncrypted).toBeNull();
    expect(typeof profile.pendingQuestionsEncrypted).toBe("string");
    expect(counts.healthProfile).toBe(1);
    expect(payload.healthProfileFacts).toEqual([
      expect.objectContaining({
        id: "fact-1",
        kind: "SMOKING_STATUS",
        value: null,
        valueEncrypted: expect.any(String),
      }),
    ]);
    expect(counts.healthProfileFactRevisions).toBe(1);
  });

  it("decrypts the profile free text into the portable export", async () => {
    installSectionMocks();
    const prisma = makePrisma();

    const { payload } = await buildFullBackupPayload(
      prisma as never,
      "user-1",
      {
        purpose: "portable-export",
        exportedAt: new Date("2026-07-20T00:00:00.000Z"),
      },
    );

    const profile = payload.healthProfile as Record<string, unknown>;
    expect(profile.aboutMe).toBe("desk job, two kids");
    expect(profile.allergies).toBe("penicillin");
    expect(profile.conditions).toBeNull();
    expect(payload.healthProfileFacts).toEqual([
      expect.objectContaining({
        id: "fact-1",
        kind: "SMOKING_STATUS",
        value: "FORMER",
      }),
    ]);
    // A portable file is the human-readable artefact; it carries no envelopes,
    // and it does not carry the server-derived pending questions at all.
    expect(profile).not.toHaveProperty("aboutMeEncrypted");
    expect(profile).not.toHaveProperty("pendingQuestionsEncrypted");
    expect(profile).not.toHaveProperty("id");
  });

  it("preserves readable fact segments around unreadable and invalid revisions", async () => {
    installSectionMocks();
    const prisma = makePrisma();
    const unreadableCiphertext = Uint8Array.from([0, 1, 2, 3]);
    prisma.healthProfileFactRevision.findMany.mockResolvedValue([
      {
        id: "alcohol-old",
        userId: "user-1",
        kind: "ALCOHOL_PATTERN",
        valueEncrypted: encryptToBytes("WEEKLY"),
        validFrom: new Date("2026-04-01T00:00:00.000Z"),
        validUntil: new Date("2026-05-01T00:00:00.000Z"),
        provenance: "USER_REPORTED",
        supersededByRevisionId: "alcohol-unreadable",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        id: "alcohol-unreadable",
        userId: "user-1",
        kind: "ALCOHOL_PATTERN",
        valueEncrypted: unreadableCiphertext,
        validFrom: new Date("2026-05-01T00:00:00.000Z"),
        validUntil: null,
        provenance: "USER_CORRECTION",
        supersededByRevisionId: null,
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
      },
      {
        id: "smoking-old",
        userId: "user-1",
        kind: "SMOKING_STATUS",
        valueEncrypted: encryptToBytes("CURRENT"),
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validUntil: new Date("2026-02-01T00:00:00.000Z"),
        provenance: "USER_REPORTED",
        supersededByRevisionId: "smoking-unreadable",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: "smoking-unreadable",
        userId: "user-1",
        kind: "SMOKING_STATUS",
        valueEncrypted: unreadableCiphertext,
        validFrom: new Date("2026-02-01T00:00:00.000Z"),
        validUntil: new Date("2026-03-01T00:00:00.000Z"),
        provenance: "USER_CORRECTION",
        supersededByRevisionId: "smoking-invalid",
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      },
      {
        id: "smoking-invalid",
        userId: "user-1",
        kind: "SMOKING_STATUS",
        valueEncrypted: encryptToBytes("INVALID_SMOKING_STATUS"),
        validFrom: new Date("2026-03-01T00:00:00.000Z"),
        validUntil: new Date("2026-04-01T00:00:00.000Z"),
        provenance: "USER_CORRECTION",
        supersededByRevisionId: "smoking-current",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      },
      {
        id: "smoking-current",
        userId: "user-1",
        kind: "SMOKING_STATUS",
        valueEncrypted: encryptToBytes("NEVER"),
        validFrom: new Date("2026-04-01T00:00:00.000Z"),
        validUntil: null,
        provenance: "USER_CORRECTION",
        supersededByRevisionId: null,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);

    const portable = await buildFullBackupPayload(prisma as never, "user-1", {
      purpose: "portable-export",
      exportedAt: new Date("2026-07-20T00:00:00.000Z"),
    });
    const parsedPortable = parseBackupPayload(portable.payload);
    expect(parsedPortable.healthProfileFacts).toEqual([
      expect.objectContaining({
        id: "alcohol-old",
        supersededByRevisionId: null,
      }),
      expect.objectContaining({
        id: "smoking-old",
        supersededByRevisionId: null,
      }),
      expect.objectContaining({
        id: "smoking-current",
        supersededByRevisionId: null,
      }),
    ]);
    expect(
      parsedPortable.healthProfileFacts.map((fact) => fact.id),
    ).not.toContain("smoking-invalid");
    expect(portable.counts.healthProfileFactRevisions).toBe(3);

    const restoredFacts: Array<Record<string, unknown>> = [];
    const factDelegate = {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        restoredFacts.push(data);
        return data;
      }),
      update: vi.fn().mockResolvedValue({}),
    };
    const emptyDelegate = {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findUnique: vi.fn().mockResolvedValue(null),
    };
    const userDelegate = { update: vi.fn().mockResolvedValue({}) };
    await restoreProfileData(
      {
        healthProfileFactRevision: factDelegate,
        userHealthProfile: emptyDelegate,
        customMetric: emptyDelegate,
        correlationPattern: emptyDelegate,
        user: userDelegate,
      } as never,
      "restored-user",
      {
        healthProfile: null,
        healthProfileFacts: parsedPortable.healthProfileFacts,
        customMetrics: [],
        correlationPatterns: [],
      },
    );
    expect(factDelegate.create).toHaveBeenCalledTimes(3);
    expect(factDelegate.update).not.toHaveBeenCalled();

    const recovery = await buildFullBackupPayload(prisma as never, "user-1", {
      purpose: "disaster-recovery",
      exportedAt: new Date("2026-07-20T00:00:00.000Z"),
    });
    const parsedRecovery = parseBackupPayload(recovery.payload);
    expect(parsedRecovery.healthProfileFacts).toHaveLength(6);
    for (const id of ["alcohol-unreadable", "smoking-unreadable"]) {
      const envelope = parsedRecovery.healthProfileFacts.find(
        (fact) => fact.id === id,
      )?.valueEncrypted;
      expect(Buffer.from(envelope!, "base64")).toEqual(
        Buffer.from(unreadableCiphertext),
      );
    }
    expect(recovery.counts.healthProfileFactRevisions).toBe(6);

    prisma.healthProfileFactRevision.findMany.mockResolvedValue(
      restoredFacts as never,
    );
    const roundTripped = await buildFullBackupPayload(
      prisma as never,
      "restored-user",
      {
        purpose: "portable-export",
        exportedAt: new Date("2026-07-21T00:00:00.000Z"),
      },
    );
    expect(parseBackupPayload(roundTripped.payload).healthProfileFacts).toEqual(
      parsedPortable.healthProfileFacts,
    );
  });

  it("preserves and restores a readable closed terminal fact revision", async () => {
    installSectionMocks();
    const prisma = makePrisma();
    prisma.healthProfileFactRevision.findMany.mockResolvedValue([
      {
        id: "shift-old",
        userId: "user-1",
        kind: "SHIFT_SCHEDULE",
        valueEncrypted: encryptToBytes("FIXED_SHIFT"),
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validUntil: new Date("2026-02-01T00:00:00.000Z"),
        provenance: "USER_REPORTED",
        supersededByRevisionId: "shift-closed",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: "shift-closed",
        userId: "user-1",
        kind: "SHIFT_SCHEDULE",
        valueEncrypted: encryptToBytes("ROTATING"),
        validFrom: new Date("2026-02-01T00:00:00.000Z"),
        validUntil: new Date("2026-03-01T00:00:00.000Z"),
        provenance: "USER_CORRECTION",
        supersededByRevisionId: null,
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    ]);

    const portable = await buildFullBackupPayload(prisma as never, "user-1", {
      purpose: "portable-export",
      exportedAt: new Date("2026-07-20T00:00:00.000Z"),
    });
    const parsedPortable = parseBackupPayload(portable.payload);
    expect(parsedPortable.healthProfileFacts).toEqual([
      expect.objectContaining({
        id: "shift-old",
        supersededByRevisionId: "shift-closed",
      }),
      expect.objectContaining({
        id: "shift-closed",
        validUntil: "2026-03-01T00:00:00.000Z",
        supersededByRevisionId: null,
      }),
    ]);

    const factDelegate = {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    };
    const emptyDelegate = {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findUnique: vi.fn().mockResolvedValue(null),
    };
    const userDelegate = { update: vi.fn().mockResolvedValue({}) };
    await restoreProfileData(
      {
        healthProfileFactRevision: factDelegate,
        userHealthProfile: emptyDelegate,
        customMetric: emptyDelegate,
        correlationPattern: emptyDelegate,
        user: userDelegate,
      } as never,
      "restored-user",
      {
        healthProfile: null,
        healthProfileFacts: parsedPortable.healthProfileFacts,
        customMetrics: [],
        correlationPatterns: [],
      },
    );
    expect(factDelegate.create).toHaveBeenCalledTimes(2);
    expect(factDelegate.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: "shift-old" },
      data: { supersededByRevisionId: "shift-closed" },
    });
  });

  it("carries each metric with its readings nested inside it", async () => {
    installSectionMocks();
    const prisma = makePrisma();

    const { payload, counts } = await buildFullBackupPayload(
      prisma as never,
      "user-1",
      {
        purpose: "disaster-recovery",
        exportedAt: new Date("2026-07-20T00:00:00.000Z"),
      },
    );

    expect(payload.customMetrics).toEqual([
      expect.objectContaining({
        id: "metric-1",
        name: "Morning grip strength",
        unit: "kg",
        targetLow: 40,
        targetHigh: null,
        decimals: 1,
        description: "Right hand, before breakfast",
        correlationEnabled: true,
        deletedAt: null,
        entries: [
          expect.objectContaining({
            id: "entry-1",
            value: 44.5,
            unit: "kg",
            measuredAt: "2026-07-19T06:30:00.000Z",
            note: "felt strong",
          }),
        ],
      }),
    ]);
    expect(counts.customMetrics).toBe(1);
    expect(counts.customMetricEntries).toBe(1);
    expect(payload.correlationPatterns).toEqual([
      expect.objectContaining({
        id: "pattern-1",
        canonicalKey: `p1:${"a".repeat(64)}`,
        factorKey: "CUSTOM_METRIC:metric-1",
        outcomeKey: "RESTING_HEART_RATE",
        dismissedAt: "2026-07-19T09:00:00.000Z",
        dismissedEvidenceHash: "b".repeat(64),
      }),
    ]);
    expect(counts.correlationPatterns).toBe(1);
  });

  it("excludes deleted metrics from a portable export", async () => {
    installSectionMocks();
    const prisma = makePrisma();

    await buildFullBackupPayload(prisma as never, "user-1", {
      purpose: "portable-export",
      exportedAt: new Date("2026-07-20T00:00:00.000Z"),
    });

    expect(prisma.customMetric.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", deletedAt: null },
      }),
    );
  });

  it("carries the day curve hour by hour, with its count", async () => {
    installSectionMocks();
    const prisma = makePrisma();

    const { payload, counts } = await buildFullBackupPayload(
      prisma as never,
      "user-1",
      {
        purpose: "disaster-recovery",
        exportedAt: new Date("2026-07-20T00:00:00.000Z"),
      },
    );

    // Rebuilding the curve from `dayTotal` would produce a plausible ramp that
    // describes no day that happened, so the whole array is asserted.
    expect(payload.intradayProfiles).toEqual([
      expect.objectContaining({
        id: "shape-1",
        type: "ACTIVITY_STEPS",
        dateKey: "2026-07-18",
        hourlyCumulative: Array.from({ length: 24 }, (_, h) => h * 300),
        dayTotal: 6900,
        sampleCount: 96,
        timezone: "Europe/Berlin",
      }),
    ]);
    expect(counts.intradayProfiles).toBe(1);
  });
});

describe("buildFullBackupPayload — mood arms", () => {
  it("carries the ciphertext and the whole row on the disaster-recovery arm", async () => {
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

    const [entry] = (payload as { moodEntries: Array<Record<string, unknown>> })
      .moodEntries;
    expect(entry).toEqual(
      expect.objectContaining({
        id: "mood-tombstone",
        note: null,
        noteEncrypted: Buffer.from(moodNote).toString("base64"),
        tz: "America/New_York",
        syncedAt: "2026-07-19T08:00:01.000Z",
        syncVersion: 3,
        createdAt: "2026-07-19T08:00:00.000Z",
        updatedAt: "2026-07-19T09:00:00.000Z",
        deletedAt: deletedAt.toISOString(),
        factors: [{ key: "sleep_quality", rating: 4 }],
        structuredTags: ["headache"],
      }),
    );
  });

  it("carries the readable note and no ciphertext on the portable arm", async () => {
    installSectionMocks();
    const prisma = makePrisma();

    const { payload } = await buildFullBackupPayload(
      prisma as never,
      "user-1",
      {
        purpose: "portable-export",
        exportedAt: new Date("2026-07-20T00:00:00.000Z"),
      },
    );

    const [entry] = (payload as { moodEntries: Array<Record<string, unknown>> })
      .moodEntries;
    // Same split the measurement arm makes: the readable artefact carries the
    // decrypted text and nothing an operator could not read, and the counters
    // that only mean something to this instance stay behind.
    expect(entry).toEqual(
      expect.objectContaining({
        note: moodNotePlaintext,
        tz: "America/New_York",
        structuredTags: ["headache"],
      }),
    );
    expect(entry).not.toHaveProperty("noteEncrypted");
    expect(entry).not.toHaveProperty("syncVersion");
    expect(entry).not.toHaveProperty("syncedAt");
    expect(JSON.stringify(entry)).not.toContain(
      Buffer.from(moodNote).toString("base64"),
    );
    // The tag-link read is unfiltered on both arms; a BINARY link is the one
    // most people have and it was the one the file never carried.
    expect(prisma.moodEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          tagLinks: { select: expect.any(Object) },
        }),
      }),
    );
  });
});
