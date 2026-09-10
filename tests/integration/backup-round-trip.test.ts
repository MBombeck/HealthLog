/**
 * Every model the plan claims travels both ways, proven by making it travel.
 *
 * `src/__tests__/backup-plan-classification.test.ts` reads source text. That
 * catches a reader or a restore branch that was never written, and it is cheap
 * enough to run on every `pnpm test` — but it cannot tell a branch that RUNS
 * from one that merely exists. Verified rather than assumed: wrapping the
 * nutrient restore in `if (false && …)` left all twelve of its checks green.
 * Correct, green, and inert in production is the failure mode this repository
 * has already shipped once, so the claim needs an end-to-end answer as well.
 *
 * This is that answer, and it is deliberately the LONG way round:
 *
 *   1. Seed one row of every model in `TWO_ENDED_MODELS` for one account.
 *   2. Export through the real `buildFullBackupPayload`, disaster-recovery
 *      purpose — the same builder both export routes and the weekly worker use.
 *   3. Delete the account. Not a hand-listed `deleteMany` sweep, which can only
 *      empty the tables somebody remembered: `user.delete()` cascades, so what
 *      survives is exactly what the schema says survives. A model that is
 *      neither wiped nor restored would otherwise be counted as recovered on
 *      the strength of the row that was never removed.
 *   4. Re-create the account under the same id and restore through the real
 *      `POST /api/admin/backups/[id]/restore`.
 *   5. Count each model back. Zero means the account came back short.
 *
 * The registry below is keyed by `TwoEndedModel`, so a name added to the plan's
 * two-ended list without a row seeded and counted here does not compile.
 *
 * What the count-back alone does not prove: that a restored row carries the
 * right VALUES. It asks whether the rows came back, not whether they came back
 * intact — `admin-backups-canonical-roundtrip.test.ts` is where field-level
 * fidelity is asserted for the file as a whole. A restore that wrote one row
 * per model with every column defaulted would satisfy the counts and fail that
 * one.
 *
 * So each section added since has brought a field-level assertion of its own
 * for the column whose loss the count cannot see: the side effect's encrypted
 * note beside its legacy plaintext one, the open pause era's null `resumedAt`,
 * the Coach's permanent fence flag and its two bare-id references, the stock
 * count that must not be recalculated from its ledger, the dose ramp's order,
 * the reminder's snooze and skip cursors — and, at the bottom of this file, the
 * document filing's PAIRING and the review decision on a staged fact. Each one
 * is a thing a restore could get wrong while returning the right number of
 * rows, which is the only test worth writing here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import type { PrismaClient } from "@/generated/prisma/client";
import { encrypt, encryptBytes } from "@/lib/crypto";
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { readNote } from "@/lib/crypto/note-cipher";
import {
  decryptFactData,
  decryptFactProvenance,
  encryptFactData,
  encryptFactProvenance,
} from "@/lib/documents/store";
import {
  decryptWaveformFromBytes,
  encryptWaveformToBytes,
} from "@/lib/withings/ecg-waveform-codec";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { UNREADABLE_EXPORT_MARKER } from "@/lib/export/unreadable-marker";
import { decryptNoteFromBytes } from "@/lib/labs/store";
import { decryptContextFromBytes } from "@/lib/labs/biomarker-store";
import { packBackupBlobStreaming } from "@/lib/export/backup-blob";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";
import { TWO_ENDED_MODELS, type TwoEndedModel } from "@/lib/export/backup-plan";
import { POST } from "@/app/api/admin/backups/[id]/restore/route";

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

const OWNER_ID = "round-trip-owner";
const AT = (iso: string) => new Date(iso);
const PHQ9_RESPONSES = JSON.stringify({
  items: [2, 1, 2, 2, 1, 1, 2, 1, 2],
  schema: 1,
});
const CONSENT_ARTEFACT = "JVBERi0xLjQKJWZpeHR1cmU=";
const INVENTORY_NOTE = "second pack, kept in the kitchen drawer";
const COACH_FACT = "does not tolerate ACE inhibitors";
const COACH_PLAN_CUE = "if the evening reading is over 140";
const COACH_PLAN_ACTION = "then walk twenty minutes before dinner tomorrow";
const COACH_REMINDER_NOTE = "ask how the evening walks are going";
const COACH_SUMMARY = "earlier turns: weight trend and evening walks";
const COACH_USER_TURN = "my readings look higher this week, is that real?";
const COACH_ASSISTANT_TURN =
  "the last seven mornings average 4 mmHg above the fortnight before";
const DOSE_CHANGE_NOTE = "titration note, encrypted at rest";
const EXTRACTED_FACT_SPAN = "Ferritin  91 ng/mL   (30 - 400)";
const SIDE_EFFECT_NOTE = "nausea for two hours after the evening dose";
/** A short micro-volt strip. Long enough that a defaulted empty array shows. */
const ECG_SAMPLES = [-12, 4, 118, -33, 7, 2, -5, 61];

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

/** Counts what belongs to `userId`, following the relation where there is no own column. */
const COUNT_BACK: Record<
  TwoEndedModel,
  (prisma: PrismaClient, userId: string) => Promise<number>
> = {
  Measurement: (p, userId) => p.measurement.count({ where: { userId } }),
  IntradayCumulativeProfile: (p, userId) =>
    p.intradayCumulativeProfile.count({ where: { userId } }),
  Medication: (p, userId) => p.medication.count({ where: { userId } }),
  MedicationSchedule: (p, userId) =>
    p.medicationSchedule.count({ where: { medication: { userId } } }),
  MedicationIntakeEvent: (p, userId) =>
    p.medicationIntakeEvent.count({ where: { userId } }),
  MedicationSideEffect: (p, userId) =>
    p.medicationSideEffect.count({ where: { userId } }),
  MedicationPauseEra: (p, userId) =>
    p.medicationPauseEra.count({ where: { userId } }),
  // No own `userId` column — reached through the drug, like the schedules.
  MedicationDoseChange: (p, userId) =>
    p.medicationDoseChange.count({ where: { medication: { userId } } }),
  MoodEntry: (p, userId) => p.moodEntry.count({ where: { userId } }),
  MoodContext: (p, userId) => p.moodContext.count({ where: { userId } }),
  MoodEntryTagLink: (p, userId) =>
    p.moodEntryTagLink.count({ where: { moodEntry: { userId } } }),
  MoodTag: (p, userId) => p.moodTag.count({ where: { userId } }),
  LabResult: (p, userId) => p.labResult.count({ where: { userId } }),
  Biomarker: (p, userId) => p.biomarker.count({ where: { userId } }),
  Allergy: (p, userId) => p.allergy.count({ where: { userId } }),
  FamilyHistoryEntry: (p, userId) =>
    p.familyHistoryEntry.count({ where: { userId } }),
  IllnessEpisode: (p, userId) => p.illnessEpisode.count({ where: { userId } }),
  IllnessDayLog: (p, userId) => p.illnessDayLog.count({ where: { userId } }),
  IllnessSymptomLink: (p, userId) =>
    p.illnessSymptomLink.count({ where: { dayLog: { userId } } }),
  UserHealthProfile: (p, userId) =>
    p.userHealthProfile.count({ where: { userId } }),
  HealthProfileFactRevision: (p, userId) =>
    p.healthProfileFactRevision.count({ where: { userId } }),
  CycleProfile: (p, userId) => p.cycleProfile.count({ where: { userId } }),
  MenstrualCycle: (p, userId) => p.menstrualCycle.count({ where: { userId } }),
  CycleDayLog: (p, userId) => p.cycleDayLog.count({ where: { userId } }),
  CycleSymptom: (p, userId) => p.cycleSymptom.count({ where: { userId } }),
  CycleSymptomLink: (p, userId) =>
    p.cycleSymptomLink.count({ where: { dayLog: { userId } } }),
  CustomMetric: (p, userId) => p.customMetric.count({ where: { userId } }),
  CustomMetricEntry: (p, userId) =>
    p.customMetricEntry.count({ where: { userId } }),
  CorrelationPattern: (p, userId) =>
    p.correlationPattern.count({ where: { userId } }),
  HealthScoreRecord: (p, userId) =>
    p.healthScoreRecord.count({ where: { userId } }),
  Workout: (p, userId) => p.workout.count({ where: { userId } }),
  NutrientIntakeDay: (p, userId) =>
    p.nutrientIntakeDay.count({ where: { userId } }),
  InboundDocument: (p, userId) =>
    p.inboundDocument.count({ where: { userId } }),
  Practitioner: (p, userId) => p.practitioner.count({ where: { userId } }),
  Encounter: (p, userId) => p.encounter.count({ where: { userId } }),
  EncounterDocumentLink: (p, userId) =>
    p.encounterDocumentLink.count({ where: { userId } }),
  EncounterLabLink: (p, userId) =>
    p.encounterLabLink.count({ where: { userId } }),
  EncounterConditionLink: (p, userId) =>
    p.encounterConditionLink.count({ where: { userId } }),
  VaccinationRecord: (p, userId) =>
    p.vaccinationRecord.count({ where: { userId } }),
  VaccinationDocumentLink: (p, userId) =>
    p.vaccinationDocumentLink.count({ where: { userId } }),
  MeasurementReminder: (p, userId) =>
    p.measurementReminder.count({ where: { userId } }),
  MeasurementReminderEvent: (p, userId) =>
    p.measurementReminderEvent.count({ where: { userId } }),
  CoachConversation: (p, userId) =>
    p.coachConversation.count({ where: { userId } }),
  // Neither the turn nor the attachment carries its own `userId` — both are
  // reached through the thread that holds them.
  CoachMessage: (p, userId) =>
    p.coachMessage.count({ where: { conversation: { userId } } }),
  CoachConversationDocument: (p, userId) =>
    p.coachConversationDocument.count({ where: { conversation: { userId } } }),
  CoachFact: (p, userId) => p.coachFact.count({ where: { userId } }),
  CoachPlan: (p, userId) => p.coachPlan.count({ where: { userId } }),
  CoachReminder: (p, userId) => p.coachReminder.count({ where: { userId } }),
  MedicationInventoryItem: (p, userId) =>
    p.medicationInventoryItem.count({ where: { userId } }),
  // No own `userId` column — reached through the drug, like the schedules.
  MedicationInventoryEvent: (p, userId) =>
    p.medicationInventoryEvent.count({ where: { medication: { userId } } }),
  MoodTagCategory: (p, userId) =>
    p.moodTagCategory.count({ where: { userId } }),
  MoodTagHidden: (p, userId) => p.moodTagHidden.count({ where: { userId } }),
  ReminderPhaseConfig: (p, userId) =>
    p.reminderPhaseConfig.count({ where: { medication: { userId } } }),
  MentalHealthAssessment: (p, userId) =>
    p.mentalHealthAssessment.count({ where: { userId } }),
  ConsentReceipt: (p, userId) => p.consentReceipt.count({ where: { userId } }),
  DocumentConditionLink: (p, userId) =>
    p.documentConditionLink.count({ where: { userId } }),
  ExtractedFact: (p, userId) => p.extractedFact.count({ where: { userId } }),
  PersonalRecord: (p, userId) => p.personalRecord.count({ where: { userId } }),
  UserAchievement: (p, userId) =>
    p.userAchievement.count({ where: { userId } }),
  EnvironmentContext: (p, userId) =>
    p.environmentContext.count({ where: { userId } }),
  EnvironmentTravelLocation: (p, userId) =>
    p.environmentTravelLocation.count({ where: { userId } }),
  EcgRecording: (p, userId) => p.ecgRecording.count({ where: { userId } }),
  // No own `userId` column — reached through the drug, like the schedules.
  MedicationEfficacyTarget: (p, userId) =>
    p.medicationEfficacyTarget.count({ where: { medication: { userId } } }),
  MedicationScheduleRevision: (p, userId) =>
    p.medicationScheduleRevision.count({ where: { medication: { userId } } }),
  OnboardingRecord: (p, userId) =>
    p.onboardingRecord.count({ where: { userId } }),
};

/**
 * One row of every two-ended model, for one account.
 *
 * Minimal on purpose: this file asks whether a row survives the round trip, and
 * a fat fixture only makes the answer slower to get. The mood factor and the
 * cycle symptom are the account's OWN custom rows rather than seeded catalogue
 * entries, because a catalogue row survives the account being deleted and would
 * make the link tables look restored when nothing restored them.
 */
