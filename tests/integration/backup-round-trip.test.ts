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
import { decrypt, decryptBytes, encrypt, encryptBytes } from "@/lib/crypto";
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { openLocation } from "@/lib/environment/location-cipher";
import { readNote } from "@/lib/crypto/note-cipher";
import {
  decryptFactData,
  decryptFactProvenance,
  encryptFactData,
  encryptFactProvenance,
} from "@/lib/documents/store";
import { decryptWaveformFromBytes } from "@/lib/withings/ecg-waveform-codec";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import {
  resolveMedicationCategories,
  setMedicationCategory,
} from "@/lib/medication-category";
import { UNREADABLE_EXPORT_MARKER } from "@/lib/export/unreadable-marker";
import { decryptNoteFromBytes } from "@/lib/labs/store";
import { decryptContextFromBytes } from "@/lib/labs/biomarker-store";
import { legacyStreamedBlobFrom } from "@/__tests__/helpers/legacy-backup-blob";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";
import { BackupKeyIdCollector } from "@/lib/export/backup-key-ids";
import { createBackupPreviewCollector } from "@/lib/export/backup-preview";
import { parseBackupPayload } from "@/lib/validations/backup";
import { summarizeBackup } from "@/lib/validations/backup-summary";
import { TWO_ENDED_MODELS, type TwoEndedModel } from "@/lib/export/backup-plan";
import {
  ACCOUNT_SETTING_COLUMNS,
  USER_COLUMN_BACKUP_CLASS,
} from "@/lib/export/account-settings-backup";
import { parseOnboardingSteps } from "@/lib/onboarding/needs";
import { POST } from "./restore-job-driver";
import {
  type AuditColumn,
  type AuditModel,
  enumValuesFromSchema,
  isDefaultValue,
  normalise,
  ownerWhere,
  readAuditModels,
  syntheticValue,
} from "./backup-column-audit";
import {
  OWNER_ID,
  AT,
  TOMBSTONE_DELETED_AT,
  PHQ9_RESPONSES,
  CONSENT_ARTEFACT,
  INVENTORY_NOTE,
  COACH_FACT,
  COACH_TRAIL_JSON,
  COACH_PLAN_CUE,
  COACH_PLAN_ACTION,
  COACH_REMINDER_NOTE,
  COACH_SUMMARY,
  METRIC_LEGACY_NOTE,
  METRIC_SEALED_NOTE,
  COACH_USER_TURN,
  COACH_ASSISTANT_TURN,
  COACH_RESULTS_JSON,
  ROUND_TRIP_CATEGORY_KEY,
  DOSE_CHANGE_NOTE,
  EXTRACTED_FACT_SPAN,
  SIDE_EFFECT_NOTE,
  ECG_SAMPLES,
  seedEveryTwoEndedModel,
  createOwner,
  seedAdminSession,
  COLUMN_EXCLUSIONS,
  COLUMN_PRESENCE_ONLY,
  FILL_OVERRIDES,
  seedColumnShapes,
  delegateOf,
  primaryKeyWhere,
  comparison,
  USER_FILL_OVERRIDES,
} from "./backup-fixture";

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
  // No own `userId` column — reached through the drug, like the schedules.
  MedicationCategoryAssignment: (p, userId) =>
    p.medicationCategoryAssignment.count({ where: { medication: { userId } } }),
  MedicationCategoryLabel: (p, userId) =>
    p.medicationCategoryLabel.count({ where: { userId } }),
  MedicationIngredient: (p, userId) =>
    p.medicationIngredient.count({ where: { userId } }),
  MedicationCourse: (p, userId) =>
    p.medicationCourse.count({ where: { userId } }),
  MoodEntry: (p, userId) => p.moodEntry.count({ where: { userId } }),
  MoodContext: (p, userId) => p.moodContext.count({ where: { userId } }),
  MoodEntryTagLink: (p, userId) =>
    p.moodEntryTagLink.count({ where: { moodEntry: { userId } } }),
  MoodTag: (p, userId) => p.moodTag.count({ where: { userId } }),
  LabResult: (p, userId) => p.labResult.count({ where: { userId } }),
  Biomarker: (p, userId) => p.biomarker.count({ where: { userId } }),
  BiomarkerAlias: (p, userId) => p.biomarkerAlias.count({ where: { userId } }),
  BiomarkerMerge: (p, userId) => p.biomarkerMerge.count({ where: { userId } }),
  Allergy: (p, userId) => p.allergy.count({ where: { userId } }),
  FamilyHistoryEntry: (p, userId) =>
    p.familyHistoryEntry.count({ where: { userId } }),
  IllnessEpisode: (p, userId) => p.illnessEpisode.count({ where: { userId } }),
  IllnessDayLog: (p, userId) => p.illnessDayLog.count({ where: { userId } }),
  SymptomDefinition: (p, userId) =>
    p.symptomDefinition.count({ where: { userId } }),
  SymptomEvent: (p, userId) => p.symptomEvent.count({ where: { userId } }),
  LifeEvent: (p, userId) => p.lifeEvent.count({ where: { userId } }),
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
  LabResultDocumentLink: (p, userId) =>
    p.labResultDocumentLink.count({ where: { userId } }),
  EncounterMedicationLink: (p, userId) =>
    p.encounterMedicationLink.count({ where: { userId } }),
  EncounterVaccinationLink: (p, userId) =>
    p.encounterVaccinationLink.count({ where: { userId } }),
  MedicationDocumentLink: (p, userId) =>
    p.medicationDocumentLink.count({ where: { userId } }),
  MedicationConditionLink: (p, userId) =>
    p.medicationConditionLink.count({ where: { userId } }),
  CustomVaccine: (p, userId) => p.customVaccine.count({ where: { userId } }),
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
  DocumentImportKey: (p, userId) =>
    p.documentImportKey.count({ where: { userId } }),
  PersonalRecord: (p, userId) => p.personalRecord.count({ where: { userId } }),
  UserAchievement: (p, userId) =>
    p.userAchievement.count({ where: { userId } }),
  EnvironmentContext: (p, userId) =>
    p.environmentContext.count({ where: { userId } }),
  EnvironmentTravelLocation: (p, userId) =>
    p.environmentTravelLocation.count({ where: { userId } }),
  DawarichDay: (p, userId) => p.dawarichDay.count({ where: { userId } }),
  EcgRecording: (p, userId) => p.ecgRecording.count({ where: { userId } }),
  // No own `userId` column — reached through the drug, like the schedules.
  MedicationEfficacyTarget: (p, userId) =>
    p.medicationEfficacyTarget.count({ where: { medication: { userId } } }),
  MedicationScheduleRevision: (p, userId) =>
    p.medicationScheduleRevision.count({ where: { medication: { userId } } }),
  OnboardingRecord: (p, userId) =>
    p.onboardingRecord.count({ where: { userId } }),
};

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
    const previewCollector = await createBackupPreviewCollector();
    const streamedCounts = await streamFullBackupJson(
      prisma,
      OWNER_ID,
      (chunk) => {
        streamedJson += chunk;
      },
      {
        purpose: "disaster-recovery",
        exportedAt,
        observe: previewCollector.observe,
      },
    );
    expect(
      streamedJson,
      "the streaming writer and the materialising builder disagree; the " +
        "weekly backup no longer contains what this test proves restorable",
    ).toBe(JSON.stringify(payload));

    // The weekly copy's restore preview is taken from the writer's counts and
    // the sections it was shown, never by reading the copy. On an account
    // with a row in every model, it has to say what a full read of the copy
    // says, count for count and key use for key use.
    const fromWriter = previewCollector.finish(streamedCounts);
    expect(fromWriter).not.toBeNull();
    expect(
      fromWriter!.summary,
      "the preview taken from the writer's counts disagrees with a full read",
    ).toEqual(summarizeBackup(parseBackupPayload(streamedJson)));
    const readBack = new BackupKeyIdCollector();
    readBack.visit(JSON.parse(streamedJson));
    expect(fromWriter!.keys.toStored()).toEqual(readBack.toStored());

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
      deletedAt: TOMBSTONE_DELETED_AT,
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
        data: await legacyStreamedBlobFrom(async (write) => {
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
    expect({
      sourceSystem: vaultDocument.sourceSystem,
      sourceId: vaultDocument.sourceId,
      aiReadDeferred: vaultDocument.aiReadDeferred,
    }).toEqual({
      sourceSystem: "PAPERLESS",
      sourceId: "4711",
      aiReadDeferred: true,
    });
    const metricEntries = await prisma.customMetricEntry.findMany({
      where: { userId: OWNER_ID },
      orderBy: { measuredAt: "asc" },
    });
    expect(
      metricEntries.map((entry) => ({
        note: readNote(entry.noteEncrypted, entry.note),
        readable: entry.note,
      })),
      "both reading notes come back, sealed, with nothing readable",
    ).toEqual([
      { note: METRIC_LEGACY_NOTE, readable: null },
      { note: METRIC_SEALED_NOTE, readable: null },
    ]);
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
        title: readNote(thread.titleEncrypted, thread.title),
        // A restore seals every title and never writes the readable column.
        readableTitle: thread.title,
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
          results: message.resultsEncrypted
            ? decryptFromBytes(message.resultsEncrypted)
            : null,
          trail: message.trailEncrypted
            ? decryptFromBytes(message.trailEncrypted)
            : null,
        })),
        attachments: thread.attachments.map((a) => a.documentId),
      })),
      "the transcript, the fence and the provenance all come back",
    ).toEqual([
      {
        title: "How is my blood pressure trending?",
        readableTitle: null,
        documentScoped: false,
        summary: COACH_SUMMARY,
        summaryTurnCount: 4,
        turns: [
          {
            role: "user",
            content: COACH_USER_TURN,
            model: null,
            tokensUsed: null,
            results: null,
            trail: null,
          },
          {
            role: "assistant",
            content: COACH_ASSISTANT_TURN,
            model: "claude-opus-5",
            tokensUsed: 812,
            results: COACH_RESULTS_JSON,
            trail: COACH_TRAIL_JSON,
          },
        ],
        attachments: [],
      },
      {
        title: "About my June labs",
        readableTitle: null,
        documentScoped: true,
        summary: null,
        summaryTurnCount: 0,
        turns: [
          {
            role: "user",
            content: "What does the ferritin mean?",
            model: null,
            tokensUsed: null,
            results: null,
            trail: null,
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
    const restoredAnswer = await prisma.coachMessage.findFirstOrThrow({
      where: { conversationId: restoredThread.id, role: "assistant" },
    });
    expect({
      fact: decryptFromBytes(fact.factEncrypted),
      category: fact.category,
      confidence: fact.confidence,
      source: fact.sourceConversationId,
      origin: fact.source,
      lastUsedAt: fact.lastUsedAt?.toISOString(),
      sourceMessageId: fact.sourceMessageId,
      deletedAt: fact.deletedAt,
    }).toEqual({
      fact: COACH_FACT,
      category: "constraint",
      confidence: 80,
      source: restoredThread.id,
      origin: "user",
      lastUsedAt: "2026-07-20T10:00:00.000Z",
      sourceMessageId: restoredAnswer.id,
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
        customVaccine: true,
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
      customVaccine: dose.customVaccine
        ? {
            name: dose.customVaccine.name,
            components: dose.customVaccine.components,
            typicalSeriesDoses: dose.customVaccine.typicalSeriesDoses,
            boosterIntervalMonths: dose.customVaccine.boosterIntervalMonths,
          }
        : null,
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
      customVaccine: {
        name: "Round-trip travel combo",
        components: ["typhoid", "hepatitis-a"],
        typicalSeriesDoses: 2,
        boosterIntervalMonths: 36,
      },
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

    // The condition's body site and side (v1.39.2). A restore that dropped
    // either would still return the right number of episodes; the site must
    // come back as ciphertext that reads as what was typed, and the side as
    // it was.
    const sitedEpisode = await prisma.illnessEpisode.findFirstOrThrow({
      where: { userId: OWNER_ID, label: "Iron deficiency" },
      select: { bodySiteEncrypted: true, laterality: true },
    });
    expect(
      {
        bodySite: sitedEpisode.bodySiteEncrypted
          ? decryptFromBytes(sitedEpisode.bodySiteEncrypted)
          : null,
        laterality: sitedEpisode.laterality,
      },
      "a condition's body site and side must survive the round trip",
    ).toEqual({ bodySite: "Stomach", laterality: "BOTH" });

    // v1.40 — the person's own symptoms: the names decrypt to what was typed,
    // each occurrence keeps its time, intensity and note, and the one filed
    // against the cold still points at the cold.
    const restoredSymptoms = await prisma.symptomDefinition.findMany({
      where: { userId: OWNER_ID },
      orderBy: { sortOrder: "asc" },
      include: {
        events: {
          orderBy: { occurredAt: "asc" },
          include: { episode: { select: { label: true } } },
        },
      },
    });
    expect(
      restoredSymptoms.map((definition) => ({
        label: decryptFromBytes(definition.labelEncrypted),
        icon: definition.icon,
        isActive: definition.isActive,
        events: definition.events.map((event) => ({
          at: event.occurredAt.toISOString(),
          intensity: event.intensity,
          note: event.noteEncrypted
            ? decryptFromBytes(event.noteEncrypted)
            : null,
          episode: event.episode?.label ?? null,
        })),
      })),
      "symptom definitions and their occurrences must survive the round trip",
    ).toEqual([
      {
        label: "Aura",
        icon: "Zap",
        isActive: true,
        events: [
          {
            at: "2026-06-21T09:00:00.000Z",
            intensity: 4,
            note: null,
            episode: "Cold",
          },
          {
            at: "2026-07-10T18:30:00.000Z",
            intensity: 2,
            note: null,
            episode: null,
          },
        ],
      },
      {
        label: "Headache",
        icon: "Brain",
        isActive: false,
        events: [
          {
            at: "2026-06-21T11:00:00.000Z",
            intensity: 8,
            note: "left side, behind the eye",
            episode: null,
          },
        ],
      },
    ]);

    // v1.42 — the life events: the titles and the note decrypt to what was
    // typed, and the dates keep their precision.
    const restoredLifeEvents = await prisma.lifeEvent.findMany({
      where: { userId: OWNER_ID },
      orderBy: { startDate: "asc" },
    });
    expect(
      restoredLifeEvents.map((event) => ({
        category: event.category,
        startDate: event.startDate,
        endDate: event.endDate,
        precision: event.precision,
        title: decryptFromBytes(event.titleEncrypted),
        note: event.noteEncrypted
          ? decryptFromBytes(event.noteEncrypted)
          : null,
      })),
      "life events must survive the round trip",
    ).toEqual([
      {
        category: "HOME",
        startDate: "2023-09-01",
        endDate: null,
        precision: "MONTH",
        title: "Moved to the coast",
        note: "the flat with the long hallway",
      },
      {
        category: "WORK",
        startDate: "2026-03-02",
        endDate: "2026-05-29",
        precision: "DAY",
        title: "Parental leave",
        note: null,
      },
    ]);

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
    ).toEqual({ deletedAt: TOMBSTONE_DELETED_AT, syncVersion: 4 });

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
        // The sealed location, opened (v1.42).
        ...(({ lat, lon, label }) => ({ lat, lon, locationLabel: label }))(
          openLocation(reading.locationEncrypted!),
        ),
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
        lat: 41.4,
        lon: 2.2,
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
        lat: 52.5,
        lon: 13.4,
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
    const tripPlace = openLocation(trip.locationEncrypted!);
    const dayPlace = openLocation(travelDay.locationEncrypted!);
    expect(
      {
        startDate: trip.startDate,
        endDate: trip.endDate,
        label: tripPlace.label,
        covers:
          travelDay.date >= trip.startDate && travelDay.date <= trip.endDate,
        sameLat: tripPlace.lat === dayPlace.lat,
        sameLon: tripPlace.lon === dayPlace.lon,
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
  /**
   * The Coach's stored tables through a portable file.
   *
   * A disaster-recovery file carries them as ciphertext (the round trip at
   * the top of this file). A portable file has to carry them readable, like
   * the prose they sit beside, and the restore has to seal them again under
   * the target's key. A restore that dropped the readable JSON would bring
   * the thread back with every answer's table missing and nothing to say so.
   */
  it.each(["disaster-recovery", "portable-export"] as const)(
    "carries each medication's category through a %s round trip",
    async (purpose) => {
      const prisma = getPrismaClient();
      await seedAdminSession(prisma);
      await createOwner(prisma);
      const thyroid = await prisma.medication.create({
        data: { userId: OWNER_ID, name: "Levothyroxine", dose: "50 µg" },
      });
      const mood = await prisma.medication.create({
        data: { userId: OWNER_ID, name: "Sertraline", dose: "50 mg" },
      });
      await prisma.medication.create({
        data: { userId: OWNER_ID, name: "Unfiled", dose: "1 tab" },
      });
      const travel = await prisma.medication.create({
        data: { userId: OWNER_ID, name: "Tamiflu", dose: "75 mg" },
      });
      await setMedicationCategory(thyroid.id, "THYROID");
      await setMedicationCategory(mood.id, "MENTAL_HEALTH");
      // v1.40 — a category the person named. Hidden, because a hidden
      // category still files the medication and must travel with it.
      await prisma.medicationCategoryLabel.create({
        data: {
          userId: OWNER_ID,
          key: ROUND_TRIP_CATEGORY_KEY,
          labelEncrypted: encryptToBytes("Travel kit"),
          isActive: false,
        },
      });
      await setMedicationCategory(travel.id, ROUND_TRIP_CATEGORY_KEY);

      const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
        purpose,
      });
      const exported = Object.fromEntries(
        (payload.medications as Array<{ name: string; category?: string }>).map(
          (m) => [m.name, m.category],
        ),
      );
      expect(exported).toEqual({
        Levothyroxine: "THYROID",
        Sertraline: "MENTAL_HEALTH",
        Unfiled: "OTHER",
        Tamiflu: ROUND_TRIP_CATEGORY_KEY,
      });
      // A portable file carries the label readable; a disaster-recovery file
      // carries its ciphertext, like every other sealed column.
      expect(payload.customMedicationCategories).toEqual([
        purpose === "disaster-recovery"
          ? {
              key: ROUND_TRIP_CATEGORY_KEY,
              label: null,
              labelEncrypted: expect.any(String),
              sortOrder: 0,
              isActive: false,
              createdAt: expect.any(String),
              updatedAt: expect.any(String),
            }
          : {
              key: ROUND_TRIP_CATEGORY_KEY,
              label: "Travel kit",
              sortOrder: 0,
              isActive: false,
              createdAt: expect.any(String),
            },
      ]);

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
      expect(response.status, JSON.stringify(await response.json())).toBe(200);

      const restored = await prisma.medication.findMany({
        where: { userId: OWNER_ID },
        select: { id: true, name: true },
      });
      const categories = await resolveMedicationCategories(
        restored.map((m) => m.id),
      );
      expect(
        Object.fromEntries(restored.map((m) => [m.name, categories[m.id]])),
      ).toEqual({
        Levothyroxine: { category: "THYROID", categoryLabel: null },
        Sertraline: { category: "MENTAL_HEALTH", categoryLabel: null },
        Unfiled: { category: "OTHER", categoryLabel: null },
        Tamiflu: {
          category: ROUND_TRIP_CATEGORY_KEY,
          categoryLabel: "Travel kit",
        },
      });
      const label = await prisma.medicationCategoryLabel.findUniqueOrThrow({
        where: { key: ROUND_TRIP_CATEGORY_KEY },
      });
      expect(label.isActive).toBe(false);
    },
  );

  it("carries a turn's tables readable in a portable file and seals them again on restore", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await createOwner(prisma);
    await prisma.coachConversation.create({
      data: {
        userId: OWNER_ID,
        titleEncrypted: encryptToBytes("How is my blood pressure trending?"),
        documentScoped: false,
        messages: {
          create: [
            {
              role: "assistant",
              encryptedContent: encryptToBytes(COACH_ASSISTANT_TURN),
              resultsEncrypted: encryptToBytes(COACH_RESULTS_JSON),
              trailEncrypted: encryptToBytes(COACH_TRAIL_JSON),
              createdAt: AT("2026-07-20T09:59:00.000Z"),
            },
          ],
        },
      },
    });

    const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
      purpose: "portable-export",
    });
    const { coachConversations } = payload as {
      coachConversations: Array<{ messages: Array<Record<string, unknown>> }>;
    };
    const [turn] = coachConversations[0].messages;
    expect(turn).toMatchObject({
      resultsJson: COACH_RESULTS_JSON,
      trailJson: COACH_TRAIL_JSON,
    });
    expect(turn).not.toHaveProperty("resultsEncrypted");
    expect(turn).not.toHaveProperty("trailEncrypted");

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
    expect(response.status, JSON.stringify(await response.json())).toBe(200);

    const restored = await prisma.coachMessage.findFirstOrThrow({
      where: { conversation: { userId: OWNER_ID } },
    });
    expect(restored.resultsEncrypted).not.toBeNull();
    expect(decryptFromBytes(restored.resultsEncrypted!)).toBe(
      COACH_RESULTS_JSON,
    );
    expect(restored.trailEncrypted).not.toBeNull();
    expect(decryptFromBytes(restored.trailEncrypted!)).toBe(COACH_TRAIL_JSON);
  });

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

  /**
   * #1028 — a medication's creation instant is the floor of its expected
   * slots: every adherence surface counts a slot before it only when a
   * recorded dose claims it. A restore that stamped the restore time as the
   * creation turned the whole restored history into "before the medication
   * existed", so its misses dropped out of the rate. Both file purposes must
   * bring the creation instant back.
   */
  for (const purpose of ["portable-export", "disaster-recovery"] as const) {
    it(`restores a medication's creation instant from a ${purpose} file`, async () => {
      const prisma = getPrismaClient();
      await seedAdminSession(prisma);
      await createOwner(prisma);
      const createdAt = AT("2025-11-03T16:05:00.000Z");
      await prisma.medication.create({
        data: {
          userId: OWNER_ID,
          name: "Metformin",
          dose: "500mg",
          createdAt,
          schedules: {
            create: {
              windowStart: "08:00",
              windowEnd: "08:00",
              timesOfDay: ["08:00"],
            },
          },
        },
      });

      const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
        purpose,
      });
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
      expect(response.status, JSON.stringify(await response.json())).toBe(200);

      const restored = await prisma.medication.findFirstOrThrow({
        where: { userId: OWNER_ID, name: "Metformin" },
      });
      expect(restored.createdAt.toISOString()).toBe(createdAt.toISOString());
    });
  }
});

