/**
 * v1.4.16 H2 — moodEntrySchema.tags must reject malformed tag blobs
 * before the restore transaction inserts them. The DB column stores
 * tags as a JSON-array-as-string ("[\"work\",\"sleep\"]"), so an
 * arbitrary string slipping through Zod is a foot-gun:
 *   - downstream readers `JSON.parse` blindly and crash on a
 *     non-array
 *   - the iOS native client renders tags one-per-row and would
 *     either render garbage or throw
 *
 * We accept three shapes:
 *   - `null` (and omitted/undefined): "no tags on this entry"
 *   - empty string `""`: legacy wire format (handled as null)
 *   - a JSON-string that parses to an array of strings.
 *
 * Anything else (object, JSON-with-numbers, garbage) is rejected at
 * schema time with a 422 response from the restore endpoint instead
 * of bubbling out of `prisma.createMany` with a useless message.
 */
import { describe, expect, it } from "vitest";
import {
  backupPayloadSchema,
  isCompatibleSchemaVersion,
  parseBackupPayload,
  summarizeBackup,
} from "../backup";

const baseEntry = {
  date: "2026-05-08",
  mood: "GUT",
  score: 4,
  source: "MOODLOG",
  loggedAt: "2026-05-08T20:00:00.000Z",
};

function parseWithMoodTags(tags: unknown) {
  return backupPayloadSchema.safeParse({
    schemaVersion: "1",
    exportedAt: "2026-05-08T07:00:00.000Z",
    userId: "u1",
    measurements: [],
    medications: [],
    intakeEvents: [],
    moodEntries: [{ ...baseEntry, tags }],
  });
}

describe("moodEntrySchema.tags strict validation", () => {
  it("accepts null", () => {
    const r = parseWithMoodTags(null);
    expect(r.success).toBe(true);
  });

  it("accepts an empty string (legacy wire format)", () => {
    const r = parseWithMoodTags("");
    expect(r.success).toBe(true);
  });

  it("accepts a JSON-string that parses to an array of strings", () => {
    const r = parseWithMoodTags('["work","sleep"]');
    expect(r.success).toBe(true);
  });

  it("rejects a non-JSON garbage string", () => {
    const r = parseWithMoodTags("not-json{");
    expect(r.success).toBe(false);
  });

  it("rejects a JSON object that is not an array", () => {
    const r = parseWithMoodTags('{"a":1}');
    expect(r.success).toBe(false);
  });

  it("rejects a JSON array containing non-strings", () => {
    const r = parseWithMoodTags("[1,2,3]");
    expect(r.success).toBe(false);
  });

  it("accepts an omitted tags field (optional)", () => {
    const r = backupPayloadSchema.safeParse({
      schemaVersion: "1",
      exportedAt: "2026-05-08T07:00:00.000Z",
      userId: "u1",
      measurements: [],
      medications: [],
      intakeEvents: [],
      moodEntries: [{ ...baseEntry }],
    });
    expect(r.success).toBe(true);
  });
});

