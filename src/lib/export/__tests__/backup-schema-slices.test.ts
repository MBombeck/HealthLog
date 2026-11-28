/**
 * Every backup slice against the same contract (`slice-contract.ts`): a
 * well-formed row restores whole, a row missing what its table needs is
 * refused naming the field, empty identifiers and wrong kinds are refused,
 * defaults fill absent fields, and bounds hold at the edge.
 *
 * The whole-payload tests (`src/lib/validations/__tests__/backup*.test.ts`)
 * mostly carry these sections empty, so a slice that stopped checking a
 * field would have passed them; this file is where each slice's own rules
 * are held.
 */
import {
  AssessmentInstrument,
  EncounterKind,
  EncounterStatus,
  ExtractedFactStatus,
  ExtractedFactType,
  IllnessLifecycle,
  IllnessType,
  InboundDocumentKind,
  InboundDocumentStatus,
  MeasurementReminderEventKind,
  MeasurementSource,
  PersonalRecordDirection,
  SeizureCertainty,
  SeizureDurationSource,
  SeizureEmergency,
  SeizureEventSource,
  SeizureIlaeType,
  SeizureInjury,
  SeizureOnsetPrecision,
  SeizurePostictal,
  SeizureRescueEffect,
  SeizureSemiology,
  SeizureSleepState,
  SeizureTrigger,
} from "@/generated/prisma/enums";
import { describe, expect, it } from "vitest";

import { accountSettingsBackupSchema } from "@/lib/export/account-settings-backup-schema";
import {
  personalRecordBackupSchema,
  userAchievementBackupSchema,
} from "@/lib/export/awards-backup-schema";
import {
  documentConditionLinkBackupSchema,
  documentImportKeyBackupSchema,
  extractedFactBackupSchema,
} from "@/lib/export/document-filing-backup-schema";
import { documentBackupSchema } from "@/lib/export/documents-backup-schema";
import { ecgRecordingBackupSchema } from "@/lib/export/ecg-backup-schema";
import {
  illnessDayLogBackupSchema,
  illnessEpisodeBackupSchema,
  illnessSymptomBackupSchema,
} from "@/lib/export/illness-backup-schema";
import {
  biomarkerBackupSchema,
  biomarkerMergeBackupSchema,
  labResultBackupSchema,
  labResultImportKeyBackupSchema,
} from "@/lib/export/labs-backup-schema";
import { measurementSchema } from "@/lib/export/measurements-backup-schema";
import {
  customMoodTagCategorySchema,
  customMoodTagSchema,
  hiddenMoodTagSchema,
  moodEntrySchema,
} from "@/lib/export/mood-backup-schema";
import { nutrientDaySchema } from "@/lib/export/nutrients-backup-schema";
import { onboardingRecordBackupSchema } from "@/lib/export/onboarding-backup-schema";
import { relationLinkBackupSchema } from "@/lib/export/relation-links-backup-schema";
import {
  measurementReminderBackupSchema,
  measurementReminderEventBackupSchema,
} from "@/lib/export/reminders-backup-schema";
import {
  seizureEventBackupSchema,
  seizureRescueDoseBackupSchema,
  seizureSettingsBackupSchema,
  seizureTypeBackupSchema,
} from "@/lib/export/seizures-backup-schema";
import {
  consentReceiptBackupSchema,
  mentalHealthAssessmentBackupSchema,
} from "@/lib/export/sensitive-backup-schema";
import {
  customVaccineBackupSchema,
  vaccinationBackupSchema,
  vaccinationLinkBackupSchema,
} from "@/lib/export/vaccinations-backup-schema";
import {
  encounterBackupSchema,
  encounterLinkBackupSchema,
  practitionerBackupSchema,
} from "@/lib/export/visits-backup-schema";
import { REMINDER_EVENT_SOURCES } from "@/lib/measurement-reminders/satisfy";
import { ASSESSMENT_WORDINGS } from "@/lib/mental-health/wording/types";
import { DOCUMENT_SOURCE_SYSTEMS } from "@/lib/validations/inbound-documents";