/**
 * Columns a release adds ahead of the backup ends that carry them, so the
 * packages built in parallel on its branch each own their own section of the
 * export and the restore. NOT an exclusion: each entry names the package that
 * carries it, and the companion assertion fails as soon as an entry's column
 * starts coming back, so the entry has to go in the change that carries it.
 * The list is empty again before the release is tagged.
 */
const RELEASE_PENDING_COLUMNS: Readonly<Record<string, string>> = {};

/**
 * Columns every reader parses through one function before using, compared
 * through that same function: the restore writes the parsed form.
 */
const READ_THROUGH: Readonly<Record<string, (value: unknown) => unknown>> = {
  "OnboardingRecord.stepsJson": parseOnboardingSteps,
};

/** Plaintext behind a sealed value, or the value itself when it is not one. */
function opened(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    try {
      return `text:${decrypt(value)}`;
    } catch {
      return `text:${value}`;
    }
  }
  if (value instanceof Uint8Array) {
    for (const open of BYTE_OPENERS) {
      try {
        return `text:${open(value)}`;
      } catch {
        continue;
      }
    }
  }
  return normalise(value);
}

/** Every codec a sealed byte column is written with. */
const BYTE_OPENERS: ReadonlyArray<(value: Uint8Array) => string> = [
  decryptFromBytes,
  decryptNoteFromBytes,
  decryptContextFromBytes,
  // v1.42 — the sealed environment locations, under their own label.
  (value) => JSON.stringify(openLocation(value)),
  (value) => decryptBytes(Buffer.from(value)).toString("base64"),
];