async function seedEveryTwoEndedModel(prisma: PrismaClient): Promise<void> {
  // Held rather than discarded: the personal best below points at this row
  // through a column that is a real foreign key in the database, so the
  // fixture needs the id to build the reference the restore has to resolve.
  const weightMeasurement = await prisma.measurement.create({
    data: {
      userId: OWNER_ID,
      type: "WEIGHT",
      value: 74.2,
      unit: "kg",
      measuredAt: AT("2026-07-01T07:00:00.000Z"),
      source: "MANUAL",
    },
  });
  // A DELETED reading, kept as a tombstone. It is here because the obvious way
  // to make the weekly backup cheaper — stop exporting soft-deleted rows, which
  // on a real record is four rows in five — is wrong, and nothing in the tree
  // said so out loud. A tombstone inside the retention window is what tells a
  // synced client the row is gone (`/api/sync/changes` reads exactly these) and
  // what makes a re-sent Apple Health sample a no-op instead of a resurrection.
  // Drop them from a disaster-recovery file and a restore quietly brings back
  // every measurement the account ever deleted on the next device sync.
  await prisma.measurement.create({
    data: {
      userId: OWNER_ID,
      type: "PULSE",
      value: 61,
      unit: "bpm",
      measuredAt: AT("2026-07-02T06:30:00.000Z"),
      source: "APPLE_HEALTH",
      externalId: "round-trip-deleted-sample",
      syncVersion: 4,
      deletedAt: AT("2026-07-20T09:15:00.000Z"),
    },
  });
  // The EVENT row an ECG strip is filed against, and the strip itself. The
  // pairing is the point: `EcgRecording.measurementId` is a real foreign key,
  // so this is the reference whose remap has to survive the round trip rather
  // than fail the transaction.
  const rhythmEvent = await prisma.measurement.create({
    data: {
      userId: OWNER_ID,
      type: "IRREGULAR_RHYTHM_NOTIFICATION",
      value: 1,
      unit: "event",
      measuredAt: AT("2026-06-15T14:22:00.000Z"),
      source: "WITHINGS",
      rhythmClassification: "IRREGULAR",
    },
  });
  await prisma.ecgRecording.create({
    data: {
      userId: OWNER_ID,
      source: "WITHINGS",
      externalRecordingId: "round-trip-signal-1",
      recordedAt: AT("2026-06-15T14:22:00.000Z"),
      waveformEncrypted: encryptWaveformToBytes(ECG_SAMPLES),
      samplingFrequency: 300,
      sampleCount: ECG_SAMPLES.length,
      durationSeconds: ECG_SAMPLES.length / 300,
      lead: "I",
      averageHeartRate: 88,
      rhythmClassification: "IRREGULAR",
      measurementId: rhythmEvent.id,
    },
  });
  await prisma.intradayCumulativeProfile.create({
    data: {
      userId: OWNER_ID,
      type: "ACTIVITY_STEPS",
      dateKey: "2026-07-01",
      // One slot per hour — the restore refuses a profile of any other length,
      // because a short row lands in the table and is dropped on read.
      hourlyCumulative: Array.from({ length: 24 }, (_, hour) => hour * 350),
      dayTotal: 8050,
      sampleCount: 24,
      timezone: "Europe/Berlin",
    },
  });

  const medication = await prisma.medication.create({
    data: {
      userId: OWNER_ID,
      name: "Round-trip tablet",
      dose: "5 mg",
      schedules: {
        create: { windowStart: "08:00", windowEnd: "09:00", label: "Morning" },
      },
    },
  });
  await prisma.medicationIntakeEvent.create({
    data: {
      userId: OWNER_ID,
      medicationId: medication.id,
      scheduledFor: AT("2026-07-01T08:00:00.000Z"),
      takenAt: AT("2026-07-01T08:04:00.000Z"),
    },
  });
  // The one row in this fixture that is also checked field by field after the
  // restore — see the assertion at the end of the test for why.
  await prisma.medicationSideEffect.create({
    data: {
      userId: OWNER_ID,
      medicationId: medication.id,
      occurredAt: AT("2026-07-01T21:00:00.000Z"),
      category: "GI",
      entry: "NAUSEA",
      severity: 3,
      notesEncrypted: encryptToBytes(SIDE_EFFECT_NOTE),
    },
  });
  // Two eras, and the open one carries the weight. `resumedAt: null` means the
  // drug is paused right now; a restore that closed it at restore time would
  // still count one row back here and read as recovered. The field-level
  // assertion at the end of the test is what holds the null.
  // A two-step ramp. The ORDER is the content here: same drug, same unit,
  // 5 mg then 10 mg. A restore that returned them reversed would still count
  // two rows back and would describe the opposite clinical story.
  // One open pack and one used up, plus the two ledger rows behind the open
  // one. The count on the pack is deliberately NOT the sum of its events: 30
  // in, 8 consumed, and the remaining count says 21 because the person threw
  // one away without recording it. A restore that recomputed the count from
  // the ledger would "fix" that to 22 and disagree with every low-stock
  // reminder the account has already received.
  // A PHQ-9 administration whose item 9 was answered above zero. The flag and
  // the encrypted answers are seeded to DISAGREE with a naive recomputation:
  // the flag says true, and a restore that decided to recompute it would have
  // to decrypt the blob to do so, which is the handling this data is kept away
  // from. The assertion below reads the flag and the ciphertext separately.
  await prisma.mentalHealthAssessment.create({
    data: {
      userId: OWNER_ID,
      instrument: "PHQ9",
      locale: "de",
      version: "standard",
      responsesEncrypted: encryptToBytes(PHQ9_RESPONSES),
      totalScore: 14,
      severityBand: "moderate",
      item9Flagged: true,
      crisisShownAt: AT("2026-07-05T18:02:00.000Z"),
      takenAt: AT("2026-07-05T18:00:00.000Z"),
      tz: "Europe/Berlin",
      source: "WEB",
    },
  });

  // One active consent and one revoked. The revocation is the part a restore
  // can quietly lose: dropping `revokedAt` turns a withdrawn agreement back
  // into a standing one, and the latest-per-user lookup shortcuts on exactly
  // that column.
  await prisma.consentReceipt.createMany({
    data: [
      {
        userId: OWNER_ID,
        kind: "ai-processing",
        artefact: CONSENT_ARTEFACT,
        signedAt: AT("2026-06-01T09:00:00.000Z"),
      },
      {
        userId: OWNER_ID,
        kind: "research-sharing",
        artefact: "eyJhbGciOiJub25lIn0.e30.",
        signedAt: AT("2026-06-02T09:00:00.000Z"),
        revokedAt: AT("2026-07-10T11:00:00.000Z"),
      },
    ],
  });

  // Tuned away from every default, and one threshold in PERCENT rather than
  // MINUTES: a restore that fell back to the schema defaults would return four
  // plausible numbers and silently change when this drug turns orange.
  await prisma.reminderPhaseConfig.create({
    data: {
      medicationId: medication.id,
      greenValue: 45,
      greenMode: "MINUTES",
      yellowValue: 20,
      yellowMode: "PERCENT",
      orangeValue: 5,
      orangeMode: "MINUTES",
      redValue: 180,
      redMode: "MINUTES",
    },
  });

  const openPack = await prisma.medicationInventoryItem.create({
    data: {
      userId: OWNER_ID,
      medicationId: medication.id,
      state: "ACTIVE",
      containerType: "BLISTER",
      unitsTotal: "30",
      unitsRemaining: "21",
      firstUseAt: AT("2026-07-01T08:00:00.000Z"),
      expiresAt: AT("2027-01-31T00:00:00.000Z"),
      manufacturer: "Fixture Pharma",
      doseStrength: "10 mg",
      notesEncrypted: encryptToBytes(INVENTORY_NOTE),
    },
  });
  await prisma.medicationInventoryItem.create({
    data: {
      userId: OWNER_ID,
      medicationId: medication.id,
      state: "USED_UP",
      containerType: "BOTTLE",
      unitsTotal: "60",
      unitsRemaining: "0",
    },
  });
  await prisma.medicationInventoryEvent.createMany({
    data: [
      {
        medicationId: medication.id,
        delta: 30,
        reason: "purchased",
        occurredAt: AT("2026-07-01T07:00:00.000Z"),
      },
      {
        medicationId: medication.id,
        delta: -8,
        reason: "consumed",
        occurredAt: AT("2026-07-09T07:00:00.000Z"),
      },
    ],
  });

  await prisma.medicationDoseChange.createMany({
    data: [
      {
        medicationId: medication.id,
        effectiveFrom: AT("2026-04-01T08:00:00.000Z"),
        doseValue: 5,
        doseUnit: "mg",
        noteEncrypted: encryptToBytes(DOSE_CHANGE_NOTE),
      },
      {
        medicationId: medication.id,
        effectiveFrom: AT("2026-06-01T08:00:00.000Z"),
        doseValue: 10,
        doseUnit: "mg",
        noteEncrypted: null,
      },
    ],
  });
  // Three archived eras, and the CHAIN through them is the content. The
  // middle one was corrected, so it points at the third; the first and the
  // third stand on their own. A restore that returned three rows with every
  // link null satisfies any count and has destroyed the only thing the
  // pointer says — every era consumer skips a superseded row, so the
  // corrected middle era would come back live beside the correction that
  // replaced it and the timeline would show the same window twice.
  await prisma.medicationScheduleRevision.create({
    data: {
      medicationId: medication.id,
      validFrom: AT("2026-01-01T00:00:00.000Z"),
      validUntil: AT("2026-03-01T00:00:00.000Z"),
      payload: [{ windowStart: "07:00", windowEnd: "09:00", dose: "5 mg" }],
      source: "ARCHIVED",
    },
  });
  const correctionEra = await prisma.medicationScheduleRevision.create({
    data: {
      medicationId: medication.id,
      validFrom: AT("2026-03-01T00:00:00.000Z"),
      validUntil: AT("2026-05-01T00:00:00.000Z"),
      payload: [{ windowStart: "08:00", windowEnd: "10:00", dose: "10 mg" }],
      source: "MANUAL",
    },
  });
  await prisma.medicationScheduleRevision.create({
    data: {
      medicationId: medication.id,
      validFrom: AT("2026-02-01T00:00:00.000Z"),
      validUntil: AT("2026-03-01T00:00:00.000Z"),
      payload: [{ windowStart: "12:00", windowEnd: "13:00", dose: "10 mg" }],
      source: "ARCHIVED",
      supersededByRevisionId: correctionEra.id,
    },
  });

  await prisma.medicationPauseEra.createMany({
    data: [
      {
        userId: OWNER_ID,
        medicationId: medication.id,
        pausedAt: AT("2026-05-02T08:00:00.000Z"),
        resumedAt: AT("2026-05-20T08:00:00.000Z"),
      },
      {
        userId: OWNER_ID,
        medicationId: medication.id,
        pausedAt: AT("2026-07-15T08:00:00.000Z"),
        resumedAt: null,
      },
    ],
  });

  // A RATED tag the account defined itself — the export carries only rated
  // links, so a BINARY tag would leave `MoodEntryTagLink` empty.
  const moodCategory = await prisma.moodTagCategory.findFirstOrThrow({
    where: { userId: null },
  });
  // A category the account created itself, not a seeded one. It cascades away
  // with the user, and `MoodTag.categoryId` is a real foreign key — so before
  // the category travelled, this one row made the restore violate
  // `mood_tags_category_id_fkey` and answer 500 with the account left empty.
  const ownCategory = await prisma.moodTagCategory.create({
    data: {
      userId: OWNER_ID,
      key: "round_trip_own_category",
      labelKey: "mood.category.roundTripOwn",
      sortOrder: 90,
    },
  });
  const moodTag = await prisma.moodTag.create({
    data: {
      userId: OWNER_ID,
      categoryId: ownCategory.id,
      key: "round_trip_factor",
      labelKey: "mood.tag.roundTripFactor",
      kind: "RATED",
      scaleMin: 1,
      scaleMax: 5,
    },
  });
  // A SEEDED tag the account chose to hide. The id differs per instance, so
  // this is the row that proves the hidden set travels by key.
  const seededTagToHide = await prisma.moodTag.findFirstOrThrow({
    where: { userId: null },
  });
  await prisma.moodTagHidden.create({
    data: { userId: OWNER_ID, moodTagId: seededTagToHide.id },
  });

  await prisma.moodEntry.create({
    data: {
      userId: OWNER_ID,
      date: "2026-07-01",
      mood: "GUT",
      score: 4,
      source: "MOODLOG",
      moodLoggedAt: AT("2026-07-01T20:00:00.000Z"),
      tagLinks: { create: { moodTagId: moodTag.id, rating: 4 } },
      context: {
        create: {
          userId: OWNER_ID,
          workStatus: "regular",
          contactCircles: JSON.stringify(["family"]),
          leisureJoy: 6,
        },
      },
    },
  });

  const biomarker = await prisma.biomarker.create({
    data: { userId: OWNER_ID, name: "Ferritin", unit: "ng/mL" },
  });
  const labResult = await prisma.labResult.create({
    data: {
      userId: OWNER_ID,
      biomarkerId: biomarker.id,
      analyte: "Ferritin",
      value: 91,
      unit: "ng/mL",
      takenAt: AT("2026-06-30T09:00:00.000Z"),
    },
  });
  // What the drug above is FOR, pinned to the analyte just created. The two
  // rows are seeded at opposite ends of this fixture on purpose: the drug is
  // restored hundreds of lines before the analyte, so this pairing is what
  // proves the second pass runs late enough to resolve the name.
  await prisma.medicationEfficacyTarget.create({
    data: {
      medicationId: medication.id,
      biomarkerId: biomarker.id,
      primary: true,
    },
  });
  await prisma.allergy.create({
    data: { userId: OWNER_ID, substance: "Penicillin" },
  });
  await prisma.familyHistoryEntry.create({
    data: {
      userId: OWNER_ID,
      relationship: "MOTHER",
      condition: "Type 2 diabetes",
    },
  });

  const episode = await prisma.illnessEpisode.create({
    data: {
      userId: OWNER_ID,
      label: "Cold",
      type: "INFECTION",
      onsetAt: AT("2026-06-20T00:00:00.000Z"),
    },
  });
  // A SECOND condition, and the one the document below is actually filed
  // against. Two episodes is what makes the filing assertion mean something:
  // with one, a restore that pointed every link at the first condition it
  // found would return the right count and read as correct.
  const filedEpisode = await prisma.illnessEpisode.create({
    data: {
      userId: OWNER_ID,
      label: "Iron deficiency",
      type: "CHRONIC",
      onsetAt: AT("2026-03-01T00:00:00.000Z"),
    },
  });
  const illnessSymptom = await prisma.illnessSymptom.create({
    data: { key: "round_trip_cough", labelKey: "illness.symptom.roundTrip" },
  });
  await prisma.illnessDayLog.create({
    data: {
      userId: OWNER_ID,
      episodeId: episode.id,
      date: "2026-06-21",
      symptomLinks: { create: { symptomId: illnessSymptom.id, severity: 2 } },
    },
  });

  await prisma.userHealthProfile.create({
    data: {
      userId: OWNER_ID,
      aboutMeEncrypted: encryptToBytes("Runs three times a week"),
    },
  });
  await prisma.healthProfileFactRevision.create({
    data: {
      userId: OWNER_ID,
      kind: "SMOKING_STATUS",
      valueEncrypted: encryptToBytes("never"),
      validFrom: AT("2026-01-01T00:00:00.000Z"),
    },
  });

  await prisma.cycleProfile.create({
    data: { userId: OWNER_ID, cycleTrackingEnabled: true },
  });
  const cycle = await prisma.menstrualCycle.create({
    data: { userId: OWNER_ID, startDate: "2026-06-01" },
  });
  const cycleCategory = await prisma.cycleSymptomCategory.findFirstOrThrow();
  const cycleSymptom = await prisma.cycleSymptom.create({
    data: {
      userId: OWNER_ID,
      categoryId: cycleCategory.id,
      key: "custom:round-trip-cramps",
      labelKey: "cycle.symptom.custom",
      labelEncrypted: encrypt("Round-trip cramps"),
    },
  });
  await prisma.cycleDayLog.create({
    data: {
      userId: OWNER_ID,
      cycleId: cycle.id,
      date: "2026-06-02",
      flow: "HEAVY",
      symptomLinks: { create: { symptomId: cycleSymptom.id } },
    },
  });

  await prisma.customMetric.create({
    data: {
      userId: OWNER_ID,
      name: "Grip strength",
      unit: "kg",
      entries: {
        create: {
          userId: OWNER_ID,
          value: 44,
          unit: "kg",
          measuredAt: AT("2026-07-01T18:00:00.000Z"),
        },
      },
    },
  });
  await prisma.correlationPattern.create({
    data: {
      userId: OWNER_ID,
      canonicalKey: `p1:${"a1".repeat(32)}`,
      family: "sleep",
      factorKey: "sleep_duration",
      outcomeKey: "weight",
      lagDays: 1,
      sampleSize: 30,
      effectSize: 0.42,
      pValue: 0.01,
      evidenceHash: "b2".repeat(32),
      lastComputedAt: AT("2026-07-01T00:00:00.000Z"),
    },
  });
  await prisma.onboardingRecord.create({
    data: {
      userId: OWNER_ID,
      needsJson: {
        recordTarget: "me",
        areas: ["blood-pressure", "sleep"],
        medication: "yes",
        sources: ["withings"],
        visit: "within-a-month",
        units: { glucoseUnit: "mmol/L", unitPreference: "metric" },
      },
      stepsJson: [
        { id: "who", status: "done" },
        { id: "areas", status: "done" },
        { id: "sources", status: "skipped" },
      ],
      firstResultJson: {
        task: "connect-source",
        target: "withings",
        completedAt: "2026-07-01T08:30:00.000Z",
      },
      // The once-only latch on the module derivation. Seeded non-null so the
      // assertion after the restore can show it came back rather than
      // defaulting — a null here would hand the next confirm permission to
      // re-apply the questionnaire over every module decision made since.
      modulesDerivedAt: AT("2026-07-01T08:00:00.000Z"),
      completedAt: AT("2026-07-01T08:00:00.000Z"),
    },
  });
  await prisma.healthScoreRecord.create({
    data: {
      userId: OWNER_ID,
      dayKey: "2026-07-01",
      timezone: "Europe/Berlin",
      composite: 71,
      band: "green",
      scoreVersion: 1,
      composition: ["activity", "sleep"],
      pillarScores: { activity: 70, sleep: 72 },
      inputFingerprint: "c3".repeat(32),
    },
  });

  await prisma.workout.create({
    data: {
      userId: OWNER_ID,
      sportType: "RUNNING",
      startedAt: AT("2026-06-29T06:00:00.000Z"),
      endedAt: AT("2026-06-29T06:30:00.000Z"),
      durationSec: 1800,
    },
  });
  await prisma.nutrientIntakeDay.create({
    data: {
      userId: OWNER_ID,
      day: "2026-07-01",
      nutrient: "WATER",
      amount: 2100,
      unit: "ml",
      source: "MANUAL",
    },
  });

  const documentBytes = encryptBytes(Buffer.from("round-trip document bytes"));
  const contentEncrypted = new Uint8Array(
    new ArrayBuffer(documentBytes.byteLength),
  );
  contentEncrypted.set(documentBytes);
  const document = await prisma.inboundDocument.create({
    data: {
      userId: OWNER_ID,
      kind: "LAB_RESULT",
      title: "June labs",
      filename: "june-labs.pdf",
      mimeType: "application/pdf",
      byteSize: documentBytes.byteLength,
      contentEncrypted,
      contentCodec: "binary2",
    },
  });

  // The page filed under the SECOND condition, not the first. A restore that
  // kept the count and lost the pairing would leave the vault sorted wrongly
  // rather than visibly unsorted, which is harder to notice and worse.
  await prisma.documentConditionLink.create({
    data: {
      userId: OWNER_ID,
      documentId: document.id,
      episodeId: filedEpisode.id,
      createdAt: AT("2026-07-02T09:00:00.000Z"),
    },
  });

  // One staged fact, already reviewed, approved and committed to the ferritin
  // lab row above. Every column that records the decision is set AWAY from its
  // schema default on purpose: `PENDING`, `needsReview: true` and two NULL
  // commitment columns are what a restore that ignores them writes, and the
  // assertion after the restore is what catches that. A fact handed back as
  // PENDING is offered for review again, and approving it a second time writes
  // a second lab result for a reading the account already has.
  await prisma.extractedFact.create({
    data: {
      userId: OWNER_ID,
      documentId: document.id,
      factType: "OBSERVATION",
      status: "APPROVED",
      confidence: 0.94,
      needsReview: false,
      committedRecordId: labResult.id,
      committedRecordType: "labResult",
      dataEncrypted: encryptFactData({
        label: "Ferritin",
        code: null,
        codeSystem: null,
        value: 91,
        valueText: null,
        unit: "ng/mL",
        referenceLow: 30,
        referenceHigh: 400,
        effectiveDate: "2026-06-30",
      }),
      provenanceEncrypted: encryptFactProvenance({
        sourceText: EXTRACTED_FACT_SPAN,
        anchored: true,
        sourceOffset: 412,
        page: 2,
        confidence: 0.94,
      }),
    },
  });

  // Two Coach threads, and the pair is the point. One is an ordinary health
  // conversation; the other is FENCED — `documentScoped` true, grounded in the
  // document seeded above. A restore that let the flag default to false would
  // return both threads, satisfy every count, and quietly hand the tool loop
  // back to the one conversation whose history may contain document-derived
  // text. That is why the assertion below reads the flag per thread rather
  // than counting rows.
  await prisma.coachConversation.create({
    data: {
      userId: OWNER_ID,
      title: "How is my blood pressure trending?",
      documentScoped: false,
      summaryEncrypted: encryptToBytes(COACH_SUMMARY),
      summaryUpdatedAt: AT("2026-07-20T10:00:00.000Z"),
      summaryTurnCount: 4,
      messages: {
        create: [
          {
            role: "user",
            encryptedContent: encryptToBytes(COACH_USER_TURN),
            createdAt: AT("2026-07-20T09:58:00.000Z"),
          },
          {
            role: "assistant",
            encryptedContent: encryptToBytes(COACH_ASSISTANT_TURN),
            providerType: "anthropic",
            model: "claude-opus-5",
            tokensUsed: 812,
            createdAt: AT("2026-07-20T09:59:00.000Z"),
          },
        ],
      },
    },
  });
  await prisma.coachConversation.create({
    data: {
      userId: OWNER_ID,
      title: "About my June labs",
      documentScoped: true,
      messages: {
        create: [
          {
            role: "user",
            encryptedContent: encryptToBytes("What does the ferritin mean?"),
            createdAt: AT("2026-07-21T08:00:00.000Z"),
          },
        ],
      },
      attachments: {
        create: [
          { documentId: document.id, addedAt: AT("2026-07-21T07:59:00.000Z") },
        ],
      },
    },
  });

  // What the Coach keeps between threads, seeded so both references are
  // exercised: the fact and the plan point back at the thread they came out
  // of, and the reminder points at the plan.
  const healthThread = await prisma.coachConversation.findFirstOrThrow({
    where: { userId: OWNER_ID, documentScoped: false },
  });
  await prisma.coachFact.create({
    data: {
      userId: OWNER_ID,
      factEncrypted: encryptToBytes(COACH_FACT),
      category: "constraint",
      confidence: 80,
      sourceConversationId: healthThread.id,
    },
  });
  const plan = await prisma.coachPlan.create({
    data: {
      userId: OWNER_ID,
      metric: "BLOOD_PRESSURE",
      ifCueEncrypted: encryptToBytes(COACH_PLAN_CUE),
      thenActionEncrypted: encryptToBytes(COACH_PLAN_ACTION),
      targetEncrypted: encryptToBytes("under 130 by October"),
      status: "active",
      reviewDate: AT("2026-10-01T00:00:00.000Z"),
      sourceConversationId: healthThread.id,
    },
  });
  await prisma.coachReminder.create({
    data: {
      userId: OWNER_ID,
      noteEncrypted: encryptToBytes(COACH_REMINDER_NOTE),
      metric: "BLOOD_PRESSURE",
      relatedPlanId: plan.id,
      triggerKind: "date",
      dueAt: AT("2026-09-01T07:00:00.000Z"),
      status: "active",
      source: "extractor",
      sourceConversationId: healthThread.id,
      surfaceCount: 2,
    },
  });

  // One visit, the practice it was at, and one link of each of the three
  // kinds. The links reach the document, the lab result and the condition
  // episode seeded above rather than fresh rows, because a link to something
  // the restore did not put back is the exact case the restore reports as a
  // skip — seeding it against a row that does come back is what makes a
  // returning count mean the filing survived.
  const practitioner = await prisma.practitioner.create({
    data: {
      userId: OWNER_ID,
      name: "Round-trip practice",
      specialty: "Internal medicine",
      noteEncrypted: encryptToBytes("ring the upper bell"),
    },
  });

  // One Vorsorge reminder with the v1.37.20 skip/snooze columns all set, and
  // two completion-ledger rows — one honest satisfy, one honest skip. Fat like
  // the vaccination fixture below and for the same reason: the count-back
  // proves the rows returned, the column-by-column assertion after the restore
  // proves they returned WHOLE. The encounter and the dose below point their
  // `reminderId` here, because both references now remap against the restored
  // reminders and this fixture is what proves they survive rather than drop.
  const reminder = await prisma.measurementReminder.create({
    data: {
      userId: OWNER_ID,
      label: "Blutdruck messen",
      measurementType: "BLOOD_PRESSURE_SYS",
      intervalDays: 7,
      notifyHour: 8,
      location: "Zuhause",
      nextDueAt: AT("2026-07-08T06:00:00.000Z"),
      lastSatisfiedAt: AT("2026-07-01T06:05:00.000Z"),
      vaccinationAntigen: "tetanus",
      snoozedUntil: AT("2026-07-08T06:00:00.000Z"),
      lastSkippedAt: AT("2026-06-24T06:00:00.000Z"),
      skipCount: 2,
    },
  });
  await prisma.measurementReminderEvent.create({
    data: {
      userId: OWNER_ID,
      reminderId: reminder.id,
      kind: "SATISFIED",
      occurredAt: AT("2026-07-01T06:05:00.000Z"),
      onTime: true,
      source: "manual",
    },
  });
  await prisma.measurementReminderEvent.create({
    data: {
      userId: OWNER_ID,
      reminderId: reminder.id,
      kind: "SKIPPED",
      occurredAt: AT("2026-06-24T06:00:00.000Z"),
      onTime: false,
      source: "skip",
    },
  });

  const encounter = await prisma.encounter.create({
    data: {
      userId: OWNER_ID,
      occurredAt: AT("2026-06-30T08:00:00.000Z"),
      status: "DONE",
      kind: "ROUTINE",
      practitionerId: practitioner.id,
      reasonEncrypted: encryptToBytes("annual check"),
      outcomeEncrypted: encryptToBytes(
        "ferritin back in range, recheck in a year",
      ),
      reminderId: reminder.id,
    },
  });
  await prisma.encounterDocumentLink.create({
    data: {
      userId: OWNER_ID,
      encounterId: encounter.id,
      documentId: document.id,
    },
  });
  await prisma.encounterLabLink.create({
    data: {
      userId: OWNER_ID,
      encounterId: encounter.id,
      labResultId: labResult.id,
    },
  });
  await prisma.encounterConditionLink.create({
    data: {
      userId: OWNER_ID,
      encounterId: encounter.id,
      episodeId: episode.id,
    },
  });

  // One dose with every optional column filled, and the page it was
  // transcribed from. Fat on purpose, against this file's own minimal-fixture
  // rule: a count-back proves the row returned, and the assertion after the
  // restore reads each column back so it also proves the row returned WHOLE.
  // The practitioner, the encounter and the reminder are the ones seeded
  // above, because all three are remapped on the way back and a reference to
  // something the restore did not put back is a different case (covered by
  // the skip test below). `reminderId` used to be deliberately absent here —
  // it was the one reference that could never resolve — and is deliberately
  // present since v1.37.20, because resolving is now the behaviour under test.
  const vaccination = await prisma.vaccinationRecord.create({
    data: {
      userId: OWNER_ID,
      occurredAt: AT("2026-05-14T00:00:00.000Z"),
      antigenSlug: "tdap",
      vaccineName: "Tetanus, diphtheria and pertussis",
      doseNumber: 3,
      seriesDoses: 3,
      lotNumber: "RT-4471",
      site: "LEFT_ARM",
      practitionerId: practitioner.id,
      encounterId: encounter.id,
      reminderId: reminder.id,
      noteEncrypted: encryptToBytes("sore arm for a day, nothing else"),
    },
  });
  await prisma.vaccinationDocumentLink.create({
    data: {
      userId: OWNER_ID,
      vaccinationId: vaccination.id,
      documentId: document.id,
    },
  });

  // Three bests, chosen for what a count cannot see.
  //
  // The first points at the measurement it was found in. That column is a
  // foreign key in the database while the Prisma schema declares no relation
  // for it, so this row is what proves the pointer resolves against the
  // measurements the restore wrote, and would prove the opposite loudly, by
  // failing the constraint and taking the whole restore with it.
  //
  // The other two share a metric type AND an instant and differ only in the
  // sport slot: the same 5 km and 10 km bests a runner has. A restore that
  // dropped the slot would return two rows describing one record twice, and
  // the faster time would be presented as the 10 km best.
  await prisma.personalRecord.create({
    data: {
      userId: OWNER_ID,
      metricType: "WEIGHT",
      direction: "MIN",
      value: 74.2,
      unit: "kg",
      achievedAt: AT("2026-07-01T07:00:00.000Z"),
      sourceMeasurementId: weightMeasurement.id,
      source: "MANUAL",
    },
  });
  await prisma.personalRecord.createMany({
    data: [
      {
        userId: OWNER_ID,
        metricType: "WALKING_RUNNING_DISTANCE",
        metricSlot: "running_5km_time",
        direction: "MIN",
        value: 1512,
        unit: "s",
        achievedAt: AT("2026-05-18T09:20:00.000Z"),
        source: "APPLE_HEALTH",
        externalId: "workout-pr-5km",
      },
      {
        userId: OWNER_ID,
        metricType: "WALKING_RUNNING_DISTANCE",
        metricSlot: "running_10km_time",
        direction: "MIN",
        value: 3184,
        unit: "s",
        achievedAt: AT("2026-05-18T09:20:00.000Z"),
        source: "APPLE_HEALTH",
        externalId: "workout-pr-10km",
      },
    ],
  });

  // Two badges, both earned long before this fixture runs. The second names a
  // definition no catalogue in this build ships: a file can be older than the
  // release reading it, and the restore must carry the row rather than judge
  // it, exactly as it carries a retired antigen slug.
  await prisma.userAchievement.createMany({
    data: [
      {
        userId: OWNER_ID,
        achievementId: "intake-total-10",
        unlockedAt: AT("2026-02-21T10:15:00.000Z"),
      },
      {
        userId: OWNER_ID,
        achievementId: "retired-badge-from-an-older-release",
        unlockedAt: AT("2025-11-05T08:00:00.000Z"),
      },
    ],
  });

  // A fortnight in Barcelona, and one day of it recorded as a reading.
  //
  // The pair is the fixture. The home day and the trip day carry different
  // coordinates and different weather, and the trip day's reading only makes
  // sense next to the period that explains it: with the period gone, the next
  // refresh re-resolves 2026-06-15 to Berlin and upserts Berlin's weather over
  // it. The assertion after the restore reads the two back TOGETHER.
  await prisma.environmentTravelLocation.create({
    data: {
      userId: OWNER_ID,
      startDate: "2026-06-10",
      endDate: "2026-06-20",
      lat: 41.3874,
      lon: 2.1686,
      label: "Barcelona",
    },
  });
  await prisma.environmentContext.createMany({
    data: [
      {
        userId: OWNER_ID,
        date: "2026-06-15",
        lat: 41.3874,
        lon: 2.1686,
        locationLabel: "Barcelona",
        source: "TRAVEL",
        tempMin: 19.4,
        tempMax: 28.1,
        tempMean: 23.6,
        apparentMean: 25.2,
        sunshineSec: 39_600,
        daylightSec: 52_800,
        precipSum: 0,
        pressureMean: 1016.4,
        pressureDelta: 3.2,
        humidityMean: 63,
        cloudMean: 12,
        weatherCode: 1,
        fetchedAt: AT("2026-06-16T03:15:00.000Z"),
      },
      {
        userId: OWNER_ID,
        date: "2026-07-01",
        lat: 52.52,
        lon: 13.405,
        locationLabel: "Berlin",
        source: "HOME",
        tempMin: 13.1,
        tempMax: 22.7,
        tempMean: 17.9,
        apparentMean: 17.1,
        sunshineSec: 28_800,
        daylightSec: 59_400,
        precipSum: 4.6,
        pressureMean: 1008.9,
        pressureDelta: 7.8,
        humidityMean: 74,
        cloudMean: 68,
        weatherCode: 61,
        fetchedAt: AT("2026-07-02T03:15:00.000Z"),
      },
    ],
  });
}