import { AT, SEALED, describeSlice, first, issuePaths } from "./slice-contract";

const STAMPS = { createdAt: AT, updatedAt: AT };
const HEX64 = "0123456789abcdef".repeat(4);
const long = (n: number) => "x".repeat(n);

describe("account settings", () => {
  describeSlice("the account row", {
    schema: accountSettingsBackupSchema,
    valid: {
      heightCm: 180,
      dateOfBirth: "1980-04-02T00:00:00.000Z",
      hasDiabetes: false,
      timezone: "Europe/Berlin",
      avatarBytes: SEALED,
      globalExcludedInjectionSites: ["left-thigh"],
      aiResponseTimeoutSeconds: 60,
    },
    wrongType: {
      heightCm: "tall",
      hasDiabetes: "no",
      dateOfBirth: "some spring",
      avatarBytes: "not base64!",
      aiResponseTimeoutSeconds: 1.5,
    },
  });
});

describe("awards", () => {
  describeSlice("a personal record", {
    schema: personalRecordBackupSchema,
    valid: {
      metricType: "WEIGHT",
      direction: first(PersonalRecordDirection),
      value: 72.5,
      unit: "kg",
      achievedAt: AT,
      source: first(MeasurementSource),
    },
    required: ["metricType", "direction", "value", "unit", "achievedAt"],
    nonEmpty: ["unit"],
    wrongType: { value: "72.5" },
  });

  describeSlice("an unlocked achievement", {
    schema: userAchievementBackupSchema,
    valid: { achievementId: "first-week", unlockedAt: AT, createdAt: AT },
    required: ["achievementId", "unlockedAt"],
    nonEmpty: ["achievementId"],
  });
});

describe("document filing", () => {
  describeSlice("a document's condition link", {
    schema: documentConditionLinkBackupSchema,
    valid: { documentId: "doc-1", episodeId: "ep-1", createdAt: AT },
    required: ["documentId", "episodeId", "createdAt"],
    nonEmpty: ["documentId", "episodeId"],
  });

  describeSlice("an extracted fact", {
    schema: extractedFactBackupSchema,
    valid: {
      id: "fact-1",
      documentId: "doc-1",
      factType: first(ExtractedFactType),
      status: first(ExtractedFactStatus),
      confidence: 0.9,
      needsReview: true,
      data: { value: 118 },
      ...STAMPS,
    },
    required: [
      "id",
      "documentId",
      "factType",
      "status",
      "confidence",
      "needsReview",
      "createdAt",
      "updatedAt",
    ],
    nonEmpty: ["id", "documentId"],
  });

  describeSlice("a document import key", {
    schema: documentImportKeyBackupSchema,
    valid: {
      sourceSystem: first(DOCUMENT_SOURCE_SYSTEMS),
      sourceId: "12345",
      sourceInstance: "https://archive.example",
      createdAt: AT,
    },
    required: ["sourceSystem", "sourceId"],
    nonEmpty: ["sourceId"],
    accepts: [
      ["sourceId", long(128)],
      ["sourceInstance", long(512)],
    ],
    refuses: [
      ["sourceId", long(129)],
      ["sourceInstance", long(513)],
    ],
  });
});

describe("documents", () => {
  describeSlice("a document", {
    schema: documentBackupSchema,
    valid: {
      id: "doc-1",
      kind: first(InboundDocumentKind),
      mimeType: "application/pdf",
      byteSize: 2048,
      status: first(InboundDocumentStatus),
      contentEncrypted: SEALED,
      contentSha256: HEX64,
      contentCodec: "gzip",
      sourceSystem: first(DOCUMENT_SOURCE_SYSTEMS),
      sourceId: "77",
      sourceInstance: "https://archive.example",
    },
    required: ["id", "kind", "mimeType", "byteSize", "status"],
    nonEmpty: ["id", "mimeType", "contentCodec"],
    wrongType: { byteSize: 20.5 },
    accepts: [
      ["contentSha256", null],
      ["sourceId", long(128)],
      ["sourceInstance", long(512)],
    ],
    refuses: [
      ["contentSha256", HEX64.slice(1)],
      ["contentSha256", `${HEX64}0`],
      ["contentSha256", `x${HEX64}`],
      ["contentSha256", `${HEX64}x`],
      ["contentSha256", HEX64.toUpperCase()],
      ["sourceId", long(129)],
      ["sourceInstance", long(513)],
    ],
  });
});