/**
 * A legacy plaintext column beside its sealed twin (`note` / `noteEncrypted`)
 * is one value in two places: the restore seals what it finds in either, and
 * clears the plaintext. So the pair is compared as the value a reader sees.
 */
function readerValue(
  row: Record<string, unknown>,
  column: AuditColumn,
): string {
  const parse = READ_THROUGH[`${column.model}.${column.name}`];
  if (parse) return normalise(parse(row[column.name]));
  const twin = `${column.name}Encrypted`;
  if (twin in row) {
    const sealed = opened(row[twin]);
    return sealed !== "null" ? sealed : opened(row[column.name]);
  }
  return opened(row[column.name]);
}

function columnValues(
  rows: Record<string, unknown>[],
  column: AuditColumn,
  how: "value" | "presence",
): string[] {
  return rows
    .map((row) =>
      how === "presence"
        ? row[column.name] === null || row[column.name] === undefined
          ? "null"
          : "set"
        : readerValue(row, column),
    )
    .sort();
}

async function snapshot(
  prisma: PrismaClient,
  models: AuditModel[],
  wheres: Map<string, Record<string, unknown>>,
): Promise<Map<string, Record<string, unknown>[]>> {
  const out = new Map<string, Record<string, unknown>[]>();
  for (const model of models) {
    out.set(
      model.name,
      await delegateOf(prisma, model).findMany({
        where: wheres.get(model.name)!,
      }),
    );
  }
  return out;
}