async function createOwner(prisma: PrismaClient) {
  return prisma.user.create({
    data: {
      id: OWNER_ID,
      username: "round-trip-owner",
      email: "round-trip-owner@example.test",
    },
  });
}

async function seedAdminSession(prisma: PrismaClient) {
  const admin = await prisma.user.create({
    data: {
      username: "round-trip-admin",
      email: "round-trip-admin@example.test",
      role: "ADMIN",
    },
  });
  const session = await prisma.session.create({
    data: { userId: admin.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return admin;
}

describe("every model the plan claims two-ended survives a real restore", () => {
  it("carries a seeded row of each model out of the account and back in", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await createOwner(prisma);
    await seedEveryTwoEndedModel(prisma);

    // The fixture has to be complete before the account is deleted, or a model
    // seeded with zero rows would come back with zero and read as restored.
    const seeded = await Promise.all(
      TWO_ENDED_MODELS.map(async (model) => [
        model,
        await COUNT_BACK[model](prisma, OWNER_ID),
      ]),
    );
    expect(
      seeded.filter(([, count]) => count === 0).map(([model]) => model),
      "seeded no row for these, so the assertion after the restore would " +
        "compare nothing against nothing and pass",
    ).toEqual([]);

    // Pinned so the two writers below describe the same instant and can be
    // compared byte for byte; `exportedAt` otherwise defaults to `new Date()`.
    const exportedAt = new Date("2026-08-01T00:00:00.000Z");
    const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
      purpose: "disaster-recovery",
      exportedAt,
    });

    // The writer the weekly job actually uses never builds this payload: it
    // pulls the unbounded tables through page by page and serialises each row
    // straight into the cipher, because materialising them is what used to
    // exhaust the heap. Two writers is two chances to drift, so the file it
    // produces is pinned against the one above — every per-table assertion
    // below then covers BOTH, since the row that gets restored comes from the
    // streamed bytes.
    let streamedJson = "";
    await streamFullBackupJson(
      prisma,
      OWNER_ID,
      (chunk) => {
        streamedJson += chunk;
      },
      { purpose: "disaster-recovery", exportedAt },
    );
    expect(
      streamedJson,
      "the streaming writer and the materialising builder disagree; the " +
        "weekly backup no longer contains what this test proves restorable",
    ).toBe(JSON.stringify(payload));

    // The tombstone has to be IN the file. A disaster-recovery payload that
    // carries only live rows is smaller and cheaper and wrong: the restore
    // wipes the account first, so a deletion that is not in the file is a
    // deletion the account no longer knows it made, and the next device sync
    // re-inserts every one of those samples as fresh readings.
    const exportedMeasurements = payload.measurements as Array<{
      externalId: string | null;
      deletedAt: string | null;
      syncVersion: number;
    }>;
    expect(
      exportedMeasurements.find(
        (row) => row.externalId === "round-trip-deleted-sample",
      ),
      "a soft-deleted reading is missing from the disaster-recovery payload",
    ).toMatchObject({
      deletedAt: "2026-07-20T09:15:00.000Z",
      syncVersion: 4,
    });

    // Cascade rather than a hand-listed sweep — see the file comment.
    await prisma.user.delete({ where: { id: OWNER_ID } });
    await createOwner(prisma);
    const emptied = await Promise.all(
      TWO_ENDED_MODELS.map((model) => COUNT_BACK[model](prisma, OWNER_ID)),
    );
    expect(
      emptied.reduce((total, count) => total + count, 0),
      "the account still owns rows after being deleted, so the restore is " +
        "not what put them there",
    ).toBe(0);

    const backup = await prisma.dataBackup.create({
      data: {
        userId: OWNER_ID,
        type: "TWO_ENDED_ROUND_TRIP",
        // The envelope the weekly worker actually writes: stream the JSON
        // through gzip and the cipher without ever holding a whole copy. The
        // three cases further down deliberately keep the plain `encrypt(json)`
        // form, which is what every row written before any of this existed
        // looks like — an operator's newest usable copy may well be one of
        // those, so every arm has to reach the restore route.
        data: await packBackupBlobStreaming(async (write) => {
          await write(streamedJson);
        }),
      },
    });
    const response = await POST(
      new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as never,
      { params: Promise.resolve({ id: backup.id }) },
    );
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(
      body.data.skipped.links,
      "a dropped link is a row that did not " +
        "come back, reported rather than silent",
    ).toBe(0);

    const restored = await Promise.all(
      TWO_ENDED_MODELS.map(async (model) => [
        model,
        await COUNT_BACK[model](prisma, OWNER_ID),
      ]),
    );
    expect(
      restored.filter(([, count]) => count === 0).map(([model]) => model),
      "the plan claims these travel both ways; the account was restored " +
        "without them, which is a backup that reports success and hands back " +
        "less than it was given",
    ).toEqual([]);

    const sideEffect = await prisma.medicationSideEffect.findFirstOrThrow({
      where: { userId: OWNER_ID },
      include: { medication: { select: { name: true, userId: true } } },
    });
    expect({
      category: sideEffect.category,
      entry: sideEffect.entry,
      severity: sideEffect.severity,
      occurredAt: sideEffect.occurredAt.toISOString(),
      medication: sideEffect.medication.name,
      medicationOwner: sideEffect.medication.userId,
      note: readNote(sideEffect.notesEncrypted, sideEffect.notes),
    }).toEqual({
      category: "GI",
      entry: "NAUSEA",
      severity: 3,
      occurredAt: "2026-07-01T21:00:00.000Z",
      medication: "Round-trip tablet",
      medicationOwner: OWNER_ID,
      note: SIDE_EFFECT_NOTE,
    });
    // The note must be BACK IN THE COLUMN it came from, not carried as
    // plaintext: a restore that writes a portable export's decrypted note into
    // `notes` reads identically through `readNote` above and has quietly
    // un-encrypted the account's free text.
    expect(sideEffect.notes, "plaintext must not come back in the column").toBe(
      null,
    );

    // Both pause eras, and the open one specifically. The count above only
    // says two rows returned; a restore that closed the running pause at
    // restore time would satisfy it exactly, and the account would come back
    // saying a medication it is still off had been resumed — which the
    // compliance recomputation then reads as doses missed on purpose-taken
    // days. `null` is the assertion that matters here.
    const eras = await prisma.medicationPauseEra.findMany({
      where: { userId: OWNER_ID },
      orderBy: { pausedAt: "asc" },
      select: { pausedAt: true, resumedAt: true },
    });
    expect(
      eras.map((e) => ({
        pausedAt: e.pausedAt.toISOString(),
        resumedAt: e.resumedAt ? e.resumedAt.toISOString() : null,
      })),
      "an open pause era must come back open",
    ).toEqual([
      {
        pausedAt: "2026-05-02T08:00:00.000Z",
        resumedAt: "2026-05-20T08:00:00.000Z",
      },
      { pausedAt: "2026-07-15T08:00:00.000Z", resumedAt: null },
    ]);

    // The setup answers came back as answers, not as an empty questionnaire.
    //
    // Asserted column by column rather than by count: the row returning proves
    // nothing about `modulesDerivedAt`, and that field is the once-only latch
    // on the module derivation — a restore that let it default to null would
    // hand the next confirm permission to re-apply the questionnaire over
    // every module decision the account has taken since, silently.
    const restoredOnboarding = await prisma.onboardingRecord.findUniqueOrThrow({
      where: { userId: OWNER_ID },
    });
    expect({
      needs: restoredOnboarding.needsJson,
      steps: restoredOnboarding.stepsJson,
      firstResult: restoredOnboarding.firstResultJson,
      modulesDerivedAt: restoredOnboarding.modulesDerivedAt?.toISOString(),
      completedAt: restoredOnboarding.completedAt?.toISOString(),
    }).toEqual({
      needs: {
        recordTarget: "me",
        areas: ["blood-pressure", "sleep"],
        medication: "yes",
        sources: ["withings"],
        visit: "within-a-month",
        units: { glucoseUnit: "mmol/L", unitPreference: "metric" },
      },
      // The stored blob is a status LOOKUP, and the reader answers with the
      // full ordered nine — a step the fixture never mentioned comes back
      // `pending` rather than missing, which is what lets the flow grow a
      // screen without a migration.
      steps: [
        { id: "who", status: "done" },
        { id: "areas", status: "done" },
        { id: "medication", status: "pending" },
        { id: "sources", status: "skipped" },
        { id: "visit", status: "pending" },
        { id: "units", status: "pending" },
        { id: "confirm", status: "pending" },
        { id: "first-result", status: "pending" },
        { id: "done", status: "pending" },
      ],
      firstResult: {
        task: "connect-source",
        target: "withings",
        completedAt: "2026-07-01T08:30:00.000Z",
      },
      modulesDerivedAt: "2026-07-01T08:00:00.000Z",
      completedAt: "2026-07-01T08:00:00.000Z",
    });

    // The Coach came back able to speak, and the fence held.
    //
    // `documentScoped` is asserted per thread rather than in aggregate: a
    // restore that wrote `false` everywhere would still return two threads,
    // two counts and every turn, and the only visible difference would be a
    // fenced conversation quietly holding a tool loop again.
    // Resolved from the database rather than remembered from the fixture: the
    // attachment has to point at the document the RESTORE put back, not at an
    // id that happens to match one the seeding used.
    const vaultDocument = await prisma.inboundDocument.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    const threads = await prisma.coachConversation.findMany({
      where: { userId: OWNER_ID },
      orderBy: { createdAt: "asc" },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
        attachments: true,
      },
    });
    expect(
      threads.map((thread) => ({
        title: thread.title,
        documentScoped: thread.documentScoped,
        summary: thread.summaryEncrypted
          ? decryptFromBytes(thread.summaryEncrypted)
          : null,
        summaryTurnCount: thread.summaryTurnCount,
        turns: thread.messages.map((message) => ({
          role: message.role,
          content: decryptFromBytes(message.encryptedContent),
          model: message.model,
          tokensUsed: message.tokensUsed,
        })),
        attachments: thread.attachments.map((a) => a.documentId),
      })),
      "the transcript, the fence and the provenance all come back",
    ).toEqual([
      {
        title: "How is my blood pressure trending?",
        documentScoped: false,
        summary: COACH_SUMMARY,
        summaryTurnCount: 4,
        turns: [
          {
            role: "user",
            content: COACH_USER_TURN,
            model: null,
            tokensUsed: null,
          },
          {
            role: "assistant",
            content: COACH_ASSISTANT_TURN,
            model: "claude-opus-5",
            tokensUsed: 812,
          },
        ],
        attachments: [],
      },
      {
        title: "About my June labs",
        documentScoped: true,
        summary: null,
        summaryTurnCount: 0,
        turns: [
          {
            role: "user",
            content: "What does the ferritin mean?",
            model: null,
            tokensUsed: null,
          },
        ],
        attachments: [vaultDocument.id],
      },
    ]);

    // The Coach's memory, and both of its references still pointing at
    // something. Neither is a foreign key, so a restore that wrote them back
    // as null would break nothing, satisfy every count, and leave the account
    // with a Coach that remembers a fact and no longer knows where it came
    // from.
    const restoredThread = await prisma.coachConversation.findFirstOrThrow({
      where: { userId: OWNER_ID, documentScoped: false },
    });
    const restoredPlan = await prisma.coachPlan.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    const fact = await prisma.coachFact.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    expect({
      fact: decryptFromBytes(fact.factEncrypted),
      category: fact.category,
      confidence: fact.confidence,
      source: fact.sourceConversationId,
      deletedAt: fact.deletedAt,
    }).toEqual({
      fact: COACH_FACT,
      category: "constraint",
      confidence: 80,
      source: restoredThread.id,
      deletedAt: null,
    });
    expect({
      metric: restoredPlan.metric,
      ifCue: decryptFromBytes(restoredPlan.ifCueEncrypted),
      thenAction: decryptFromBytes(restoredPlan.thenActionEncrypted),
      target: restoredPlan.targetEncrypted
        ? decryptFromBytes(restoredPlan.targetEncrypted)
        : null,
      status: restoredPlan.status,
      source: restoredPlan.sourceConversationId,
    }).toEqual({
      metric: "BLOOD_PRESSURE",
      ifCue: COACH_PLAN_CUE,
      thenAction: COACH_PLAN_ACTION,
      target: "under 130 by October",
      status: "active",
      source: restoredThread.id,
    });
    const reminder = await prisma.coachReminder.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    expect(
      {
        note: decryptFromBytes(reminder.noteEncrypted),
        relatedPlanId: reminder.relatedPlanId,
        source: reminder.sourceConversationId,
        surfaceCount: reminder.surfaceCount,
        status: reminder.status,
      },
      "the reminder still knows which plan it belongs to",
    ).toEqual({
      note: COACH_REMINDER_NOTE,
      relatedPlanId: restoredPlan.id,
      source: restoredThread.id,
      surfaceCount: 2,
      status: "active",
    });

    // The screener came back readable, and the flag came back as recorded.
    const screener = await prisma.mentalHealthAssessment.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    expect({
      instrument: screener.instrument,
      totalScore: screener.totalScore,
      severityBand: screener.severityBand,
      item9Flagged: screener.item9Flagged,
      crisisShown: screener.crisisShownAt?.toISOString() ?? null,
      responses: decryptFromBytes(screener.responsesEncrypted),
    }).toEqual({
      instrument: "PHQ9",
      totalScore: 14,
      severityBand: "moderate",
      item9Flagged: true,
      crisisShown: "2026-07-05T18:02:00.000Z",
      responses: PHQ9_RESPONSES,
    });

    // Both consents, and the revocation still standing. A restore that lost
    // `revokedAt` would return the same two rows and turn a withdrawn
    // agreement back into an active one.
    const consents = await prisma.consentReceipt.findMany({
      where: { userId: OWNER_ID },
      orderBy: { signedAt: "asc" },
    });
    expect(
      consents.map((c) => ({
        kind: c.kind,
        artefact: c.artefact,
        revoked: c.revokedAt?.toISOString() ?? null,
      })),
      "a revoked consent must not come back as an active one",
    ).toEqual([
      { kind: "ai-processing", artefact: CONSENT_ARTEFACT, revoked: null },
      {
        kind: "research-sharing",
        artefact: "eyJhbGciOiJub25lIn0.e30.",
        revoked: "2026-07-10T11:00:00.000Z",
      },
    ]);

    // The account's own grouping came back, and the hidden tag is hidden
    // again — resolved by key, so it points at whatever id this instance uses.
    const ownCategories = await prisma.moodTagCategory.findMany({
      where: { userId: OWNER_ID },
    });
    expect(
      ownCategories.map((c) => ({ key: c.key, labelKey: c.labelKey })),
    ).toEqual([
      {
        key: "round_trip_own_category",
        labelKey: "mood.category.roundTripOwn",
      },
    ]);
    const restoredTag = await prisma.moodTag.findFirstOrThrow({
      where: { key: "round_trip_factor" },
    });
    expect(
      restoredTag.categoryId,
      "the custom tag is grouped under the account's own category",
    ).toBe(ownCategories[0].id);

    const hidden = await prisma.moodTagHidden.findMany({
      where: { userId: OWNER_ID },
      include: { moodTag: { select: { key: true, userId: true } } },
    });
    // Exactly one, and it points at a SEEDED tag — which is only possible if
    // the key was resolved against this instance's catalogue rather than an id
    // carried in the file.
    expect(hidden).toHaveLength(1);
    expect(hidden[0].moodTag.userId).toBeNull();

    // Every threshold as tuned, including the one that is not in minutes.
    const phase = await prisma.reminderPhaseConfig.findFirstOrThrow({
      where: { medication: { userId: OWNER_ID } },
    });
    expect({
      green: [phase.greenValue, phase.greenMode],
      yellow: [phase.yellowValue, phase.yellowMode],
      orange: [phase.orangeValue, phase.orangeMode],
      red: [phase.redValue, phase.redMode],
    }).toEqual({
      green: [45, "MINUTES"],
      yellow: [20, "PERCENT"],
      orange: [5, "MINUTES"],
      red: [180, "MINUTES"],
    });

    // The shelf, and the count that must not be recomputed.
    const packs = await prisma.medicationInventoryItem.findMany({
      where: { userId: OWNER_ID },
      orderBy: { createdAt: "asc" },
    });
    expect(
      packs.map((pack) => ({
        state: pack.state,
        containerType: pack.containerType,
        total: pack.unitsTotal.toString(),
        remaining: pack.unitsRemaining.toString(),
        manufacturer: pack.manufacturer,
        note: readNote(pack.notesEncrypted, pack.notes),
        plaintextColumn: pack.notes,
      })),
      "the remaining count comes back as recorded, not as recalculated",
    ).toEqual([
      {
        state: "ACTIVE",
        containerType: "BLISTER",
        total: "30",
        remaining: "21",
        manufacturer: "Fixture Pharma",
        note: INVENTORY_NOTE,
        plaintextColumn: null,
      },
      {
        state: "USED_UP",
        containerType: "BOTTLE",
        total: "60",
        remaining: "0",
        manufacturer: null,
        note: null,
        plaintextColumn: null,
      },
    ]);
    const stockLedger = await prisma.medicationInventoryEvent.findMany({
      where: { medication: { userId: OWNER_ID } },
      orderBy: { occurredAt: "asc" },
    });
    expect(
      stockLedger.map((e) => ({ delta: e.delta, reason: e.reason })),
    ).toEqual([
      { delta: 30, reason: "purchased" },
      { delta: -8, reason: "consumed" },
    ]);

    // The ramp, in order, with the note back in its column. Counting says two
    // rows returned; only this says they came back as the same ramp, and that
    // the encrypted note did not land in the plaintext column on the way.
    const doses = await prisma.medicationDoseChange.findMany({
      where: { medication: { userId: OWNER_ID } },
      orderBy: { effectiveFrom: "asc" },
    });
    expect(
      doses.map((d) => ({
        effectiveFrom: d.effectiveFrom.toISOString(),
        doseValue: d.doseValue,
        doseUnit: d.doseUnit,
        note: readNote(d.noteEncrypted, d.note),
        plaintextColumn: d.note,
      })),
      "the titration must come back as the same ramp, in order",
    ).toEqual([
      {
        effectiveFrom: "2026-04-01T08:00:00.000Z",
        doseValue: 5,
        doseUnit: "mg",
        note: DOSE_CHANGE_NOTE,
        plaintextColumn: null,
      },
      {
        effectiveFrom: "2026-06-01T08:00:00.000Z",
        doseValue: 10,
        doseUnit: "mg",
        note: null,
        plaintextColumn: null,
      },
    ]);

    // The dose, read back column by column. The count above says a row
    // returned; a restore that wrote one row with every optional column
    // defaulted would satisfy it and hand back an Impfpass line with no
    // antigen, no batch code and no arm. The two remapped references are
    // asserted as ids that exist rather than as the ids the file carried,
    // because that is the property the remap owes.
    const dose = await prisma.vaccinationRecord.findFirstOrThrow({
      where: { userId: OWNER_ID },
      include: {
        practitioner: { select: { name: true } },
        encounter: { select: { occurredAt: true } },
        reminder: { select: { label: true } },
        documentLinks: { select: { documentId: true } },
      },
    });
    expect({
      occurredAt: dose.occurredAt.toISOString(),
      antigenSlug: dose.antigenSlug,
      vaccineName: dose.vaccineName,
      doseNumber: dose.doseNumber,
      seriesDoses: dose.seriesDoses,
      lotNumber: dose.lotNumber,
      site: dose.site,
      practitioner: dose.practitioner?.name ?? null,
      encounterAt: dose.encounter?.occurredAt.toISOString() ?? null,
      // The booster reference, resolved through the relation: non-null proves
      // the id survived the round trip instead of dropping to NULL the way it
      // had to before the reminders travelled.
      reminder: dose.reminder?.label ?? null,
      links: dose.documentLinks.length,
      note: dose.noteEncrypted ? decryptFromBytes(dose.noteEncrypted) : null,
    }).toEqual({
      occurredAt: "2026-05-14T00:00:00.000Z",
      antigenSlug: "tdap",
      vaccineName: "Tetanus, diphtheria and pertussis",
      doseNumber: 3,
      seriesDoses: 3,
      lotNumber: "RT-4471",
      site: "LEFT_ARM",
      practitioner: "Round-trip practice",
      encounterAt: "2026-06-30T08:00:00.000Z",
      reminder: "Blutdruck messen",
      links: 1,
      note: "sore arm for a day, nothing else",
    });

    // The reminder, read back column by column — including the three
    // v1.37.20 columns (snooze cursor, last skip, skip counter), because a
    // restore that defaulted them would hand back a cadence that looks never
    // snoozed and never skipped, which is a history the account does not have.
    const restoredReminder = await prisma.measurementReminder.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    expect({
      label: restoredReminder.label,
      measurementType: restoredReminder.measurementType,
      intervalDays: restoredReminder.intervalDays,
      rrule: restoredReminder.rrule,
      anchorDate: restoredReminder.anchorDate,
      endsOn: restoredReminder.endsOn,
      origin: restoredReminder.origin,
      notifyHour: restoredReminder.notifyHour,
      location: restoredReminder.location,
      nextDueAt: restoredReminder.nextDueAt?.toISOString() ?? null,
      lastSatisfiedAt: restoredReminder.lastSatisfiedAt?.toISOString() ?? null,
      enabled: restoredReminder.enabled,
      vaccinationAntigen: restoredReminder.vaccinationAntigen,
      snoozedUntil: restoredReminder.snoozedUntil?.toISOString() ?? null,
      lastSkippedAt: restoredReminder.lastSkippedAt?.toISOString() ?? null,
      skipCount: restoredReminder.skipCount,
      deletedAt: restoredReminder.deletedAt,
    }).toEqual({
      label: "Blutdruck messen",
      measurementType: "BLOOD_PRESSURE_SYS",
      intervalDays: 7,
      rrule: null,
      anchorDate: null,
      endsOn: null,
      origin: "VORSORGE",
      notifyHour: 8,
      location: "Zuhause",
      nextDueAt: "2026-07-08T06:00:00.000Z",
      lastSatisfiedAt: "2026-07-01T06:05:00.000Z",
      enabled: true,
      vaccinationAntigen: "tetanus",
      snoozedUntil: "2026-07-08T06:00:00.000Z",
      lastSkippedAt: "2026-06-24T06:00:00.000Z",
      skipCount: 2,
      deletedAt: null,
    });

    // Both ledger rows, whole: the satisfy and the skip, with the resolved
    // `onTime` verdicts. A restore cannot re-derive `onTime` — the pre-event
    // `nextDueAt` is gone — so a defaulted value here would be an invented
    // punctuality record.
    const ledger = await prisma.measurementReminderEvent.findMany({
      where: { userId: OWNER_ID },
      orderBy: { occurredAt: "asc" },
    });
    expect(
      ledger.map((event) => ({
        reminderId: event.reminderId,
        kind: event.kind,
        occurredAt: event.occurredAt.toISOString(),
        onTime: event.onTime,
        source: event.source,
      })),
    ).toEqual([
      {
        reminderId: restoredReminder.id,
        kind: "SKIPPED",
        occurredAt: "2026-06-24T06:00:00.000Z",
        onTime: false,
        source: "skip",
      },
      {
        reminderId: restoredReminder.id,
        kind: "SATISFIED",
        occurredAt: "2026-07-01T06:05:00.000Z",
        onTime: true,
        source: "manual",
      },
    ]);

    // The vault came back SORTED, not merely populated.
    //
    // The count says one filing returned. It cannot say which page was filed
    // under which condition, and the account has two conditions — so a restore
    // that paired the document with the first episode it found would satisfy
    // every count above and hand back a lab report filed under a head cold.
    // The pair is resolved through the relations rather than compared against
    // the ids the fixture used, because both ends were re-created by the
    // restore and it is the pairing that has to survive, not the identifiers.
    const filing = await prisma.documentConditionLink.findFirstOrThrow({
      where: { userId: OWNER_ID },
      include: {
        document: { select: { title: true } },
        episode: { select: { label: true } },
      },
    });
    expect(
      {
        document: filing.document.title,
        condition: filing.episode.label,
        createdAt: filing.createdAt.toISOString(),
      },
      "the page must come back filed under the condition it was filed under",
    ).toEqual({
      document: "June labs",
      condition: "Iron deficiency",
      createdAt: "2026-07-02T09:00:00.000Z",
    });

    // The staged fact, and the decision on it.
    //
    // This is the assertion the count cannot make. `status`, `needsReview`,
    // `committedRecordId` and `committedRecordType` all default to "nobody has
    // looked at this yet", so a restore that wrote the row and ignored them
    // returns exactly one fact, exactly as the plan promises, and hands the
    // account a reviewed and committed reading back in its review queue. The
    // confirm endpoint acts only on a PENDING fact and commits it through the
    // normal create, so approving it a second time writes a SECOND ferritin
    // result. The commitment is checked against the lab row the restore itself
    // wrote, because a pointer that survives as a string but no longer names a
    // live row is the same loss wearing a value.
    const restoredLab = await prisma.labResult.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    const stagedFact = await prisma.extractedFact.findFirstOrThrow({
      where: { userId: OWNER_ID },
      include: { document: { select: { title: true } } },
    });
    expect(
      {
        document: stagedFact.document.title,
        factType: stagedFact.factType,
        status: stagedFact.status,
        confidence: stagedFact.confidence,
        needsReview: stagedFact.needsReview,
        committedRecordId: stagedFact.committedRecordId,
        committedRecordType: stagedFact.committedRecordType,
        data: decryptFactData(stagedFact.dataEncrypted),
        provenance: decryptFactProvenance(stagedFact.provenanceEncrypted),
      },
      "a reviewed and committed fact must not come back up for review",
    ).toEqual({
      document: "June labs",
      factType: "OBSERVATION",
      status: "APPROVED",
      confidence: 0.94,
      needsReview: false,
      committedRecordId: restoredLab.id,
      committedRecordType: "labResult",
      data: {
        label: "Ferritin",
        code: null,
        codeSystem: null,
        value: 91,
        valueText: null,
        unit: "ng/mL",
        referenceLow: 30,
        referenceHigh: 400,
        effectiveDate: "2026-06-30",
      },
      provenance: {
        sourceText: EXTRACTED_FACT_SPAN,
        anchored: true,
        sourceOffset: 412,
        page: 2,
        confidence: 0.94,
      },
    });
    // The archived eras, and the CHAIN through them.
    //
    // Counting says three eras returned, and three eras with every link null
    // would satisfy it exactly while having thrown away the only thing the
    // pointer states. That is not a cosmetic loss: every era consumer skips a
    // superseded row, so a corrected era whose link came back null goes live
    // again beside the correction that replaced it, and the account gets two
    // overlapping plans for one window with its past compliance minted against
    // whichever the query happened to read.
    //
    // Asserted as the shape of the chain rather than as ids: the ids are fresh
    // on a portable restore, and what the two-pass write owes is that era two
    // still points at era three and that nothing else points anywhere.
    const scheduleEras = await prisma.medicationScheduleRevision.findMany({
      where: { medication: { userId: OWNER_ID } },
      orderBy: [{ validFrom: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    const eraPositionById = new Map(
      scheduleEras.map((era, index) => [era.id, index]),
    );
    expect(
      scheduleEras.map((era) => ({
        validFrom: era.validFrom.toISOString(),
        validUntil: era.validUntil.toISOString(),
        source: era.source,
        payload: era.payload,
        supersedes: era.supersededByRevisionId
          ? (eraPositionById.get(era.supersededByRevisionId) ?? "dangling")
          : null,
      })),
      "the corrected era must come back still pointing at its correction",
    ).toEqual([
      {
        validFrom: "2026-01-01T00:00:00.000Z",
        validUntil: "2026-03-01T00:00:00.000Z",
        source: "ARCHIVED",
        payload: [{ windowStart: "07:00", windowEnd: "09:00", dose: "5 mg" }],
        supersedes: null,
      },
      {
        validFrom: "2026-02-01T00:00:00.000Z",
        validUntil: "2026-03-01T00:00:00.000Z",
        source: "ARCHIVED",
        payload: [{ windowStart: "12:00", windowEnd: "13:00", dose: "10 mg" }],
        supersedes: 2,
      },
      {
        validFrom: "2026-03-01T00:00:00.000Z",
        validUntil: "2026-05-01T00:00:00.000Z",
        source: "MANUAL",
        payload: [{ windowStart: "08:00", windowEnd: "10:00", dose: "10 mg" }],
        supersedes: null,
      },
    ]);
    // What the pointer actually buys, stated as the thing the app reads: the
    // timeline query drops superseded rows, so exactly two eras are live.
    expect(
      await prisma.medicationScheduleRevision.count({
        where: {
          medication: { userId: OWNER_ID },
          supersededByRevisionId: null,
        },
      }),
      "a lost pointer puts a corrected era back on the timeline",
    ).toBe(2);

    // The pinned target, and the analyte it points at.
    //
    // Counting says one override returned. It cannot say the override still
    // MEANS anything: a restore that wrote the row with `biomarkerId` nulled
    // returns a drug with no statement of what it was for, which is precisely
    // what the register said the alternative cost, and nothing anywhere would
    // complain — the resolver silently falls back to deriving a target and the
    // page still renders.
    //
    // Both ends are resolved from the DATABASE rather than remembered from the
    // fixture. The property the second pass owes is that the target points at
    // the biomarker THIS restore wrote, which an id carried over from the
    // seeding would not distinguish from a restore that copied a stale value.
    const restoredBiomarker = await prisma.biomarker.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    const restoredMedication = await prisma.medication.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    const target = await prisma.medicationEfficacyTarget.findFirstOrThrow({
      where: { medication: { userId: OWNER_ID } },
      include: { biomarker: { select: { name: true, userId: true } } },
    });
    expect({
      medicationId: target.medicationId,
      biomarkerId: target.biomarkerId,
      biomarkerName: target.biomarker?.name ?? null,
      biomarkerOwner: target.biomarker?.userId ?? null,
      measurementType: target.measurementType,
      primary: target.primary,
    }).toEqual({
      medicationId: restoredMedication.id,
      biomarkerId: restoredBiomarker.id,
      biomarkerName: "Ferritin",
      biomarkerOwner: OWNER_ID,
      measurementType: null,
      primary: true,
    });

    // The strip, read back column by column.
    //
    // Counting proves a recording returned. It cannot tell that recording from
    // one whose trace is an empty array, whose verdict defaulted to NULL and
    // whose instant is the restore time — and each of those three is the whole
    // value of the row on its own. A strip with no rhythm classification is a
    // squiggle nobody has read; a strip with no `recordedAt` belongs to no day
    // and cannot be put beside the event it explains; a strip with no samples
    // is a claim that an ECG exists which nothing can draw.
    //
    // `measurementId` is resolved from the DATABASE rather than remembered
    // from the fixture, because the property the remap owes is that the strip
    // points at the event row THIS restore wrote.
    const restoredEvent = await prisma.measurement.findFirstOrThrow({
      where: { userId: OWNER_ID, type: "IRREGULAR_RHYTHM_NOTIFICATION" },
    });
    const strip = await prisma.ecgRecording.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    expect({
      source: strip.source,
      externalRecordingId: strip.externalRecordingId,
      recordedAt: strip.recordedAt.toISOString(),
      samplingFrequency: strip.samplingFrequency,
      sampleCount: strip.sampleCount,
      durationSeconds: strip.durationSeconds,
      lead: strip.lead,
      averageHeartRate: strip.averageHeartRate,
      rhythmClassification: strip.rhythmClassification,
      measurementId: strip.measurementId,
      waveform: decryptWaveformFromBytes(strip.waveformEncrypted),
    }).toEqual({
      source: "WITHINGS",
      externalRecordingId: "round-trip-signal-1",
      recordedAt: "2026-06-15T14:22:00.000Z",
      samplingFrequency: 300,
      sampleCount: ECG_SAMPLES.length,
      durationSeconds: ECG_SAMPLES.length / 300,
      lead: "I",
      averageHeartRate: 88,
      rhythmClassification: "IRREGULAR",
      measurementId: restoredEvent.id,
      waveform: ECG_SAMPLES,
    });

    // The appointment's reminder reference survives too — same remap, other
    // referrer.
    const restoredEncounter = await prisma.encounter.findFirstOrThrow({
      where: { userId: OWNER_ID },
      select: { reminderId: true },
    });
    expect(
      restoredEncounter.reminderId,
      "the encounter's reminder reference must survive now that the reminder travels",
    ).toBe(restoredReminder.id);

    // The bests, read back column by column.
    //
    // Three rows came back, which the count above already said. What it could
    // not say is that they still describe three different records: the two
    // running bests share a metric type and an instant, so the slot is the
    // only thing separating "best 5 km" from "best 10 km", and `direction` is
    // the only thing that stops a best time being read as a worst one. The
    // measurement pointer is asserted against the row the RESTORE wrote rather
    // than against the id the fixture used, because resolving to something
    // that exists is the property the reference owes.
    const restoredTombstone = await prisma.measurement.findFirstOrThrow({
      where: { userId: OWNER_ID, externalId: "round-trip-deleted-sample" },
    });
    expect(
      {
        deletedAt: restoredTombstone.deletedAt?.toISOString() ?? null,
        syncVersion: restoredTombstone.syncVersion,
      },
      "the deleted reading came back, but not as a deletion — a tombstone " +
        "restored without its `deletedAt` is a resurrected measurement",
    ).toEqual({ deletedAt: "2026-07-20T09:15:00.000Z", syncVersion: 4 });

    const restoredMeasurement = await prisma.measurement.findFirstOrThrow({
      where: { userId: OWNER_ID, type: "WEIGHT" },
    });
    const bests = await prisma.personalRecord.findMany({
      where: { userId: OWNER_ID },
      orderBy: [{ achievedAt: "asc" }, { metricSlot: "asc" }],
    });
    expect(
      bests.map((best) => ({
        metricType: best.metricType,
        metricSlot: best.metricSlot,
        direction: best.direction,
        value: best.value,
        unit: best.unit,
        achievedAt: best.achievedAt.toISOString(),
        sourceMeasurementId: best.sourceMeasurementId,
        source: best.source,
        externalId: best.externalId,
      })),
      "each best must come back as its own record, with the direction and the sport slot that make it one",
    ).toEqual([
      {
        metricType: "WALKING_RUNNING_DISTANCE",
        metricSlot: "running_10km_time",
        direction: "MIN",
        value: 3184,
        unit: "s",
        achievedAt: "2026-05-18T09:20:00.000Z",
        sourceMeasurementId: null,
        source: "APPLE_HEALTH",
        externalId: "workout-pr-10km",
      },
      {
        metricType: "WALKING_RUNNING_DISTANCE",
        metricSlot: "running_5km_time",
        direction: "MIN",
        value: 1512,
        unit: "s",
        achievedAt: "2026-05-18T09:20:00.000Z",
        sourceMeasurementId: null,
        source: "APPLE_HEALTH",
        externalId: "workout-pr-5km",
      },
      {
        metricType: "WEIGHT",
        metricSlot: null,
        direction: "MIN",
        value: 74.2,
        unit: "kg",
        achievedAt: "2026-07-01T07:00:00.000Z",
        // Not `null`: the pointer resolved against a measurement this restore
        // actually wrote. A restore that nulled it would report the drop, and
        // one that wrote it before the measurements existed would fail the
        // foreign key rather than reach this line.
        sourceMeasurementId: restoredMeasurement.id,
        source: "MANUAL",
        externalId: null,
      },
    ]);

    // The badges, and the only field on them that matters.
    //
    // Both rows would come back from a restore that stamped `unlockedAt` with
    // the moment of the restore, and every count in this file would still be
    // green, while the account was handed a wall of badges it had apparently
    // earned all at once, today. Several of these dates cannot be re-derived
    // at all: the evaluator prefers a persisted date, and the counters behind
    // the login and Easter-egg badges are not in any backup.
    const badges = await prisma.userAchievement.findMany({
      where: { userId: OWNER_ID },
      orderBy: { unlockedAt: "asc" },
    });
    expect(
      badges.map((badge) => ({
        achievementId: badge.achievementId,
        unlockedAt: badge.unlockedAt.toISOString(),
      })),
      "a badge comes back with the day it was earned, and with the id it was earned under",
    ).toEqual([
      {
        // A definition this build does not ship, kept verbatim rather than
        // judged against the catalogue, the same answer the restore gives a
        // retired antigen slug.
        achievementId: "retired-badge-from-an-older-release",
        unlockedAt: "2025-11-05T08:00:00.000Z",
      },
      {
        achievementId: "intake-total-10",
        unlockedAt: "2026-02-21T10:15:00.000Z",
      },
    ]);

    // The environmental history, read back as a PAIR.
    //
    // Counting says two readings and one location period returned. It cannot
    // say that the trip day still knows it was a trip day, which is the whole
    // content of these rows: the coordinates, the label and `source` are what
    // separate a fortnight in Barcelona from a fortnight at home, and the
    // period is what keeps the next refresh from re-resolving the day and
    // upserting Berlin's weather over it.
    const readings = await prisma.environmentContext.findMany({
      where: { userId: OWNER_ID },
      orderBy: { date: "asc" },
    });
    expect(
      readings.map((reading) => ({
        date: reading.date,
        lat: reading.lat,
        lon: reading.lon,
        locationLabel: reading.locationLabel,
        source: reading.source,
        tempMean: reading.tempMean,
        pressureDelta: reading.pressureDelta,
        daylightSec: reading.daylightSec,
        weatherCode: reading.weatherCode,
        // Verbatim, not re-stamped: this says when the feed was read, and a
        // restore that wrote "now" would claim a two-year-old provisional
        // reading had just been confirmed.
        fetchedAt: reading.fetchedAt.toISOString(),
      })),
      "each day comes back at the place it was actually read for",
    ).toEqual([
      {
        date: "2026-06-15",
        lat: 41.3874,
        lon: 2.1686,
        locationLabel: "Barcelona",
        source: "TRAVEL",
        tempMean: 23.6,
        pressureDelta: 3.2,
        daylightSec: 52_800,
        weatherCode: 1,
        fetchedAt: "2026-06-16T03:15:00.000Z",
      },
      {
        date: "2026-07-01",
        lat: 52.52,
        lon: 13.405,
        locationLabel: "Berlin",
        source: "HOME",
        tempMean: 17.9,
        pressureDelta: 7.8,
        daylightSec: 59_400,
        weatherCode: 61,
        fetchedAt: "2026-07-02T03:15:00.000Z",
      },
    ]);

    // And the join between them, computed from what the restore wrote rather
    // than from the fixture: the trip day has to fall inside the restored
    // period and carry its coordinates. Both halves can be individually
    // non-empty and still disagree: a period whose bounds shifted by a day no
    // longer covers the reading it explains, and the reading goes back to
    // being weather from nowhere.
    const trip = await prisma.environmentTravelLocation.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    const travelDay = readings.find((reading) => reading.source === "TRAVEL")!;
    expect(
      {
        startDate: trip.startDate,
        endDate: trip.endDate,
        label: trip.label,
        covers:
          travelDay.date >= trip.startDate && travelDay.date <= trip.endDate,
        sameLat: trip.lat === travelDay.lat,
        sameLon: trip.lon === travelDay.lon,
      },
      "the period must still explain the reading it was exported beside",
    ).toEqual({
      startDate: "2026-06-10",
      endDate: "2026-06-20",
      label: "Barcelona",
      covers: true,
      sameLat: true,
      sameLon: true,
    });
  });

  /**
   * A supersede pointer that names a position the file does not have.
   *
   * The builder computes the index from the same list it writes, so no file
   * this release produces can trip this. A hand-edited or truncated one can,
   * and the question it asks has to be answered somewhere: the era it names
   * does not exist, the column is a bare id with no constraint to stop a
   * wrong value, and inventing a neighbouring era to point at would be worse
   * than either dropping or refusing.
   *
   * The answer is that the ERA restores and the POINTER does not, and the
   * position is reported. Refusing the file would cost an operator every era
   * of every drug over one bad integer; writing the link would put a
   * correction pointer at whatever row happened to be there.
   */
  it("keeps an archived era whose supersede pointer names a position out of range, and reports the position", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await createOwner(prisma);

    const medication = await prisma.medication.create({
      data: { userId: OWNER_ID, name: "Out-of-range tablet", dose: "5 mg" },
    });
    await prisma.medicationScheduleRevision.createMany({
      data: [
        {
          medicationId: medication.id,
          validFrom: AT("2026-01-01T00:00:00.000Z"),
          validUntil: AT("2026-02-01T00:00:00.000Z"),
          payload: [{ windowStart: "07:00", windowEnd: "09:00" }],
          source: "ARCHIVED",
        },
        {
          medicationId: medication.id,
          validFrom: AT("2026-02-01T00:00:00.000Z"),
          validUntil: AT("2026-03-01T00:00:00.000Z"),
          payload: [{ windowStart: "08:00", windowEnd: "10:00" }],
          source: "MANUAL",
        },
      ],
    });

    const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
      purpose: "disaster-recovery",
    });
    // Hand-edit the file the way a person with a text editor would: point the
    // first era at an era that is not there.
    const medications = payload.medications as Array<{
      scheduleRevisions: Array<{ supersededByIndex: number | null }>;
    }>;
    medications[0].scheduleRevisions[0].supersededByIndex = 7;

    await prisma.user.delete({ where: { id: OWNER_ID } });
    await createOwner(prisma);

    const backup = await prisma.dataBackup.create({
      data: {
        userId: OWNER_ID,
        type: "TWO_ENDED_ROUND_TRIP",
        data: encrypt(JSON.stringify(payload)),
      },
    });
    const response = await POST(
      new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as never,
      { params: Promise.resolve({ id: backup.id }) },
    );
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);

    const reported = body.data.skipped.catalogueKeys as Array<{
      catalogue: string;
      key: string;
      links: number;
    }>;
    expect(
      reported.filter((entry) => entry.catalogue === "scheduleRevisionLink"),
      "the position the file named is not in the file, so dropping the link " +
        "is correct and saying nothing about it is not",
    ).toEqual([
      {
        catalogue: "scheduleRevisionLink",
        key: "medications[0].scheduleRevisions[0].supersededByIndex=7",
        links: 1,
      },
    ]);

    const restoredEras = await prisma.medicationScheduleRevision.findMany({
      where: { medication: { userId: OWNER_ID } },
      orderBy: { validFrom: "asc" },
    });
    expect(
      restoredEras.map((era) => ({
        validFrom: era.validFrom.toISOString(),
        source: era.source,
        supersededByRevisionId: era.supersededByRevisionId,
      })),
      "both eras come back; only the pointer is lost",
    ).toEqual([
      {
        validFrom: "2026-01-01T00:00:00.000Z",
        source: "ARCHIVED",
        supersededByRevisionId: null,
      },
      {
        validFrom: "2026-02-01T00:00:00.000Z",
        source: "MANUAL",
        supersededByRevisionId: null,
      },
    ]);
  });

  /**
   * The reference a portable file genuinely lacks, and the slug the restore
   * must not judge.
   *
   * The reminders travel since v1.37.20, so a reference to one is no longer a
   * guaranteed drop — the round trip above proves it surviving. What can still
   * genuinely be missing is a TOMBSTONED reminder in a portable export: the
   * builder omits it (a restore must not resurrect a deletion) and omits its
   * completion ledger with it, while a live dose that recorded satisfying it
   * keeps its reference in the database. That reference then points at a row
   * the file does not carry, which is exactly the case the restore reports.
   *
   * Separated from the round trip above because this is correct behaviour
   * that shows up as a reported skip, and that test asserts nothing was
   * skipped. Reported is the whole point: a reference dropped in silence is
   * the same defect as a row dropped in silence, one field smaller.
   */
  it("reports the tombstoned reminder a portable file omits and keeps a slug it cannot resolve", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await createOwner(prisma);

    const reminder = await prisma.measurementReminder.create({
      data: {
        userId: OWNER_ID,
        label: "Tetanus booster",
        intervalDays: 3650,
        vaccinationAntigen: "tetanus",
        deletedAt: AT("2026-07-01T00:00:00.000Z"),
      },
    });
    // A ledger row on the tombstoned reminder. The builder must drop it from
    // the file along with its reminder — a ledger row whose reminder is not
    // carried could only ever restore as a reported loss.
    await prisma.measurementReminderEvent.create({
      data: {
        userId: OWNER_ID,
        reminderId: reminder.id,
        kind: "SATISFIED",
        occurredAt: AT("2026-06-01T09:00:00.000Z"),
        onTime: true,
        source: "vaccination",
      },
    });
    await prisma.vaccinationRecord.create({
      data: {
        userId: OWNER_ID,
        occurredAt: AT("1987-09-02T00:00:00.000Z"),
        // A slug no catalogue this release ships resolves. It must come back
        // exactly as written: the renderer degrades to `vaccineName`, and a
        // restore that dropped or rewrote it would lose what a person was
        // actually given.
        antigenSlug: "retired-antigen-from-an-older-release",
        vaccineName: "Whatever the Pass called it in 1987",
        reminderId: reminder.id,
      },
    });

    const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
      purpose: "portable-export",
    });
    // The file must be silent about the tombstoned reminder AND its ledger —
    // carrying the events of a reminder it refuses to restore would make
    // every portable file this release writes restore with a reported loss.
    expect(payload.measurementReminders).toEqual([]);
    expect(payload.measurementReminderEvents).toEqual([]);

    await prisma.user.delete({ where: { id: OWNER_ID } });
    await createOwner(prisma);

    const backup = await prisma.dataBackup.create({
      data: {
        userId: OWNER_ID,
        type: "TWO_ENDED_ROUND_TRIP",
        data: encrypt(JSON.stringify(payload)),
      },
    });
    const response = await POST(
      new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as never,
      { params: Promise.resolve({ id: backup.id }) },
    );
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);

    const reported = body.data.skipped.catalogueKeys as Array<{
      catalogue: string;
      key: string;
    }>;
    expect(
      reported.filter((entry) => entry.catalogue === "vaccinationReference"),
      "the reminder the dose pointed at is not in the backup at all, so " +
        "dropping the reference is correct and saying nothing about it is not",
    ).toEqual([
      { catalogue: "vaccinationReference", key: reminder.id, links: 1 },
    ]);

    const dose = await prisma.vaccinationRecord.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    expect({
      antigenSlug: dose.antigenSlug,
      vaccineName: dose.vaccineName,
      reminderId: dose.reminderId,
    }).toEqual({
      antigenSlug: "retired-antigen-from-an-older-release",
      vaccineName: "Whatever the Pass called it in 1987",
      reminderId: null,
    });
  });

  /**
   * The hand-edited file, which is the only way the vault filing can carry a
   * reference the restore cannot place.
   *
   * The builder carries a filing or a staged fact only when both of its ends
   * are carried, so no file this release writes reaches the drop path. That is
   * exactly why the path is worth a test of its own: an arm nothing exercises
   * is an arm nobody notices is wrong, and here being wrong has two very
   * different prices. `documentConditionLink.episodeId` is a real foreign key,
   * so writing it unchecked does not lose one edge — it violates a constraint
   * and rolls the WHOLE account back, which is what the mood categories did
   * before they travelled. `ExtractedFact.committedRecordId` is a bare id
   * column with no relation, so writing it unchecked costs no error at all and
   * simply leaves a fact pointing at a lab result that is not there.
   *
   * Both references are broken in the same file so the two answers can be seen
   * side by side: a dropped row and a nulled pointer, each named in the report,
   * and a restore that still answers 200.
   */
  it("drops and names a filing and a commitment a truncated file cannot resolve", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await createOwner(prisma);

    const episode = await prisma.illnessEpisode.create({
      data: {
        userId: OWNER_ID,
        label: "Iron deficiency",
        type: "CHRONIC",
        onsetAt: AT("2026-03-01T00:00:00.000Z"),
      },
    });
    const labResult = await prisma.labResult.create({
      data: {
        userId: OWNER_ID,
        analyte: "Ferritin",
        value: 91,
        unit: "ng/mL",
        takenAt: AT("2026-06-30T09:00:00.000Z"),
      },
    });
    const documentBytes = encryptBytes(Buffer.from("truncated-file fixture"));
    const contentEncrypted = new Uint8Array(
      new ArrayBuffer(documentBytes.byteLength),
    );
    contentEncrypted.set(documentBytes);
    const document = await prisma.inboundDocument.create({
      data: {
        userId: OWNER_ID,
        kind: "LAB_RESULT",
        title: "June labs",
        mimeType: "application/pdf",
        byteSize: documentBytes.byteLength,
        contentEncrypted,
        contentCodec: "binary2",
      },
    });
    await prisma.documentConditionLink.create({
      data: {
        userId: OWNER_ID,
        documentId: document.id,
        episodeId: episode.id,
      },
    });
    await prisma.extractedFact.create({
      data: {
        userId: OWNER_ID,
        documentId: document.id,
        factType: "OBSERVATION",
        status: "APPROVED",
        confidence: 0.9,
        needsReview: false,
        committedRecordId: labResult.id,
        committedRecordType: "labResult",
        dataEncrypted: encryptFactData({
          label: "Ferritin",
          code: null,
          codeSystem: null,
          value: 91,
          valueText: null,
          unit: "ng/mL",
          referenceLow: null,
          referenceHigh: null,
          effectiveDate: "2026-06-30",
        }),
        provenanceEncrypted: encryptFactProvenance({
          sourceText: EXTRACTED_FACT_SPAN,
          anchored: true,
          sourceOffset: 412,
          page: 2,
          confidence: 0.9,
        }),
      },
    });

    const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
      purpose: "disaster-recovery",
    });
    // The edit a truncated or hand-repaired file makes: both references now
    // name rows the file no longer carries.
    const edited = payload as typeof payload & {
      documentConditionLinks: Array<{ episodeId: string }>;
      extractedFacts: Array<{ committedRecordId: string | null }>;
    };
    edited.documentConditionLinks[0].episodeId = "condition-not-in-this-file";
    edited.extractedFacts[0].committedRecordId = "lab-not-in-this-file";

    await prisma.user.delete({ where: { id: OWNER_ID } });
    await createOwner(prisma);

    const backup = await prisma.dataBackup.create({
      data: {
        userId: OWNER_ID,
        type: "TWO_ENDED_ROUND_TRIP",
        data: encrypt(JSON.stringify(payload)),
      },
    });
    const response = await POST(
      new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as never,
      { params: Promise.resolve({ id: backup.id }) },
    );
    const body = await response.json();
    expect(
      response.status,
      "a filing naming a condition the file does not carry must cost that " +
        "filing, not the account",
    ).toBe(200);

    const reported = body.data.skipped.catalogueKeys as Array<{
      catalogue: string;
      key: string;
      links: number;
    }>;
    expect(
      reported.filter((entry) =>
        ["documentConditionLink", "factCommitment"].includes(entry.catalogue),
      ),
    ).toEqual([
      {
        catalogue: "documentConditionLink",
        key: "condition-not-in-this-file",
        links: 1,
      },
      { catalogue: "factCommitment", key: "lab-not-in-this-file", links: 1 },
    ]);

    // The filing is gone because it had nowhere to hang. The fact is NOT: what
    // it lost is a pointer that was already going nowhere, and the transcribed
    // reading is still the account's.
    expect(
      await prisma.documentConditionLink.count({ where: { userId: OWNER_ID } }),
    ).toBe(0);
    const survivor = await prisma.extractedFact.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    expect({
      status: survivor.status,
      needsReview: survivor.needsReview,
      committedRecordId: survivor.committedRecordId,
      committedRecordType: survivor.committedRecordType,
      data: decryptFactData(survivor.dataEncrypted),
    }).toEqual({
      status: "APPROVED",
      needsReview: false,
      // Nulled as a pair: a type with no id would claim a commitment the row
      // cannot name.
      committedRecordId: null,
      committedRecordType: null,
      data: {
        label: "Ferritin",
        code: null,
        codeSystem: null,
        value: 91,
        valueText: null,
        unit: "ng/mL",
        referenceLow: null,
        referenceHigh: null,
        effectiveDate: "2026-06-30",
      },
    });
  });

  /**
   * A note this instance can no longer decrypt leaves the export as a marker,
   * not as nothing.
   *
   * A fail-soft decrypt answers `null` on a wrong or dropped key, and in a
   * portable file `null` is byte-for-byte what a note that was never written
   * looks like. The restore importer then writes no note, so a note the person
   * did write is gone and no one is told — the whole loss fits inside a
   * fail-soft `catch` written for a list view, where returning null is right.
   *
   * The Coach transcript and the doctor report both refuse that trade, one
   * with a placeholder sentence and one with a rendered flag. This asserts the
   * lab note now does the same, and that the marker is still there after the
   * file has been through a real restore: the ciphertext is unreadable either
   * way, but a person opening the restored account can see that something was
   * there rather than believing they never wrote it.
   */
  it("carries a lab note it cannot decrypt through the round trip as a visible marker", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await createOwner(prisma);

    const biomarker = await prisma.biomarker.create({
      data: { userId: OWNER_ID, name: "Ferritin", unit: "ng/mL" },
    });
    // Ciphertext under a key id this instance does not hold — the shape a row
    // written before a key rotation that dropped its key has. `decrypt` is
    // fail-closed on an unknown key id, so this throws rather than returning
    // garbage, which is the case the soft helper swallowed.
    const unreadable = new Uint8Array(
      Buffer.from("v9.AAAAAAAAAAAAAAAAAAAAAAAA", "utf8"),
    );
    await prisma.labResult.create({
      data: {
        userId: OWNER_ID,
        biomarkerId: biomarker.id,
        analyte: "Ferritin",
        value: 91,
        unit: "ng/mL",
        takenAt: AT("2026-06-30T09:00:00.000Z"),
        noteEncrypted: unreadable,
      },
    });
    await prisma.biomarker.update({
      where: { id: biomarker.id },
      data: { contextEncrypted: unreadable },
    });

    const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
      purpose: "portable-export",
    });

    const exported = payload.labResults as Array<{ note: string | null }>;
    expect(exported).toHaveLength(1);
    expect(exported[0].note).toContain("unreadable");
    const exportedBiomarkers = payload.biomarkers as Array<{
      context: string | null;
    }>;
    expect(exportedBiomarkers[0].context).toContain("unreadable");

    await prisma.user.delete({ where: { id: OWNER_ID } });
    await createOwner(prisma);

    const backup = await prisma.dataBackup.create({
      data: {
        userId: OWNER_ID,
        type: "TWO_ENDED_ROUND_TRIP",
        data: encrypt(JSON.stringify(payload)),
      },
    });
    const response = await POST(
      new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as never,
      { params: Promise.resolve({ id: backup.id }) },
    );
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);

    const restoredLab = await prisma.labResult.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    // Back in the column it came from, readable again because the restore
    // re-encrypted it under the CURRENT key — and saying what happened.
    expect(restoredLab.noteEncrypted).not.toBeNull();
    expect(decryptNoteFromBytes(restoredLab.noteEncrypted!)).toBe(
      UNREADABLE_EXPORT_MARKER,
    );

    const restoredBiomarker = await prisma.biomarker.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    expect(decryptContextFromBytes(restoredBiomarker.contextEncrypted!)).toBe(
      UNREADABLE_EXPORT_MARKER,
    );
  });
});