describe("backupPayloadSchema — v1.15.0 cycle round-trip", () => {
  it("defaults the cycle fields when a pre-v1.15 blob omits them", () => {
    const r = backupPayloadSchema.safeParse({
      schemaVersion: "1",
      exportedAt: "2026-05-08T07:00:00.000Z",
      userId: "u1",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.cycleProfile).toBeNull();
      expect(r.data.cycles).toEqual([]);
      expect(r.data.cycleDayLogs).toEqual([]);
    }
  });

  it("round-trips a cycle profile, observed span, and day-log with notes ciphertext", () => {
    const r = backupPayloadSchema.safeParse({
      schemaVersion: "1",
      exportedAt: "2026-05-08T07:00:00.000Z",
      userId: "u1",
      cycleProfile: {
        goal: "TRYING_TO_CONCEIVE",
        cycleTrackingEnabled: true,
        typicalCycleLength: 28,
        lutealPhaseLength: 14,
        sensitiveCategoryEncryption: true,
      },
      cycles: [
        {
          startDate: "2026-04-20",
          endDate: "2026-05-17",
          periodEndDate: "2026-04-24",
          lengthDays: 28,
          ovulationDate: "2026-05-04",
          ovulationConfirmed: true,
          tz: "Europe/Berlin",
        },
      ],
      cycleDayLogs: [
        {
          date: "2026-04-20",
          flow: "MEDIUM",
          intermenstrualBleeding: false,
          sexualActivity: true,
          protectedSex: false,
          contraceptive: "NONE",
          // The note must round-trip as the opaque ciphertext envelope.
          notesEncrypted: "v1:deadbeef:cipher",
          source: "APPLE_HEALTH",
          externalId: "hkcycle:2026-04-20",
          symptomKeys: ["cramps", "fatigue"],
        },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.cycleProfile?.goal).toBe("TRYING_TO_CONCEIVE");
      expect(r.data.cycles[0].lengthDays).toBe(28);
      expect(r.data.cycleDayLogs[0].notesEncrypted).toBe("v1:deadbeef:cipher");
      expect(r.data.cycleDayLogs[0].symptomKeys).toEqual(["cramps", "fatigue"]);
    }
  });
});

describe("backupPayloadSchema — v1.28 backup-completeness domains", () => {
  it("defaults every records field when a pre-v1.28 blob omits them", () => {
    const r = backupPayloadSchema.safeParse({
      schemaVersion: "1",
      exportedAt: "2026-05-08T07:00:00.000Z",
      userId: "u1",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.labResults).toEqual([]);
      expect(r.data.biomarkers).toEqual([]);
      expect(r.data.illnessEpisodes).toEqual([]);
      expect(r.data.allergies).toEqual([]);
      expect(r.data.familyHistory).toEqual([]);
      expect(r.data.workouts).toEqual([]);
      expect(r.data.documents).toEqual([]);
      expect(r.data.manifest).toBeNull();
    }
  });

  it("round-trips a lab result cross-referencing a biomarker by name", () => {
    const r = backupPayloadSchema.safeParse({
      schemaVersion: "1",
      exportedAt: "2026-05-08T07:00:00.000Z",
      userId: "u1",
      biomarkers: [
        {
          name: "LDL Cholesterol",
          unit: "mg/dL",
          lowerBound: null,
          upperBound: 130,
          panel: "Lipid panel",
          hidden: false,
          context: "Low-density lipoprotein.",
        },
      ],
      labResults: [
        {
          panel: "Lipid panel",
          analyte: "LDL Cholesterol",
          value: 118,
          valueText: null,
          unit: "mg/dL",
          referenceLow: null,
          referenceHigh: 130,
          takenAt: "2026-04-01T09:00:00.000Z",
          source: "MANUAL",
          biomarkerName: "LDL Cholesterol",
          note: "Fasted draw.",
        },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.biomarkers[0].name).toBe("LDL Cholesterol");
      expect(r.data.labResults[0].biomarkerName).toBe("LDL Cholesterol");
      expect(r.data.labResults[0].note).toBe("Fasted draw.");
    }
  });

  it("round-trips an illness episode with a flare referencing its parent + nested day-logs", () => {
    const r = backupPayloadSchema.safeParse({
      schemaVersion: "1",
      exportedAt: "2026-05-08T07:00:00.000Z",
      userId: "u1",
      illnessEpisodes: [
        {
          id: "ep-1",
          label: "Migraine",
          type: "CHRONIC",
          lifecycle: "CHRONIC_ONGOING",
          onsetAt: "2026-01-01T00:00:00.000Z",
          resolvedAt: null,
          parentConditionId: null,
          note: null,
          dayLogs: [],
        },
        {
          id: "ep-2",
          label: "Migraine flare",
          type: "CHRONIC",
          lifecycle: "FLARE",
          onsetAt: "2026-04-10T00:00:00.000Z",
          resolvedAt: "2026-04-12T00:00:00.000Z",
          parentConditionId: "ep-1",
          note: "Triggered by travel.",
          dayLogs: [
            {
              date: "2026-04-10",
              functionalImpact: 2,
              feverC: null,
              symptoms: [{ key: "headache", severity: 3 }],
              note: "Bad day.",
            },
          ],
        },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.illnessEpisodes).toHaveLength(2);
      expect(r.data.illnessEpisodes[1].parentConditionId).toBe("ep-1");
      expect(r.data.illnessEpisodes[1].dayLogs[0].symptoms[0].key).toBe(
        "headache",
      );
    }
  });

  it("round-trips allergies, family history, workouts, documents, and the manifest", () => {
    const r = backupPayloadSchema.safeParse({
      schemaVersion: "1",
      exportedAt: "2026-05-08T07:00:00.000Z",
      userId: "u1",
      allergies: [
        {
          id: "al-1",
          substance: "Penicillin",
          category: "MEDICATION",
          type: "ALLERGY",
          severity: "SEVERE",
          status: "ACTIVE",
          onsetAt: null,
          reaction: "Hives",
          note: null,
        },
      ],
      familyHistory: [
        {
          id: "fh-1",
          relationship: "MOTHER",
          condition: "Type 2 diabetes",
          ageAtOnset: 52,
          note: null,
        },
      ],
      workouts: [
        {
          sportType: "running",
          startedAt: "2026-04-01T07:00:00.000Z",
          endedAt: "2026-04-01T08:00:00.000Z",
          durationSec: 3600,
          totalEnergyKcal: 600,
          totalDistanceM: 10000,
          avgHeartRate: 150,
          maxHeartRate: 175,
          minHeartRate: 110,
          stepCount: 9000,
          elevationM: 80,
          pauseDurationSec: 0,
          source: "APPLE_HEALTH",
          externalId: "hk-1",
        },
      ],
      documents: [
        {
          id: "doc-1",
          kind: "LAB_RESULT",
          title: "Blood panel",
          filename: "panel.pdf",
          mimeType: "application/pdf",
          byteSize: 12345,
          status: "STORED",
          reportDate: "2026-03-30",
          documentDate: "2026-03-30",
          summary: "Routine panel.",
        },
      ],
      manifest: {
        documents: { included: "metadata-only", note: "Files excluded." },
        workouts: { included: "summary-only", note: "Routes excluded." },
      },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.allergies[0].substance).toBe("Penicillin");
      expect(r.data.familyHistory[0].relationship).toBe("MOTHER");
      expect(r.data.workouts[0].sportType).toBe("running");
      expect(r.data.documents[0].id).toBe("doc-1");
      // A document manifest entry never carries the raw file bytes — the
      // schema simply has no field for it, so an attacker-supplied
      // `contentEncrypted` key on upload is dropped as passthrough noise,
      // never parsed into a typed field a restore path could act on.
      expect(r.data.documents[0]).not.toHaveProperty("contentEncrypted");
      expect(r.data.manifest?.documents.included).toBe("metadata-only");
      expect(r.data.manifest?.workouts.included).toBe("summary-only");
    }
  });

  it("summarizeBackup reports counts for every v1.28 domain, incl. nested day-logs", () => {
    const parsed = backupPayloadSchema.parse({
      schemaVersion: "1",
      exportedAt: "2026-05-08T07:00:00.000Z",
      userId: "u1",
      labResults: [
        {
          analyte: "HbA1c",
          unit: "%",
          takenAt: "2026-04-01T09:00:00.000Z",
          source: "MANUAL",
        },
      ],
      illnessEpisodes: [
        {
          id: "ep-1",
          label: "Cold",
          type: "INFECTION",
          lifecycle: "ACUTE",
          onsetAt: "2026-04-01T00:00:00.000Z",
          dayLogs: [
            { date: "2026-04-01", symptoms: [] },
            { date: "2026-04-02", symptoms: [] },
          ],
        },
      ],
      workouts: [
        {
          sportType: "cycling",
          startedAt: "2026-04-01T07:00:00.000Z",
          endedAt: "2026-04-01T08:00:00.000Z",
          durationSec: 3600,
          source: "MANUAL",
        },
      ],
    });
    const summary = summarizeBackup(parsed);
    expect(summary.labResults).toBe(1);
    expect(summary.illnessEpisodes).toBe(1);
    expect(summary.illnessDayLogs).toBe(2);
    expect(summary.workouts).toBe(1);
    expect(summary.allergies).toBe(0);
    expect(summary.familyHistory).toBe(0);
    expect(summary.documents).toBe(0);
  });

  // Watched red: with the v1.37.19 section counts removed from
  // `summarizeBackup` (the pre-fix shape stopped at healthScoreRecords),
  // every assertion below fails — a file carrying visits or an Impfpass
  // was restored in full but reported as if those sections were empty.
  it("summarizeBackup counts practitioners, encounters, links, and vaccinations", () => {
    const ts = "2026-05-08T07:00:00.000Z";
    const parsed = backupPayloadSchema.parse({
      schemaVersion: "1",
      exportedAt: ts,
      userId: "u1",
      practitioners: [
        { id: "pr-1", name: "Praxis", createdAt: ts, updatedAt: ts },
      ],
      encounters: [
        {
          id: "en-1",
          occurredAt: ts,
          status: "DONE",
          kind: "ROUTINE",
          createdAt: ts,
          updatedAt: ts,
        },
      ],
      encounterDocumentLinks: [
        { encounterId: "en-1", targetId: "doc-1", createdAt: ts },
      ],
      encounterLabLinks: [
        { encounterId: "en-1", targetId: "lab-1", createdAt: ts },
      ],
      encounterConditionLinks: [],
      vaccinations: [
        { id: "va-1", occurredAt: ts, createdAt: ts, updatedAt: ts },
      ],
      vaccinationDocumentLinks: [
        { vaccinationId: "va-1", targetId: "doc-1", createdAt: ts },
      ],
    });
    const summary = summarizeBackup(parsed);
    expect(summary.practitioners).toBe(1);
    expect(summary.encounters).toBe(1);
    expect(summary.encounterLinks).toBe(2);
    expect(summary.vaccinations).toBe(1);
    expect(summary.vaccinationLinks).toBe(1);
  });
});

describe("backupPayloadSchema — canonical v2 identity compatibility", () => {
  const base = {
    exportedAt: "2026-07-20T00:00:00.000Z",
    userId: "u1",
  };

  it("treats an unversioned payload as legacy v1 and accepts measurements without ids", () => {
    const payload = parseBackupPayload({
      ...base,
      measurements: [
        {
          type: "WEIGHT",
          value: 75,
          unit: "kg",
          measuredAt: "2026-07-19T07:00:00.000Z",
        },
      ],
    });

    expect(payload.schemaVersion).toBe("1");
    expect(isCompatibleSchemaVersion(payload.schemaVersion)).toBe(true);
  });

  it("requires stable measurement ids in canonical v2 payloads", () => {
    const result = backupPayloadSchema.safeParse({
      ...base,
      schemaVersion: "2",
      measurements: [
        {
          type: "SLEEP_DURATION",
          value: 120,
          unit: "minutes",
          measuredAt: "2026-07-19T22:00:00.000Z",
          source: "IMPORT",
          sleepStage: "DEEP",
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(isCompatibleSchemaVersion("1")).toBe(true);
    expect(isCompatibleSchemaVersion("2")).toBe(true);
    expect(isCompatibleSchemaVersion("3")).toBe(false);
  });
});

describe("backupPayloadSchema — database enum boundaries", () => {
  const enumPayload = {
    schemaVersion: "1",
    exportedAt: "2026-07-20T00:00:00.000Z",
    userId: "u1",
    measurements: [
      {
        id: "measurement-1",
        type: "WEIGHT",
        value: 75,
        unit: "kg",
        measuredAt: "2026-07-19T07:00:00.000Z",
        source: "MANUAL",
      },
    ],
    intakeEvents: [
      {
        medication: "Example",
        scheduledFor: "2026-07-19T08:00:00.000Z",
        source: "WEB",
      },
    ],
    cycleProfile: {
      goal: "GENERAL_HEALTH",
      secondarySymptom: "MUCUS",
    },
    cycleDayLogs: [
      {
        date: "2026-07-19",
        flow: "MEDIUM",
        ovulationTest: "NEGATIVE",
        cervicalMucus: "CREAMY",
        cervixPosition: "LOW",
        cervixFirmness: "FIRM",
        cervixOpening: "CLOSED",
        pregnancyTest: "NEGATIVE",
        progesteroneTest: "INDETERMINATE",
        contraceptive: "NONE",
        source: "MANUAL",
      },
    ],
    illnessEpisodes: [
      {
        id: "illness-1",
        label: "Cold",
        type: "INFECTION",
        lifecycle: "ACUTE",
        onsetAt: "2026-07-01T00:00:00.000Z",
      },
    ],
    allergies: [
      {
        id: "allergy-1",
        substance: "Penicillin",
        category: "MEDICATION",
        type: "ALLERGY",
        severity: "SEVERE",
        status: "ACTIVE",
      },
    ],
    familyHistory: [
      {
        id: "family-1",
        relationship: "MOTHER",
        condition: "Diabetes",
      },
    ],
    workouts: [
      {
        id: "workout-1",
        sportType: "RUNNING",
        startedAt: "2026-07-19T06:00:00.000Z",
        endedAt: "2026-07-19T06:30:00.000Z",
        durationSec: 1800,
        source: "APPLE_HEALTH",
      },
    ],
    documents: [
      {
        id: "document-1",
        kind: "LAB_RESULT",
        mimeType: "application/pdf",
        byteSize: 42,
        status: "STORED",
        summaryState: "NONE",
      },
    ],
  };

  const enumPaths: Array<[string, Array<string | number>]> = [
    ["measurement type", ["measurements", 0, "type"]],
    ["measurement source", ["measurements", 0, "source"]],
    ["intake source", ["intakeEvents", 0, "source"]],
    ["cycle goal", ["cycleProfile", "goal"]],
    ["cycle secondary symptom", ["cycleProfile", "secondarySymptom"]],
    ["cycle flow", ["cycleDayLogs", 0, "flow"]],
    ["cycle ovulation test", ["cycleDayLogs", 0, "ovulationTest"]],
    ["cycle cervical mucus", ["cycleDayLogs", 0, "cervicalMucus"]],
    ["cycle cervix position", ["cycleDayLogs", 0, "cervixPosition"]],
    ["cycle cervix firmness", ["cycleDayLogs", 0, "cervixFirmness"]],
    ["cycle cervix opening", ["cycleDayLogs", 0, "cervixOpening"]],
    ["cycle pregnancy test", ["cycleDayLogs", 0, "pregnancyTest"]],
    ["cycle progesterone test", ["cycleDayLogs", 0, "progesteroneTest"]],
    ["cycle contraceptive", ["cycleDayLogs", 0, "contraceptive"]],
    ["cycle source", ["cycleDayLogs", 0, "source"]],
    ["illness type", ["illnessEpisodes", 0, "type"]],
    ["illness lifecycle", ["illnessEpisodes", 0, "lifecycle"]],
    ["allergy category", ["allergies", 0, "category"]],
    ["allergy type", ["allergies", 0, "type"]],
    ["allergy severity", ["allergies", 0, "severity"]],
    ["allergy status", ["allergies", 0, "status"]],
    ["family relationship", ["familyHistory", 0, "relationship"]],
    ["workout source", ["workouts", 0, "source"]],
    ["document kind", ["documents", 0, "kind"]],
    ["document status", ["documents", 0, "status"]],
    ["document summary state", ["documents", 0, "summaryState"]],
  ];

  it.each(enumPaths)("rejects an unsupported %s", (_label, path) => {
    const candidate = structuredClone(enumPayload);
    let cursor: Record<PropertyKey, unknown> = candidate;
    for (const segment of path.slice(0, -1)) {
      cursor = cursor[segment] as Record<PropertyKey, unknown>;
    }
    cursor[path.at(-1)!] = "UNSUPPORTED_BACKUP_ENUM";

    const parsed = backupPayloadSchema.safeParse(candidate);

    expect(parsed.success).toBe(false);
  });
});

// #1034 — a restore applies the same units-per-dose rule as the write
// routes, on the medication and on each schedule, so a hand-edited file
// cannot put a value into the database that no route would accept.
describe("backupPayloadSchema — unitsPerDose", () => {
  function withMedication(med: Record<string, unknown>) {
    return backupPayloadSchema.safeParse({
      schemaVersion: "1",
      exportedAt: "2026-09-25T07:00:00.000Z",
      userId: "u1",
      measurements: [],
      intakeEvents: [],
      medications: [{ name: "Example", dose: "5 mg", ...med }],
    });
  }

  it("accepts the Decimal strings a backup carries, mixed values included", () => {
    for (const v of ["1", "0.5", "1.5", "2.25", "1.3333", "1.2"]) {
      expect(withMedication({ unitsPerDose: v }).success).toBe(true);
    }
  });

  it("refuses a medication value the write routes would refuse", () => {
    for (const v of ["0", "-1", "101", "abc", "1.23456"]) {
      expect(withMedication({ unitsPerDose: v }).success).toBe(false);
    }
  });

  it("applies the rule to the per-schedule override, string or number", () => {
    const schedule = (unitsPerDose: unknown) => ({
      schedules: [{ windowStart: "08:00", windowEnd: "08:00", unitsPerDose }],
    });
    expect(withMedication(schedule("1.5")).success).toBe(true);
    expect(withMedication(schedule(2.25)).success).toBe(true);
    expect(withMedication(schedule(null)).success).toBe(true);
    expect(withMedication(schedule("0")).success).toBe(false);
    expect(withMedication(schedule(150)).success).toBe(false);
    expect(withMedication(schedule("x")).success).toBe(false);
  });
});