describe("ECG", () => {
  describeSlice("a recording", {
    schema: ecgRecordingBackupSchema,
    valid: {
      id: "ecg-1",
      source: first(MeasurementSource),
      externalRecordingId: "hk-ecg-1",
      recordedAt: AT,
      waveform: [0.1, -0.2],
      samplingFrequency: 512,
      sampleCount: 2,
      measurementId: "m-1",
      ...STAMPS,
    },
    required: [
      "source",
      "externalRecordingId",
      "recordedAt",
      "samplingFrequency",
      "sampleCount",
      "createdAt",
      "updatedAt",
    ],
    nonEmpty: ["id", "externalRecordingId", "measurementId"],
    wrongType: { samplingFrequency: 512.5 },
  });
});

describe("onboarding", () => {
  describeSlice("the onboarding record", {
    schema: onboardingRecordBackupSchema,
    valid: {
      id: "ob-1",
      needs: { weight: true },
      steps: [{ id: "goal" }],
      firstResult: null,
      modulesDerivedAt: null,
      completedAt: AT,
      plan: ["you", "sources"],
      cardDismissedAt: null,
      createdAt: AT,
    },
    nonEmpty: ["id"],
    wrongType: { steps: "goal" },
    defaults: {
      needs: {},
      steps: [],
      firstResult: null,
      modulesDerivedAt: null,
      completedAt: null,
      plan: null,
      cardDismissedAt: null,
    },
  });
});

describe("relation links", () => {
  describeSlice("a lab result's document link", {
    schema: relationLinkBackupSchema("labResultId", "documentId"),
    valid: { labResultId: "lab-1", documentId: "doc-1", createdAt: AT },
    required: ["labResultId", "documentId", "createdAt"],
    nonEmpty: ["labResultId", "documentId"],
  });
});

describe("measurement reminders", () => {
  describeSlice("a reminder", {
    schema: measurementReminderBackupSchema,
    valid: {
      id: "rem-1",
      label: "Weigh in",
      measurementType: "WEIGHT",
      intervalDays: 7,
      notifyHour: 7,
      skipCount: 2,
      enabled: true,
      ...STAMPS,
    },
    required: ["id", "label", "createdAt", "updatedAt"],
    nonEmpty: ["id", "label"],
    accepts: [
      ["notifyHour", 0],
      ["notifyHour", 23],
      ["skipCount", 0],
    ],
    refuses: [
      ["notifyHour", 24],
      ["notifyHour", -1],
      ["skipCount", -1],
    ],
  });

  describeSlice("a reminder event", {
    schema: measurementReminderEventBackupSchema,
    valid: {
      id: "ev-1",
      reminderId: "rem-1",
      kind: first(MeasurementReminderEventKind),
      occurredAt: AT,
      onTime: true,
      source: first(REMINDER_EVENT_SOURCES),
      createdAt: AT,
    },
    required: [
      "id",
      "reminderId",
      "kind",
      "occurredAt",
      "onTime",
      "source",
      "createdAt",
    ],
    nonEmpty: ["id", "reminderId"],
  });
});

