/**
 * The account the backup tests fill: one row of every two-ended model, the
 * shapes a CHECK constraint ties to a particular row, and the values the
 * column fill uses where a type alone would produce one the restore refuses.
 *
 * Shared by `backup-round-trip.test.ts`, which proves each model and column
 * comes back, and `backup-parity.test.ts`, which pins the whole file and the
 * restored account against a golden copy.
 */
import { createHash } from "node:crypto";

import type { PrismaClient } from "@/generated/prisma/client";
import { encrypt, encryptBytes } from "@/lib/crypto";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { sealDayCountry } from "@/lib/dawarich/connection";
import { sealLocation } from "@/lib/environment/location-cipher";
import { encryptFactData, encryptFactProvenance } from "@/lib/documents/store";
import { encryptWaveformToBytes } from "@/lib/withings/ecg-waveform-codec";
import { encryptContextToBytes } from "@/lib/labs/biomarker-store";
import type { AuditColumn, AuditModel } from "./backup-column-audit";
import { cookieJar } from "./mock-next-headers";

export const OWNER_ID = "round-trip-owner";
export const AT = (iso: string) => new Date(iso);
// The restore drops a measurement tombstone older than
// `TOMBSTONE_RETENTION_DAYS` on purpose, so the fixture's deletion has to stay
// recent on whatever day the suite runs. A fixed date aged out on 2026-10-03.
export const TOMBSTONE_DELETED_AT = new Date(
  Math.floor((Date.now() - 10 * 86_400_000) / 1000) * 1000,
).toISOString();
export const PHQ9_RESPONSES = JSON.stringify({
  items: [2, 1, 2, 2, 1, 1, 2, 1, 2],
  schema: 1,
});
export const CONSENT_ARTEFACT = "JVBERi0xLjQKJWZpeHR1cmU=";
export const INVENTORY_NOTE = "second pack, kept in the kitchen drawer";
export const COACH_FACT = "does not tolerate ACE inhibitors";
// v1.41 — the model text of a turn's trail, stored encrypted beside the turn.
export const COACH_TRAIL_JSON = JSON.stringify({
  entries: [{ id: "a1", title: "Checking the trend", text: "Read 30 days." }],
});
export const COACH_PLAN_CUE = "if the evening reading is over 140";
export const COACH_PLAN_ACTION =
  "then walk twenty minutes before dinner tomorrow";
export const COACH_REMINDER_NOTE = "ask how the evening walks are going";
export const COACH_SUMMARY = "earlier turns: weight trend and evening walks";
export const METRIC_LEGACY_NOTE = "left hand, after the long ride";
export const METRIC_SEALED_NOTE = "right hand, rested";
export const COACH_USER_TURN =
  "my readings look higher this week, is that real?";
export const COACH_ASSISTANT_TURN =
  "the last seven mornings average 4 mmHg above the fortnight before";
/** The table of values the assistant turn read: ciphertext at rest. */
export const COACH_RESULTS_JSON = JSON.stringify([
  {
    ref: "r1",
    source: {
      tool: "get_metric_series",
      domain: "bp",
      window: "last7days",
      period: "current",
      granularity: "day",
    },
    shape: "timeSeries",
    titleKey: "coach.result.title.metricByPeriod",
    title: "Blood pressure by day",
    rowCount: 2,
    chartKind: "line",
    displayed: true,
    columns: [
      {
        key: "period",
        kind: "period",
        labelKey: "coach.result.column.day",
        label: "Day",
      },
      {
        key: "sys",
        kind: "number",
        labelKey: "coach.result.column.systolic",
        label: "Systolic",
        unit: "mmHg",
      },
    ],
    rows: [
      ["2026-07-19", 131],
      ["2026-07-20", null],
    ],
    truncated: false,
    chart: { kind: "line", x: "period", series: ["sys"] },
  },
]);
export const ROUND_TRIP_CATEGORY_KEY =
  "custom:5f0c6a52-6a43-4f63-9b39-0c1f4d7e2a10";