/**
 * Columns whose value differs between two snapshots, by `Model.column`. Pure,
 * so the test can show it catches a column it was never told about.
 */
function lostColumns(
  models: AuditModel[],
  before: Map<string, Record<string, unknown>[]>,
  after: Map<string, Record<string, unknown>[]>,
): { lost: string[]; compared: number } {
  const lost: string[] = [];
  let compared = 0;
  for (const model of models) {
    for (const column of model.columns) {
      const how = comparison(column);
      if (typeof how === "object") continue;
      const plain = column.name.replace(/Encrypted$/, "");
      if (
        plain !== column.name &&
        model.columns.some((c) => c.name === plain)
      ) {
        continue; // compared through its plaintext twin, see readerValue
      }
      compared += 1;
      const was = columnValues(before.get(model.name) ?? [], column, how);
      const is = columnValues(after.get(model.name) ?? [], column, how);
      if (normalise(was) !== normalise(is)) {
        lost.push(`${model.name}.${column.name}`);
      }
    }
  }
  return { lost: lost.sort(), compared };
}

/**
 * Sections a portable file may carry stored ciphertext in, each with the
 * reason. Empty: every sealed column travels readable in a portable file.
 */
const PORTABLE_CIPHERTEXT_ALLOWED: ReadonlyMap<string, string> = new Map();