describe("seizures", () => {
  const typeRow = {
    id: "st-1",
    ref: "type-a",
    label: "Focal aware",
    ilaeType: first(SeizureIlaeType),
    rescueMedicationId: "med-1",
    sortOrder: 0,
    ...STAMPS,
  };

  describeSlice("a seizure type", {
    schema: seizureTypeBackupSchema,
    valid: typeRow,
    required: ["ilaeType", "sortOrder", "createdAt", "updatedAt"],
    nonEmpty: ["id", "ref", "label", "rescueMedicationId"],
  });

  it("takes a seizure type by its label or its ciphertext, and refuses neither", () => {
    const { label: _label, ...unlabelled } = typeRow;
    void _label;
    expect(issuePaths(seizureTypeBackupSchema, unlabelled)).toEqual([""]);
    const refused = seizureTypeBackupSchema.safeParse(unlabelled);
    expect(refused.error?.issues[0]?.message).toBe(
      "A seizure type needs a label or its ciphertext",
    );
    expect(
      issuePaths(seizureTypeBackupSchema, {
        ...unlabelled,
        labelEncrypted: SEALED,
      }),
    ).toEqual([]);
  });

  const dose = {
    id: "rd-1",
    medicationId: "med-1",
    medicationName: "Rescue spray",
    doseAmount: 10,
    doseUnit: "mg",
    givenAt: AT,
    effect: first(SeizureRescueEffect),
    intakeEventId: "ie-1",
    ...STAMPS,
  };

  describeSlice("a rescue dose", {
    schema: seizureRescueDoseBackupSchema,
    valid: dose,
    required: ["medicationName", "givenAt", "effect", "createdAt", "updatedAt"],
    nonEmpty: ["id", "medicationId", "intakeEventId"],
  });

  describeSlice("a seizure", {
    schema: seizureEventBackupSchema,
    valid: {
      id: "se-1",
      typeProfileId: "st-1",
      onsetAt: AT,
      onsetPrecision: first(SeizureOnsetPrecision),
      durationSource: first(SeizureDurationSource),
      count: 2,
      certainty: first(SeizureCertainty),
      sleepState: first(SeizureSleepState),
      semiology: [first(SeizureSemiology)],
      triggers: [first(SeizureTrigger)],
      postictal: [first(SeizurePostictal)],
      injuries: [first(SeizureInjury)],
      emergency: first(SeizureEmergency),
      loggedBy: "delegate",
      loggedByUserId: "user-2",
      source: first(SeizureEventSource),
      rescueDoses: [dose],
      ...STAMPS,
    },
    required: [
      "onsetAt",
      "onsetPrecision",
      "durationSource",
      "count",
      "certainty",
      "sleepState",
      "emergency",
      "source",
      "createdAt",
      "updatedAt",
    ],
    nonEmpty: ["id", "typeProfileId", "loggedByUserId"],
    defaults: {
      semiology: [],
      triggers: [],
      postictal: [],
      injuries: [],
      rescueDoses: [],
    },
    accepts: [
      ["count", 1],
      ["loggedBy", "owner"],
      ["loggedBy", "unknown"],
    ],
    refuses: [
      ["count", 0],
      ["loggedBy", "stranger"],
      ["loggedBy", ""],
      ["rescueDoses", [{ ...dose, medicationName: undefined }]],
    ],
  });

  describeSlice("the seizure settings", {
    schema: seizureSettingsBackupSchema,
    valid: { clusterCount: 3, clusterWindowHours: 24, ...STAMPS },
    required: ["clusterCount", "clusterWindowHours"],
    accepts: [
      ["clusterCount", 2],
      ["clusterCount", 20],
      ["clusterWindowHours", 1],
      ["clusterWindowHours", 168],
    ],
    refuses: [
      ["clusterCount", 1],
      ["clusterCount", 21],
      ["clusterWindowHours", 0],
      ["clusterWindowHours", 169],
    ],
  });
});