export const DOSE_CHANGE_NOTE = "titration note, encrypted at rest";
export const EXTRACTED_FACT_SPAN = "Ferritin  91 ng/mL   (30 - 400)";
export const SIDE_EFFECT_NOTE = "nausea for two hours after the evening dose";
/** A short micro-volt strip. Long enough that a defaulted empty array shows. */
export const ECG_SAMPLES = [-12, 4, 118, -33, 7, 2, -5, 61];

/**
 * One row of every two-ended model, for one account.
 *
 * Minimal on purpose: this file asks whether a row survives the round trip, and
 * a fat fixture only makes the answer slower to get. The mood factor and the
 * cycle symptom are the account's OWN custom rows rather than seeded catalogue
 * entries, because a catalogue row survives the account being deleted and would
 * make the link tables look restored when nothing restored them.
 */
export async function seedEveryTwoEndedModel(
  prisma: PrismaClient,
): Promise<void> {
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
      deletedAt: AT(TOMBSTONE_DELETED_AT),
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

  // Two courses with a gap, and the window the row projects from them (the
  // latest). The earlier course exists nowhere else once it has ended. The
  // latest was ended with "End course" (#1280), so the instant has to come
  // back with it.
  const medication = await prisma.medication.create({
    data: {
      userId: OWNER_ID,
      name: "Round-trip tablet",
      dose: "5 mg",
      startsOn: AT("2026-06-10T00:00:00.000Z"),
      endsOn: AT("2026-06-16T00:00:00.000Z"),
      endedAt: AT("2026-06-16T09:30:00.000Z"),
      schedules: {
        create: { windowStart: "08:00", windowEnd: "09:00", label: "Morning" },
      },
      courses: {
        create: [
          {
            userId: OWNER_ID,
            startsOn: AT("2026-03-01T00:00:00.000Z"),
            endsOn: AT("2026-03-07T00:00:00.000Z"),
            noteEncrypted: encryptToBytes("the March flu"),
          },
          {
            userId: OWNER_ID,
            startsOn: AT("2026-06-10T00:00:00.000Z"),
            endsOn: AT("2026-06-16T00:00:00.000Z"),
            endedAt: AT("2026-06-16T09:30:00.000Z"),
          },
        ],
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
  // Not OTHER: a missing row already reads as OTHER, so only a chosen value
  // proves the category came back. A category the person named, so the
  // assignment can only resolve if the label came back before it.
  await prisma.medicationCategoryLabel.create({
    data: {
      userId: OWNER_ID,
      key: ROUND_TRIP_CATEGORY_KEY,
      labelEncrypted: encryptToBytes("Heart and circulation"),
      sortOrder: 2,
    },
  });
  await prisma.medicationCategoryAssignment.create({
    data: { medicationId: medication.id, category: ROUND_TRIP_CATEGORY_KEY },
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

  // v1.43 — a composition entered in a non-canonical unit, so the entered
  // amount and unit are set too.
  await prisma.medicationIngredient.create({
    data: {
      userId: OWNER_ID,
      medicationId: medication.id,
      nutrient: "vitamin_d",
      amountPerUnit: 25,
      unit: "ug",
      enteredAmount: 1000,
      enteredUnit: "IU",
      source: "LABEL_AI",
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
  // Another spelling of the marker, and the ledger row of a marker that was
  // merged into it: both ride the marker (D1223).
  await prisma.biomarkerAlias.create({
    data: {
      userId: OWNER_ID,
      biomarkerId: biomarker.id,
      name: "Ferr.",
      nameFolded: "ferr.",
      source: "IMPORT_CHOICE",
    },
  });
  await prisma.biomarkerMerge.create({
    data: {
      userId: OWNER_ID,
      targetBiomarkerId: biomarker.id,
      sourceBiomarkerId: "merged-away-marker",
      sourceName: "Ferritin (Serum)",
      readingCount: 3,
    },
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
      // v1.39.2 — a condition's body site and side travel too.
      bodySiteEncrypted: encryptToBytes("Stomach"),
      laterality: "BOTH",
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

  // v1.40 — two of the person's own symptoms and three occurrences: one filed
  // against the open cold, one with a note, one on its own in the gap.
  const aura = await prisma.symptomDefinition.create({
    data: {
      userId: OWNER_ID,
      labelEncrypted: encryptToBytes("Aura"),
      icon: "Zap",
      sortOrder: 0,
    },
  });
  const headache = await prisma.symptomDefinition.create({
    data: {
      userId: OWNER_ID,
      labelEncrypted: encryptToBytes("Headache"),
      icon: "Brain",
      sortOrder: 1,
      isActive: false,
    },
  });
  await prisma.symptomEvent.create({
    data: {
      userId: OWNER_ID,
      definitionId: aura.id,
      occurredAt: AT("2026-06-21T09:00:00.000Z"),
      intensity: 4,
      episodeId: episode.id,
    },
  });
  await prisma.symptomEvent.create({
    data: {
      userId: OWNER_ID,
      definitionId: headache.id,
      occurredAt: AT("2026-06-21T11:00:00.000Z"),
      intensity: 8,
      noteEncrypted: encryptToBytes("left side, behind the eye"),
    },
  });
  await prisma.symptomEvent.create({
    data: {
      userId: OWNER_ID,
      definitionId: aura.id,
      occurredAt: AT("2026-07-10T18:30:00.000Z"),
      intensity: 2,
    },
  });

  // v1.42 — two life events: a move known to the month, with a note, and a
  // period known to the day.
  await prisma.lifeEvent.create({
    data: {
      userId: OWNER_ID,
      category: "HOME",
      startDate: "2023-09-01",
      precision: "MONTH",
      titleEncrypted: encryptToBytes("Moved to the coast"),
      noteEncrypted: encryptToBytes("the flat with the long hallway"),
    },
  });
  await prisma.lifeEvent.create({
    data: {
      userId: OWNER_ID,
      category: "WORK",
      startDate: "2026-03-02",
      endDate: "2026-05-29",
      precision: "DAY",
      titleEncrypted: encryptToBytes("Parental leave"),
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
      // v1.39.3 — one reading whose note is still readable (a row the
      // free-text backfill has not reached) and one sealed the current way.
      // Both must come back sealed, and neither readable.
      entries: {
        create: [
          {
            userId: OWNER_ID,
            value: 44,
            unit: "kg",
            measuredAt: AT("2026-07-01T18:00:00.000Z"),
            note: METRIC_LEGACY_NOTE,
          },
          {
            userId: OWNER_ID,
            value: 45,
            unit: "kg",
            measuredAt: AT("2026-07-02T18:00:00.000Z"),
            noteEncrypted: encryptToBytes(METRIC_SEALED_NOTE),
          },
        ],
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
      // Imported (#1038): the source key has to survive the trip, or a
      // re-run of the importer after a restore stores the page twice.
      sourceSystem: "PAPERLESS",
      sourceId: "4711",
      // Held back from automatic AI reading; a restore that dropped the
      // marker would hand the page to the summary catch-up.
      aiReadDeferred: true,
    },
  });

  // An imported page the person deleted and the purge then removed: only the
  // ledger remembers it, and a restore that dropped the row would let the
  // importer store it again.
  await prisma.documentImportKey.create({
    data: {
      userId: OWNER_ID,
      sourceSystem: "PAPRA",
      sourceId: "doc_deleted",
      sourceInstance: "https://papra.example",
      createdAt: AT("2026-07-03T09:00:00.000Z"),
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
            resultsEncrypted: encryptToBytes(COACH_RESULTS_JSON),
            trailEncrypted: encryptToBytes(COACH_TRAIL_JSON),
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
      // v1.39.3 — sealed the current way; the thread above keeps a readable
      // legacy title, the shape of a row the backfill has not reached.
      titleEncrypted: encryptToBytes("About my June labs"),
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
  const healthAnswer = await prisma.coachMessage.findFirstOrThrow({
    where: { conversationId: healthThread.id, role: "assistant" },
  });
  await prisma.coachFact.create({
    data: {
      userId: OWNER_ID,
      factEncrypted: encryptToBytes(COACH_FACT),
      category: "constraint",
      confidence: 80,
      sourceConversationId: healthThread.id,
      source: "user",
      lastUsedAt: AT("2026-07-20T10:00:00.000Z"),
      sourceMessageId: healthAnswer.id,
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
  // v1.42 (#1005) — the person's own vaccine definition the dose also names.
  // The catalogue slug still wins on read; the reference is what has to
  // survive the trip, and it can only if the definition comes back first.
  const customVaccine = await prisma.customVaccine.create({
    data: {
      userId: OWNER_ID,
      name: "Round-trip travel combo",
      components: ["typhoid", "hepatitis-a"],
      typicalSeriesDoses: 2,
      boosterIntervalMonths: 36,
    },
  });
  const vaccination = await prisma.vaccinationRecord.create({
    data: {
      userId: OWNER_ID,
      occurredAt: AT("2026-05-14T00:00:00.000Z"),
      customVaccineId: customVaccine.id,
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

  // v1.43 — one row in each of the five relation link tables, joining the
  // records seeded above.
  await prisma.labResultDocumentLink.create({
    data: {
      userId: OWNER_ID,
      labResultId: labResult.id,
      documentId: document.id,
    },
  });
  await prisma.encounterMedicationLink.create({
    data: {
      userId: OWNER_ID,
      encounterId: encounter.id,
      medicationId: medication.id,
    },
  });
  await prisma.encounterVaccinationLink.create({
    data: {
      userId: OWNER_ID,
      encounterId: encounter.id,
      vaccinationId: vaccination.id,
    },
  });
  await prisma.medicationDocumentLink.create({
    data: {
      userId: OWNER_ID,
      medicationId: medication.id,
      documentId: document.id,
    },
  });
  await prisma.medicationConditionLink.create({
    data: {
      userId: OWNER_ID,
      medicationId: medication.id,
      episodeId: episode.id,
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
  // it. The assertion after the restore reads the two back TOGETHER. The
  // coordinates are at 1 decimal, the precision the app stores since v1.39.4;
  // a restore rounds anything finer, so finer values would not round-trip.
  // Since v1.42 the location is stored sealed (`locationEncrypted`), the way
  // the writers store it; it is the only copy since v1.43.
  // v1.43 — one Dawarich day abroad, with its sealed country.
  await prisma.dawarichDay.create({
    data: {
      userId: OWNER_ID,
      date: "2026-06-15",
      totalDistanceM: 48_300,
      drivingDistanceM: 12_000,
      trainDistanceM: 30_500,
      placesVisited: 4,
      awayFromHomeMinutes: 1440,
      countryCodeEncrypted: sealDayCountry("ES"),
      isTravelDay: true,
      fetchedAt: new Date("2026-06-16T03:20:00.000Z"),
    },
  });
  await prisma.environmentTravelLocation.create({
    data: {
      userId: OWNER_ID,
      startDate: "2026-06-10",
      endDate: "2026-06-20",
      locationEncrypted: sealLocation({
        lat: 41.4,
        lon: 2.2,
        label: "Barcelona",
      }),
    },
  });
  await prisma.environmentContext.createMany({
    data: [
      {
        userId: OWNER_ID,
        date: "2026-06-15",
        locationEncrypted: sealLocation({
          lat: 41.4,
          lon: 2.2,
          label: "Barcelona",
        }),
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
        locationEncrypted: sealLocation({
          lat: 52.5,
          lon: 13.4,
          label: "Berlin",
        }),
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

export async function createOwner(prisma: PrismaClient) {
  return prisma.user.create({
    data: {
      id: OWNER_ID,
      username: "round-trip-owner",
      email: "round-trip-owner@example.test",
    },
  });
}

export async function seedAdminSession(prisma: PrismaClient) {
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

/**
 * Columns the restore is right not to bring back verbatim, by `Model.column`.
 * Every other column of every two-ended model must come back with the value
 * it left with. An entry here whose column no longer exists fails the run.
 */
export const COLUMN_EXCLUSIONS: Readonly<Record<string, string>> = {
  "MeasurementReminder.lastNotifiedAt":
    "operational repeat cursor, documented on the column as not in the backup: a restored reminder re-reminds at most once, on its next notify hour",
};

/**
 * Columns the restore carries on purpose as "set where it was set" rather
 * than the same value, each with the reason. A presence check still fails a
 * column that stops coming back at all.
 */
export const COLUMN_PRESENCE_ONLY: Readonly<Record<string, string>> = {
  "Medication.autoMarkTakenSince":
    "the auto-take floor restarts at the restore, so doses a portable file cannot carry as removed are not filled again; pinned in the restore test for it",
};

/**
 * Values for columns the fixture leaves empty where the type alone does not
 * produce one the export and the restore accept.
 */
export const FILL_OVERRIDES: Readonly<Record<string, unknown>> = {
  "MedicationSchedule.rrule": "FREQ=WEEKLY;BYDAY=MO,TH",
  "InboundDocument.sourceInstance": "https://paperless.example.test",
  // The digest of the fixture's own document bytes, so a restore that checks
  // it against the content finds them consistent.
  "InboundDocument.contentSha256": createHash("sha256")
    .update("round-trip document bytes")
    .digest("hex"),
  "Biomarker.contextEncrypted": () =>
    encryptContextToBytes("fasted, morning draw"),
  "MoodEntry.tags": JSON.stringify(["round-trip-tag"]),
  // A closed set (ASSESSMENT_WORDINGS); the export carries nothing else.
  "MentalHealthAssessment.wording": "unvalidated_translation",
  "CorrelationPattern.qValue": 0.04,
  "CorrelationPattern.dismissedEvidenceHash": "ab".repeat(32),
  // CHECK in migration 0408: the profile is built from samples or from hour buckets.
  "IntradayCumulativeProfile.basis": "HOUR_BUCKETS",
  // The posted hours are a whole day of slots (-1 for an hour not posted);
  // the restore refuses any other length, as it does for the curve.
  "IntradayCumulativeProfile.hourlyIncrements": Array.from(
    { length: 24 },
    (_, hour) => (hour < 6 ? -1 : 350),
  ),
};

/**
 * Rows for the columns a CHECK constraint ties to a shape the base fixture
 * does not have: a stage only on a sleep reading, a context only on a glucose
 * reading, a rolling interval only on a schedule without a calendar rule.
 */
export async function seedColumnShapes(prisma: PrismaClient): Promise<void> {
  await prisma.measurement.create({
    data: {
      userId: OWNER_ID,
      type: "BLOOD_GLUCOSE",
      value: 5.4,
      unit: "mmol/L",
      measuredAt: AT("2026-07-03T06:45:00.000Z"),
      source: "MANUAL",
      glucoseContext: "FASTING",
    },
  });
  await prisma.measurement.create({
    data: {
      userId: OWNER_ID,
      type: "SLEEP_DURATION",
      value: 95,
      unit: "min",
      measuredAt: AT("2026-07-03T02:00:00.000Z"),
      source: "APPLE_HEALTH",
      externalId: "round-trip-deep-sleep",
      sleepStage: "DEEP",
    },
  });
  // A start logged out of order and folded into the one before it: soft
  // deleted, and pointing at the start that absorbed it so that removing that
  // start can bring this one back.
  const absorbing = await prisma.menstrualCycle.findFirstOrThrow({
    where: { userId: OWNER_ID, startDate: "2026-06-01" },
  });
  await prisma.menstrualCycle.create({
    data: {
      userId: OWNER_ID,
      startDate: "2026-06-03",
      deletedAt: AT("2026-06-04T07:00:00.000Z"),
      absorbedIntoId: absorbing.id,
    },
  });
  const medication = await prisma.medication.findFirstOrThrow({
    where: { userId: OWNER_ID },
  });
  await prisma.medicationSchedule.create({
    data: {
      medicationId: medication.id,
      windowStart: "20:00",
      windowEnd: "21:00",
      label: "Every third evening",
      rollingIntervalDays: 3,
    },
  });
}

export type Delegate = {
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, "asc" | "desc">[];
  }): Promise<Record<string, unknown>[]>;
  update(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<unknown>;
};

export function delegateOf(prisma: PrismaClient, model: AuditModel): Delegate {
  return (prisma as unknown as Record<string, Delegate>)[model.delegate];
}

export function primaryKeyWhere(
  model: AuditModel,
  row: Record<string, unknown>,
): Record<string, unknown> {
  if (model.primaryKey.length === 1) {
    return { [model.primaryKey[0]]: row[model.primaryKey[0]] };
  }
  return {
    [model.primaryKey.join("_")]: Object.fromEntries(
      model.primaryKey.map((k) => [k, row[k]]),
    ),
  };
}

/** How a column is compared, or why it is not. */
export function comparison(
  column: AuditColumn,
): "value" | "presence" | { excluded: string } {
  const key = `${column.model}.${column.name}`;
  if (key in COLUMN_EXCLUSIONS) return { excluded: COLUMN_EXCLUSIONS[key] };
  if (column.isId) {
    return { excluded: "primary key; the restore may mint a fresh one" };
  }
  if (column.name === "userId") {
    return { excluded: "owner; re-derived from the restoring account" };
  }
  if (column.isUpdatedAt) {
    return { excluded: "@updatedAt; Prisma stamps it on the restore's write" };
  }
  // A declared foreign key may be re-pointed at a row the restore minted, so
  // it is held to being set where it was set, not to the same id.
  if (column.isForeignKey) return "presence";
  if (key in COLUMN_PRESENCE_ONLY) return "presence";
  return "value";
}

/**
 * A 1x1 PNG: the smallest picture the avatar upload, and so the restore,
 * accepts.
 */
export const AVATAR_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/**
 * Values for `User` columns where the type alone would produce one the
 * restore rightly refuses: a vocabulary, a time zone, an AI endpoint, a
 * threshold band, an image.
 */
export const USER_FILL_OVERRIDES: Readonly<Record<string, unknown>> = {
  "User.gender": "FEMALE",
  "User.locale": "fr",
  "User.timezone": "America/Chicago",
  "User.homeTimezone": "Asia/Tokyo",
  "User.unitPreference": "imperial",
  "User.glucoseUnit": "mmol/L",
  "User.insightsPrivacyMode": "raw",
  "User.aiProvider": "LOCAL",
  "User.aiBaseUrl": "https://llm.example.com/v1",
  "User.aiCompatBaseUrl": "https://gateway.example.com/v1",
  "User.thresholdsJson": { WEIGHT: { min: 60, max: 80 } },
  // The restore admits goal by goal against the goals schema, so the generic
  // `{ roundTrip }` blob would be refused as an unknown key, not carried.
  "User.activityGoalsJson": { workoutsPerWeek: 4, stepsPerMonth: 250_000 },
  "User.globalExcludedInjectionSites": ["THIGH_LEFT"],
  "User.avatarBytes": () => {
    const bytes = new Uint8Array(new ArrayBuffer(AVATAR_PNG.byteLength));
    bytes.set(AVATAR_PNG);
    return bytes;
  },
  "User.avatarContentType": "image/png",
  // v1.42 — a sealed home the way the writers seal it, so it opens.
  "User.homeLocationEncrypted": () =>
    sealLocation({ lat: 2.5, lon: 2.5, label: "round-trip home" }),
};