describe("every column of every two-ended model survives a real restore", () => {
  it("brings each column back with the value it left with", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await createOwner(prisma);
    // A catalogue row the fixture adds, which survives both the account delete
    // and the per-test truncation; left behind by the first test in this file.
    await prisma.illnessSymptom.deleteMany({
      where: { key: "round_trip_cough" },
    });
    await seedEveryTwoEndedModel(prisma);
    await seedColumnShapes(prisma);

    const models = readAuditModels(prisma, TWO_ENDED_MODELS);
    const byName = new Map(models.map((m) => [m.name, m]));
    const wheres = new Map(
      models.map((m) => [m.name, ownerWhere(byName, prisma, m.name, OWNER_ID)]),
    );
    const enumValues = enumValuesFromSchema();

    // Fill what the fixture left empty, so an empty column cannot come back
    // empty and read as carried. One column at a time on one row, so a value
    // the database refuses names its column instead of failing the batch.
    const unfillable: string[] = [];
    const seededRows = await snapshot(prisma, models, wheres);
    for (const model of models) {
      const rows = seededRows.get(model.name)!;
      expect(rows.length, `${model.name} seeded no row`).toBeGreaterThan(0);
      for (const column of model.columns) {
        if (
          comparison(column) !== "value" &&
          !(`${model.name}.${column.name}` in COLUMN_PRESENCE_ONLY)
        ) {
          continue;
        }
        // Filling it would turn the fixture's row into a tombstone, and which
        // models carry tombstones is a row decision, not a column one.
        if (column.name === "deletedAt") continue;
        if (rows.some((row) => !isDefaultValue(column, row[column.name]))) {
          continue;
        }
        try {
          await delegateOf(prisma, model).update({
            where: primaryKeyWhere(model, rows[0]),
            data: {
              [column.name]: syntheticValue(column, enumValues, FILL_OVERRIDES),
            },
          });
        } catch (error) {
          unfillable.push(
            `${model.name}.${column.name}: ${String(error).split("\n").slice(-3).join(" ").slice(0, 200)}`,
          );
        }
      }
    }
    expect(unfillable, "columns the fill could not set").toEqual([]);

    const before = await snapshot(prisma, models, wheres);

    const exportedAt = new Date("2026-08-01T00:00:00.000Z");
    let json = "";
    const previewCollector = await createBackupPreviewCollector();
    const counts = await streamFullBackupJson(
      prisma,
      OWNER_ID,
      (chunk) => {
        json += chunk;
      },
      {
        purpose: "disaster-recovery",
        exportedAt,
        observe: previewCollector.observe,
      },
    );
    // Every sealed column is filled here: the key uses the preview takes from
    // the sections as they are written are the ones a read of the file finds.
    const keysReadBack = new BackupKeyIdCollector();
    keysReadBack.visit(JSON.parse(json));
    expect(keysReadBack.keyIds().length).toBeGreaterThan(0);
    expect(previewCollector.finish(counts)!.keys.toStored()).toEqual(
      keysReadBack.toStored(),
    );

    // ── No ciphertext in a portable file ──────────────────────────────────
    //
    // Every sealed column is filled at this point, so the portable file of
    // this account is the one place a column still exported as stored
    // ciphertext shows up. A portable file is read and restored on hosts
    // with other keys; ciphertext in it is noise there, and a restore either
    // refuses the file or writes values nobody can open. That class was
    // fixed one section at a time (cycle, mood labels, visits, vaccinations)
    // and kept coming back, because each builder decides its own encoding.
    // This reads what the builders actually wrote, rather than how their
    // source is spelt. Limit: it sees members named `…Encrypted` only, the
    // naming the key preflight relies on too.
    const sealedIn = (text: string) => {
      const collector = new BackupKeyIdCollector();
      collector.visit(JSON.parse(text));
      const sections = new Map<string, number>();
      for (const [, use] of collector.entries()) {
        for (const section of use.sections) {
          sections.set(section, (sections.get(section) ?? 0) + use.count);
        }
      }
      return sections;
    };
    // The floor: the same matcher over the disaster-recovery file of the same
    // account, which carries every sealed column as ciphertext. A matcher
    // that finds nothing there would make the portable check pass vacuously.
    const drSealed = sealedIn(json);
    expect(
      [...drSealed.values()].reduce((a, b) => a + b, 0),
    ).toBeGreaterThanOrEqual(40);
    expect(drSealed.size).toBeGreaterThanOrEqual(15);
    let portableJson = "";
    await streamFullBackupJson(
      prisma,
      OWNER_ID,
      (chunk) => {
        portableJson += chunk;
      },
      { purpose: "portable-export", exportedAt },
    );
    const portableSealed = [...sealedIn(portableJson).keys()].filter(
      (section) => !PORTABLE_CIPHERTEXT_ALLOWED.has(section),
    );
    expect(
      portableSealed,
      "a portable file carries these sections' sealed columns as stored " +
        "ciphertext. Carry them readable (`src/lib/export/sealed-text.ts`) " +
        "and seal them again on restore, or name the section in " +
        "PORTABLE_CIPHERTEXT_ALLOWED with the reason",
    ).toEqual([]);

    await prisma.user.delete({ where: { id: OWNER_ID } });
    await createOwner(prisma);
    const backup = await prisma.dataBackup.create({
      data: {
        userId: OWNER_ID,
        type: "COLUMN_ROUND_TRIP",
        data: await legacyStreamedBlobFrom(async (write) => {
          await write(json);
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

    const after = await snapshot(prisma, models, wheres);
    const { lost, compared } = lostColumns(models, before, after);

    // A comparison over no columns agrees with everything. 632 at the time of
    // writing; the headroom is for a column dropped by a migration, not for a
    // data model that stopped being read.
    expect(compared).toBeGreaterThanOrEqual(620);
    expect(
      lost.filter((key) => !(key in RELEASE_PENDING_COLUMNS)),
      "these columns left with a value and came back without it. Carry each " +
        "through the export and the restore, or name it in COLUMN_EXCLUSIONS " +
        "with the reason the restore is right to drop it",
    ).toEqual([]);
    expect(
      Object.keys(RELEASE_PENDING_COLUMNS).filter((key) => !lost.includes(key)),
      "these RELEASE_PENDING_COLUMNS entries come back now — drop them",
    ).toEqual([]);
  });

  it("notices a column nobody told it about", () => {
    const model: AuditModel = {
      name: "Probe",
      delegate: "probe",
      primaryKey: ["id"],
      parents: {},
      columns: [
        {
          model: "Probe",
          name: "addedTomorrow",
          kind: "scalar",
          type: "String",
          isList: false,
          isOptional: true,
          isId: false,
          isUpdatedAt: false,
          isForeignKey: false,
          defaultText: null,
        },
      ],
    };
    const before = new Map([["Probe", [{ id: "a", addedTomorrow: "kept" }]]]);
    const after = new Map([["Probe", [{ id: "b", addedTomorrow: null }]]]);
    expect(lostColumns([model], before, after)).toEqual({
      lost: ["Probe.addedTomorrow"],
      compared: 1,
    });
  });

  it("names no exclusion for a column that no longer exists", () => {
    const models = readAuditModels(getPrismaClient(), TWO_ENDED_MODELS);
    const known = new Set(
      models.flatMap((m) => m.columns.map((c) => `${m.name}.${c.name}`)),
    );
    const stale = [
      ...Object.keys(COLUMN_EXCLUSIONS),
      ...Object.keys(COLUMN_PRESENCE_ONLY),
      ...Object.keys(RELEASE_PENDING_COLUMNS),
      ...Object.keys(READ_THROUGH),
      ...Object.keys(FILL_OVERRIDES),
    ].filter((key) => !known.has(key));
    expect(stale).toEqual([]);
  });
});

/**
 * Columns of the account row the restore writes for reasons of its own, so
 * "unchanged on the target" does not apply to them.
 */
const USER_ROW_STAMPED: Readonly<Record<string, string>> = {
  updatedAt: "@updatedAt; Prisma stamps it on the restore's write",
  syncResetAt:
    "the restore stamps it so paired clients' delta cursors are refused",
};

describe("the account's own settings survive a real restore", () => {
  it("brings every setting column back and leaves the rest of the target's row alone", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await createOwner(prisma);

    const [userModel] = readAuditModels(prisma, ["User"]);
    const enumValues = enumValuesFromSchema();
    const settings = new Set<string>(ACCOUNT_SETTING_COLUMNS);
    const classes = USER_COLUMN_BACKUP_CLASS as Readonly<
      Record<string, string>
    >;

    // Every column the source account can be given a non-default value in,
    // settings and everything else alike: a credential that came back on the
    // target is as much a failure as a setting that did not.
    const fillable = userModel.columns.filter(
      (column) =>
        !column.isId &&
        !column.isUpdatedAt &&
        column.name !== "username" &&
        column.name !== "role",
    );
    const unfillable: string[] = [];
    for (const column of fillable) {
      try {
        await prisma.user.update({
          where: { id: OWNER_ID },
          data: {
            [column.name]: syntheticValue(
              column,
              enumValues,
              USER_FILL_OVERRIDES,
            ),
          },
        });
      } catch (error) {
        unfillable.push(
          `${column.name}: ${String(error).split("\n").slice(-3).join(" ").slice(0, 200)}`,
        );
      }
    }
    expect(unfillable, "columns the fill could not set").toEqual([]);
    const source = (await prisma.user.findUniqueOrThrow({
      where: { id: OWNER_ID },
    })) as unknown as Record<string, unknown>;
    const defaulted = [...settings].filter((name) =>
      isDefaultValue(
        userModel.columns.find((c) => c.name === name)!,
        source[name],
      ),
    );
    expect(
      defaulted,
      "these settings still hold their default, so coming back with the " +
        "default would read as carried",
    ).toEqual([]);

    let json = "";
    await streamFullBackupJson(
      prisma,
      OWNER_ID,
      (chunk) => {
        json += chunk;
      },
      {
        purpose: "disaster-recovery",
        exportedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    );
    // Nothing but setting columns reaches the file, and no secret at all.
    const section = (JSON.parse(json) as { accountSettings: object })
      .accountSettings;
    expect(
      Object.keys(section).filter(
        (key) => !settings.has(key) && key !== "insuranceNumber",
      ),
    ).toEqual([]);

    // A fresh account under the same id, the way an operator recreates one
    // on a new host, given credentials of its own that must survive.
    await prisma.user.delete({ where: { id: OWNER_ID } });
    await createOwner(prisma);
    await prisma.user.update({
      where: { id: OWNER_ID },
      data: {
        passwordHash: "target-account-password-hash",
        aiOpenaiKeyEncrypted: encrypt("target account key"),
        totpSecretEncrypted: encrypt("target account totp"),
      },
    });
    const target = (await prisma.user.findUniqueOrThrow({
      where: { id: OWNER_ID },
    })) as unknown as Record<string, unknown>;

    const backup = await prisma.dataBackup.create({
      data: {
        userId: OWNER_ID,
        type: "ACCOUNT_SETTINGS_ROUND_TRIP",
        data: await legacyStreamedBlobFrom(async (write) => {
          await write(json);
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
    const refused = (
      body.data.skipped.catalogueKeys as Array<{ catalogue: string }>
    ).filter((entry) => entry.catalogue === "accountSetting");
    expect(refused, "the restore refused a setting the fixture set").toEqual(
      [],
    );

    const after = (await prisma.user.findUniqueOrThrow({
      where: { id: OWNER_ID },
    })) as unknown as Record<string, unknown>;

    const lost = [...settings].filter(
      (name) => opened(after[name]) !== opened(source[name]),
    );
    expect(
      lost,
      "these settings left with a value and came back without it",
    ).toEqual([]);
    expect(settings.size).toBeGreaterThanOrEqual(55);

    const overwritten = userModel.columns
      .map((column) => column.name)
      .filter(
        (name) =>
          classes[name] !== "SETTING" && !Object.hasOwn(USER_ROW_STAMPED, name),
      )
      .filter((name) => opened(after[name]) !== opened(target[name]));
    expect(
      overwritten,
      "the restore changed these identity, credential or bookkeeping columns " +
        "on the account it restored into",
    ).toEqual([]);
  });
});

describe("automatic dose recording after a restore", () => {
  it("starts its floor at the restore, so a dose removed before the export stays removed", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await createOwner(prisma);
    await prisma.user.update({
      where: { id: OWNER_ID },
      data: { timezone: "UTC" },
    });
    const now = Date.now();
    const dayAt12 = (offset: number) => {
      const d = new Date(now + offset * 86_400_000);
      return new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12),
      );
    };
    const since = dayAt12(-10);
    const medication = await prisma.medication.create({
      data: {
        userId: OWNER_ID,
        name: "Evening supplement",
        dose: "1",
        createdAt: dayAt12(-20),
        autoMarkTaken: true,
        autoMarkTakenSince: since,
        schedules: {
          create: {
            windowStart: "12:00",
            windowEnd: "12:00",
            timesOfDay: ["12:00"],
            rrule: "FREQ=DAILY",
            scheduleType: "SCHEDULED",
          },
        },
      },
      select: { id: true },
    });
    // The pass filled the last days; the person removed the dose two days
    // ago (they did not take it). A portable file carries no removal.
    const removed = dayAt12(-2);
    for (let offset = -6; offset <= -1; offset++) {
      const at = dayAt12(offset);
      await prisma.medicationIntakeEvent.create({
        data: {
          userId: OWNER_ID,
          medicationId: medication.id,
          scheduledFor: at,
          takenAt: at,
          source: "REMINDER",
          autoRecorded: true,
          deletedAt:
            at.getTime() === removed.getTime()
              ? new Date(at.getTime() + 3_600_000)
              : null,
        },
      });
    }

    const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
      purpose: "portable-export",
    });
    await prisma.user.delete({ where: { id: OWNER_ID } });
    await createOwner(prisma);
    const backup = await prisma.dataBackup.create({
      data: {
        userId: OWNER_ID,
        type: "TWO_ENDED_ROUND_TRIP",
        data: encrypt(JSON.stringify(payload)),
      },
    });
    const restoredFrom = Date.now();
    const response = await POST(
      new Request(`http://localhost/api/admin/backups/${backup.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as never,
      { params: Promise.resolve({ id: backup.id }) },
    );
    expect(response.status).toBe(200);

    const restored = await prisma.medication.findFirstOrThrow({
      where: { userId: OWNER_ID },
      select: { id: true, autoMarkTaken: true, autoMarkTakenSince: true },
    });
    expect(restored.autoMarkTaken).toBe(true);
    expect(restored.autoMarkTakenSince!.getTime()).toBeGreaterThanOrEqual(
      restoredFrom,
    );

    const { runIntakeAutoTakePass } =
      await import("@/lib/jobs/intake-auto-take");
    await runIntakeAutoTakePass(prisma, { nowMs: Date.now() });
    const onRemovedSlot = await prisma.medicationIntakeEvent.count({
      where: {
        medicationId: restored.id,
        deletedAt: null,
        scheduledFor: removed,
      },
    });
    expect(onRemovedSlot).toBe(0);
  });
});

describe("a document kind added after the backup format", () => {
  it("restores a sick note as a sick note", async () => {
    const prisma = getPrismaClient();
    await seedAdminSession(prisma);
    await createOwner(prisma);
    const documentBytes = encryptBytes(Buffer.from("sick note fixture"));
    const contentEncrypted = new Uint8Array(
      new ArrayBuffer(documentBytes.byteLength),
    );
    contentEncrypted.set(documentBytes);
    await prisma.inboundDocument.create({
      data: {
        userId: OWNER_ID,
        kind: "SICK_NOTE",
        title: "Certificate of incapacity",
        mimeType: "application/pdf",
        byteSize: documentBytes.byteLength,
        contentEncrypted,
        contentCodec: "binary2",
      },
    });

    const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
      purpose: "disaster-recovery",
    });
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
    expect(response.status, JSON.stringify(await response.json())).toBe(200);

    const restored = await prisma.inboundDocument.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    expect(restored.kind).toBe("SICK_NOTE");
    expect(restored.title).toBe("Certificate of incapacity");
  });
});