describe("sensitive records", () => {
  describeSlice("a questionnaire result", {
    schema: mentalHealthAssessmentBackupSchema,
    valid: {
      id: "mh-1",
      instrument: first(AssessmentInstrument),
      locale: "de-DE",
      wording: first(ASSESSMENT_WORDINGS),
      responsesEncrypted: SEALED,
      totalScore: 7,
      severityBand: "mild",
      takenAt: AT,
      ...STAMPS,
    },
    required: [
      "id",
      "instrument",
      "locale",
      "responsesEncrypted",
      "totalScore",
      "severityBand",
      "takenAt",
      "createdAt",
      "updatedAt",
    ],
    nonEmpty: ["id", "locale", "severityBand"],
  });

  describeSlice("a consent receipt", {
    schema: consentReceiptBackupSchema,
    valid: {
      id: "cr-1",
      kind: "guardian",
      artefact: "vault-v1",
      signedAt: AT,
    },
    required: ["id", "kind", "artefact", "signedAt"],
    nonEmpty: ["id", "kind", "artefact"],
  });
});

describe("illness", () => {
  const symptom = { key: "cough", severity: 2, createdAt: AT };
  const dayLog = {
    id: "dl-1",
    episodeId: "ep-1",
    date: "2026-07-01",
    functionalImpact: 2,
    feverC: 38.2,
    symptoms: [symptom],
    note: "Rested",
  };

  describeSlice("a symptom on a day", {
    schema: illnessSymptomBackupSchema,
    valid: symptom,
    required: ["key"],
    nonEmpty: ["key"],
  });

  describeSlice("a day log", {
    schema: illnessDayLogBackupSchema,
    valid: dayLog,
    required: ["date"],
    nonEmpty: ["id", "episodeId", "date"],
    defaults: { symptoms: [] },
  });

  describeSlice("an episode", {
    schema: illnessEpisodeBackupSchema,
    valid: {
      id: "ep-1",
      label: "Flu",
      type: first(IllnessType),
      lifecycle: first(IllnessLifecycle),
      onsetAt: AT,
      bodySite: "left knee",
      dayLogs: [dayLog],
    },
    required: ["id", "label", "type", "lifecycle", "onsetAt"],
    nonEmpty: ["id", "label"],
    defaults: { dayLogs: [] },
    accepts: [["bodySite", long(200)]],
    refuses: [["bodySite", long(201)]],
  });
});

describe("vaccinations", () => {
  describeSlice("a vaccination", {
    schema: vaccinationBackupSchema,
    valid: {
      id: "vac-1",
      occurredAt: AT,
      antigenSlug: "tetanus",
      doseNumber: 1,
      ...STAMPS,
    },
    required: ["id", "occurredAt", "createdAt", "updatedAt"],
    nonEmpty: ["id"],
  });

  describeSlice("a custom vaccine", {
    schema: customVaccineBackupSchema,
    valid: {
      id: "cv-1",
      name: "Travel combination",
      components: ["hepatitis-a"],
      ...STAMPS,
    },
    required: ["id", "name", "createdAt", "updatedAt"],
    nonEmpty: ["id", "name"],
  });

  describeSlice("a vaccination link", {
    schema: vaccinationLinkBackupSchema,
    valid: { vaccinationId: "vac-1", targetId: "doc-1", createdAt: AT },
    required: ["vaccinationId", "targetId", "createdAt"],
    nonEmpty: ["vaccinationId", "targetId"],
  });
});

describe("visits", () => {
  describeSlice("a practitioner", {
    schema: practitionerBackupSchema,
    valid: { id: "pr-1", name: "Family practice", ...STAMPS },
    required: ["id", "name", "createdAt", "updatedAt"],
    nonEmpty: ["id", "name"],
  });

  describeSlice("an encounter", {
    schema: encounterBackupSchema,
    valid: {
      id: "enc-1",
      occurredAt: AT,
      status: first(EncounterStatus),
      kind: first(EncounterKind),
      ...STAMPS,
    },
    required: ["id", "occurredAt", "status", "kind", "createdAt", "updatedAt"],
    nonEmpty: ["id"],
  });

  describeSlice("an encounter link", {
    schema: encounterLinkBackupSchema,
    valid: { encounterId: "enc-1", targetId: "doc-1", createdAt: AT },
    required: ["encounterId", "targetId", "createdAt"],
    nonEmpty: ["encounterId", "targetId"],
  });
});

describe("measurements and nutrients", () => {
  describeSlice("a measurement", {
    schema: measurementSchema,
    valid: {
      id: "m-1",
      type: "WEIGHT",
      value: 72.5,
      unit: "kg",
      measuredAt: AT,
      timeZone: "Europe/Berlin",
      ingestTokenId: "tok-1",
    },
    required: ["type", "value", "unit", "measuredAt"],
    nonEmpty: ["id", "unit"],
    accepts: [
      ["timeZone", long(64)],
      ["ingestTokenId", long(64)],
    ],
    refuses: [
      ["timeZone", long(65)],
      ["ingestTokenId", long(65)],
    ],
  });

  describeSlice("a nutrient day", {
    schema: nutrientDaySchema,
    valid: {
      day: "2026-07-01",
      nutrient: "protein",
      amount: 80,
      unit: "g",
      source: "MANUAL",
    },
    required: ["day", "nutrient", "amount", "unit", "source"],
    nonEmpty: ["day", "nutrient", "unit", "source"],
  });
});

describe("labs", () => {
  const reading = {
    id: "lab-1",
    ref: "r-1",
    analyte: "LDL cholesterol",
    value: 118,
    unit: "mg/dL",
    takenAt: AT,
    source: "MANUAL",
    externalId: "obs-1",
  };

  describeSlice("a lab reading", {
    schema: labResultBackupSchema,
    valid: reading,
    required: ["analyte", "unit", "takenAt", "source"],
    nonEmpty: ["id", "ref", "analyte", "source", "externalId"],
    accepts: [["externalId", long(128)]],
    refuses: [["externalId", long(129)]],
  });

  describe("the unit of a lab reading", () => {
    const unitless = { ...reading, unit: "" };

    it("may be empty on a qualitative reading", () => {
      expect(
        issuePaths(labResultBackupSchema, {
          ...unitless,
          value: null,
          valueText: "negative",
        }),
      ).toEqual([]);
      expect(
        issuePaths(labResultBackupSchema, {
          ...unitless,
          value: undefined,
          valueText: "negative",
        }),
      ).toEqual([]);
    });

    it.each([
      ["a number", { value: 5, valueText: null }],
      ["a number beside a text", { value: 5, valueText: "high" }],
      ["no value and an empty text", { value: null, valueText: "" }],
      ["no value and no text", { value: null, valueText: null }],
    ])("is needed on a reading with %s", (_, shape) => {
      const result = labResultBackupSchema.safeParse({
        ...unitless,
        ...shape,
      });
      expect(
        result.error?.issues.map((i) => [i.path.join("."), i.message]),
      ).toEqual([["unit", "A numeric lab reading needs its unit"]]);
    });
  });

  describeSlice("a biomarker", {
    schema: biomarkerBackupSchema,
    valid: {
      id: "bm-1",
      name: "LDL cholesterol",
      unit: "mg/dL",
      aliases: [
        { id: "al-1", name: "LDL-C", source: "MERGE" },
        { name: "LDL", source: "IMPORT_CHOICE", createdAt: AT },
        { name: "Low-density lipoprotein", source: "MANUAL" },
      ],
    },
    required: ["name", "unit"],
    nonEmpty: ["id", "name"],
    accepts: [["aliases", [{ name: long(120), source: "MANUAL" }]]],
    refuses: [
      ["aliases", [{ name: "", source: "MERGE" }]],
      ["aliases", [{ name: long(121), source: "MERGE" }]],
      ["aliases", [{ name: "LDL", source: "GUESS" }]],
      ["aliases", [{ id: "", name: "LDL", source: "MERGE" }]],
      ["aliases", [{ name: "LDL" }]],
    ],
  });

  describeSlice("a biomarker merge", {
    schema: biomarkerMergeBackupSchema,
    valid: {
      id: "mg-1",
      targetBiomarkerId: "bm-1",
      targetName: "LDL cholesterol",
      sourceBiomarkerId: "bm-2",
      sourceName: "LDL-C",
      readingCount: 4,
      mergedAt: AT,
    },
    required: [
      "targetName",
      "sourceBiomarkerId",
      "sourceName",
      "readingCount",
      "mergedAt",
    ],
    nonEmpty: [
      "id",
      "targetBiomarkerId",
      "targetName",
      "sourceBiomarkerId",
      "sourceName",
    ],
    accepts: [
      ["readingCount", 0],
      ["sourceName", long(120)],
    ],
    refuses: [
      ["readingCount", -1],
      ["sourceName", long(121)],
    ],
  });

  describeSlice("a lab import key", {
    schema: labResultImportKeyBackupSchema,
    valid: { source: "fhir", externalId: "obs-1", createdAt: AT },
    required: ["source", "externalId"],
    nonEmpty: ["source", "externalId"],
    accepts: [
      ["source", long(32)],
      ["externalId", long(128)],
    ],
    refuses: [
      ["source", long(33)],
      ["externalId", long(129)],
    ],
  });
});

describe("mood", () => {
  describeSlice("a mood entry", {
    schema: moodEntrySchema,
    valid: {
      id: "me-1",
      date: "2026-07-01",
      mood: "GUT",
      score: 7,
      a1: 3,
      a2: 4,
      a3: 5,
      a4: 6,
      a5: 7,
      tags: '["work"]',
      source: "MOODLOG",
      loggedAt: AT,
      factors: [{ key: "sleep", rating: 2 }],
      structuredTags: ["work"],
      linkCreatedAt: [{ key: "work", createdAt: AT }],
    },
    required: ["date", "mood", "score", "loggedAt"],
    nonEmpty: ["id", "date", "mood", "source"],
    defaults: { factors: [], structuredTags: [] },
    accepts: [
      ["a1", 0],
      ["a5", 10],
      ["tags", null],
      ["tags", ""],
    ],
    refuses: [
      ["a1", 11],
      ["a2", -1],
      ["a3", 11],
      ["a4", -1],
      ["a5", 11],
      ["structuredTags", [""]],
      ["linkCreatedAt", [{ key: "", createdAt: AT }]],
      ["linkCreatedAt", [{ key: "work" }]],
      ["factors", [{ key: "", rating: 2 }]],
    ],
  });

  it.each([
    ["a mixed array", '["work", 3]'],
    ["an object", '{"work": true}'],
    ["text that is not JSON", "work, sleep"],
  ])("refuses tags carrying %s, naming the rule", (_, tags) => {
    const result = moodEntrySchema.safeParse({
      date: "2026-07-01",
      mood: "GUT",
      score: 7,
      loggedAt: AT,
      tags,
    });
    expect(
      result.error?.issues.map((i) => [i.path.join("."), i.message]),
    ).toEqual([
      ["tags", "tags must be null, empty, or a JSON array of strings"],
    ]);
  });

  describeSlice("a custom mood tag", {
    schema: customMoodTagSchema,
    valid: {
      id: "tag-1",
      key: "walk",
      labelKey: "mood.tag.walk",
      categoryId: "cat-1",
      kind: "activity",
      isActive: true,
      sortOrder: 0,
      scaleMin: 1,
      scaleMax: 5,
      inverse: false,
    },
    required: ["key", "labelKey", "categoryId", "kind"],
    nonEmpty: ["id", "key", "labelKey", "categoryId", "kind"],
    defaults: {
      isActive: true,
      sortOrder: 0,
      scaleMin: 1,
      scaleMax: 5,
      inverse: false,
    },
  });

  describeSlice("a custom mood tag category", {
    schema: customMoodTagCategorySchema,
    valid: { id: "cat-1", key: "activities", labelKey: "mood.cat.activities" },
    required: ["id", "key", "labelKey"],
    nonEmpty: ["id", "key", "labelKey"],
  });

  describeSlice("a hidden mood tag", {
    schema: hiddenMoodTagSchema,
    valid: { key: "work", createdAt: AT },
    required: ["key"],
    nonEmpty: ["key"],
  });
});
