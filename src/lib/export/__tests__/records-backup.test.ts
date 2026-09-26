/**
 * v1.28 backup-completeness — `buildRecordsBackupSection` is the shared
 * builder both the on-demand full-backup export AND the weekly `data-backup`
 * worker read from (see the module doc comment in `../records-backup.ts`).
 * These tests pin:
 *   - every read is scoped to the caller's `userId` (+ `deletedAt: null`
 *     where the model soft-deletes) — no cross-user leakage,
 *   - encrypted free-text columns decrypt through the real crypto path
 *     (round-tripped with the same key-stub pattern `note-cipher.test.ts`
 *     uses) rather than an opaque mock,
 *   - a document manifest entry never carries the raw file bytes,
 *   - the manifest discloses the two deliberate exclusions,
 *   - `countRecordsBackupSection` totals every domain, including nested
 *     illness day-logs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { encryptNoteToBytes } from "@/lib/labs/store";
import { encryptContextToBytes } from "@/lib/labs/biomarker-store";
import { encryptDocumentSummary } from "@/lib/documents/store";
import { UNREADABLE_EXPORT_MARKER } from "@/lib/export/unreadable-marker";
import {
  buildRecordsBackupSection,
  countRecordsBackupSection,
  DOCUMENTS_MANIFEST_NOTE,
  WORKOUTS_MANIFEST_NOTE,
} from "../records-backup";

const KEY_A = "a".repeat(64);

beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", KEY_A);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const USER_ID = "user-1";

function buildMockPrisma() {
  return {
    labResult: {
      findMany: vi.fn().mockResolvedValue([
        {
          panel: "Lipid panel",
          analyte: "LDL",
          value: 118,
          valueText: null,
          unit: "mg/dL",
          referenceLow: null,
          referenceHigh: 130,
          takenAt: new Date("2026-04-01T09:00:00.000Z"),
          source: "MANUAL",
          biomarker: { name: "LDL Cholesterol" },
          noteEncrypted: encryptNoteToBytes("Fasted draw."),
        },
      ]),
    },
    biomarker: {
      findMany: vi.fn().mockResolvedValue([
        {
          name: "LDL Cholesterol",
          unit: "mg/dL",
          lowerBound: null,
          upperBound: 130,
          panel: "Lipid panel",
          hidden: false,
          contextEncrypted: encryptContextToBytes("Low-density lipoprotein."),
        },
      ]),
    },
    illnessEpisode: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "ep-parent",
          label: "Migraine",
          type: "CHRONIC",
          lifecycle: "CHRONIC_ONGOING",
          onsetAt: new Date("2026-01-01T00:00:00.000Z"),
          resolvedAt: null,
          parentConditionId: null,
          noteEncrypted: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          dayLogs: [],
        },
        {
          id: "ep-flare",
          label: "Migraine flare",
          type: "CHRONIC",
          lifecycle: "FLARE",
          onsetAt: new Date("2026-04-10T00:00:00.000Z"),
          resolvedAt: new Date("2026-04-12T00:00:00.000Z"),
          parentConditionId: "ep-parent",
          noteEncrypted: encryptToBytes("Triggered by travel."),
          bodySiteEncrypted: encryptToBytes("Temple"),
          laterality: "RIGHT",
          createdAt: new Date("2026-04-10T00:00:00.000Z"),
          updatedAt: new Date("2026-04-12T00:00:00.000Z"),
          dayLogs: [
            {
              id: "dl-1",
              episodeId: "ep-flare",
              date: "2026-04-10",
              functionalImpact: 2,
              feverC: null,
              noteEncrypted: encryptToBytes("Bad day."),
              updatedAt: new Date("2026-04-10T00:00:00.000Z"),
              symptomLinks: [{ severity: 3, symptom: { key: "headache" } }],
            },
          ],
        },
      ]),
    },
    allergy: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "al-1",
          substance: "Penicillin",
          category: "MEDICATION",
          type: "ALLERGY",
          severity: "SEVERE",
          status: "ACTIVE",
          onsetAt: null,
          reactionEncrypted: encryptToBytes("Hives"),
          notesEncrypted: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ]),
    },
    familyHistoryEntry: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "fh-1",
          relationship: "MOTHER",
          condition: "Type 2 diabetes",
          ageAtOnset: 52,
          notesEncrypted: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ]),
    },
    workout: {
      findMany: vi.fn().mockResolvedValue([
        {
          sportType: "running",
          startedAt: new Date("2026-04-01T07:00:00.000Z"),
          endedAt: new Date("2026-04-01T08:00:00.000Z"),
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
      ]),
    },
    inboundDocument: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "doc-1",
          kind: "LAB_RESULT",
          title: "Blood panel",
          filename: "panel.pdf",
          mimeType: "application/pdf",
          byteSize: 12345,
          status: "STORED",
          reportDate: new Date("2026-03-30T00:00:00.000Z"),
          documentDate: new Date("2026-03-30T00:00:00.000Z"),
          summaryEncrypted: encryptDocumentSummary("Routine panel."),
          createdAt: new Date("2026-03-30T00:00:00.000Z"),
        },
      ]),
    },
  };
}

describe("buildRecordsBackupSection", () => {
  it("scopes every soft-deletable read to userId + deletedAt: null", async () => {
    const prisma = buildMockPrisma();
    await buildRecordsBackupSection(prisma as never, USER_ID);

    expect(prisma.labResult.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID, deletedAt: null },
      }),
    );
    expect(prisma.illnessEpisode.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID, deletedAt: null },
      }),
    );
    expect(prisma.allergy.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID, deletedAt: null },
      }),
    );
    expect(prisma.familyHistoryEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID, deletedAt: null },
      }),
    );
    expect(prisma.inboundDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID, deletedAt: null },
      }),
    );
    // Biomarker + Workout are not soft-deleted models — userId-only scope.
    expect(prisma.biomarker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } }),
    );
    expect(prisma.workout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } }),
    );
  });

  it("decrypts every free-text column through the real crypto path", async () => {
    const prisma = buildMockPrisma();
    const section = await buildRecordsBackupSection(prisma as never, USER_ID);

    expect(section.labResults[0].note).toBe("Fasted draw.");
    expect(section.labResults[0].biomarkerName).toBe("LDL Cholesterol");
    expect(section.biomarkers[0].context).toBe("Low-density lipoprotein.");
    expect(section.allergies[0].reaction).toBe("Hives");
    expect(section.familyHistory[0].condition).toBe("Type 2 diabetes");
    expect(section.documents[0].summary).toBe("Routine panel.");
  });

  it("preserves every canonical lab, illness, day-log, and allergy field verbatim", async () => {
    const prisma = buildMockPrisma();
    const deletedAt = new Date("2026-04-13T12:00:00.000Z");
    const createdAt = new Date("2026-04-10T01:00:00.000Z");
    const updatedAt = new Date("2026-04-12T23:00:00.000Z");
    const labNote = encryptNoteToBytes("Canonical lab note");
    const illnessNote = encryptToBytes("Canonical illness note");
    const illnessSite = encryptToBytes("Knee");
    const dayNote = encryptToBytes("Canonical day note");
    const reaction = encryptToBytes("Canonical reaction");
    const allergyNote = encryptToBytes("Canonical allergy note");

    prisma.labResult.findMany.mockResolvedValueOnce([
      {
        id: "lab-canonical",
        panel: "Lipid panel",
        analyte: "LDL",
        value: 118,
        valueText: null,
        unit: "mg/dL",
        referenceLow: null,
        referenceHigh: 130,
        takenAt: new Date("2026-04-01T09:00:00.000Z"),
        biomarkerId: "biomarker-canonical",
        biomarker: { name: "LDL Cholesterol" },
        source: "IMPORT",
        noteEncrypted: labNote,
        createdAt,
        updatedAt,
        deletedAt,
      },
    ]);
    prisma.illnessEpisode.findMany.mockResolvedValueOnce([
      {
        id: "episode-canonical",
        label: "Migraine",
        type: "CHRONIC",
        lifecycle: "CHRONIC_ONGOING",
        onsetAt: new Date("2026-04-10T00:00:00.000Z"),
        resolvedAt: null,
        parentConditionId: null,
        noteEncrypted: illnessNote,
        bodySiteEncrypted: illnessSite,
        laterality: "LEFT",
        createdAt,
        updatedAt,
        deletedAt,
        dayLogs: [
          {
            id: "day-canonical",
            episodeId: "episode-canonical",
            date: "2026-04-11",
            functionalImpact: 2,
            feverC: 38.2,
            noteEncrypted: dayNote,
            tz: "Europe/London",
            createdAt,
            updatedAt,
            deletedAt,
            symptomLinks: [{ severity: 3, symptom: { key: "headache" } }],
          },
        ],
      },
    ]);
    prisma.allergy.findMany.mockResolvedValueOnce([
      {
        id: "allergy-canonical",
        substance: "Penicillin",
        category: "MEDICATION",
        type: "ALLERGY",
        severity: "SEVERE",
        status: "INACTIVE",
        onsetAt: new Date("2020-01-01T00:00:00.000Z"),
        reactionEncrypted: reaction,
        notesEncrypted: allergyNote,
        createdAt,
        updatedAt,
        deletedAt,
      },
    ]);

    prisma.biomarker.findMany.mockResolvedValueOnce([]);
    prisma.familyHistoryEntry.findMany.mockResolvedValueOnce([]);
    prisma.workout.findMany.mockResolvedValueOnce([]);
    prisma.inboundDocument.findMany.mockResolvedValueOnce([]);
    const section = await buildRecordsBackupSection(prisma as never, USER_ID, {
      purpose: "disaster-recovery",
    });
    const episodeQuery = prisma.illnessEpisode.findMany.mock.calls.at(-1)?.[0];
    expect(episodeQuery).toEqual(
      expect.objectContaining({ where: { userId: USER_ID } }),
    );
    expect(episodeQuery.include.dayLogs).not.toHaveProperty("where");
    expect(prisma.allergy.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } }),
    );
    expect(section.labResults[0]).toEqual({
      id: "lab-canonical",
      panel: "Lipid panel",
      analyte: "LDL",
      value: 118,
      valueText: null,
      unit: "mg/dL",
      referenceLow: null,
      referenceHigh: 130,
      takenAt: "2026-04-01T09:00:00.000Z",
      biomarkerId: "biomarker-canonical",
      biomarkerName: "LDL Cholesterol",
      source: "IMPORT",
      note: null,
      noteEncrypted: Buffer.from(labNote).toString("base64"),
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      deletedAt: deletedAt.toISOString(),
    });
    expect(section.illnessEpisodes[0]).toEqual({
      id: "episode-canonical",
      label: "Migraine",
      type: "CHRONIC",
      lifecycle: "CHRONIC_ONGOING",
      onsetAt: "2026-04-10T00:00:00.000Z",
      resolvedAt: null,
      parentConditionId: null,
      note: null,
      noteEncrypted: Buffer.from(illnessNote).toString("base64"),
      // v1.39.2 — the body site rides as ciphertext, never in the clear.
      bodySite: null,
      bodySiteEncrypted: Buffer.from(illnessSite).toString("base64"),
      laterality: "LEFT",
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      deletedAt: deletedAt.toISOString(),
      dayLogs: [
        {
          id: "day-canonical",
          episodeId: "episode-canonical",
          date: "2026-04-11",
          functionalImpact: 2,
          feverC: 38.2,
          note: null,
          noteEncrypted: Buffer.from(dayNote).toString("base64"),
          tz: "Europe/London",
          createdAt: createdAt.toISOString(),
          updatedAt: updatedAt.toISOString(),
          deletedAt: deletedAt.toISOString(),
          symptoms: [{ key: "headache", severity: 3 }],
        },
      ],
    });
    expect(section.allergies[0]).toEqual({
      id: "allergy-canonical",
      substance: "Penicillin",
      category: "MEDICATION",
      type: "ALLERGY",
      severity: "SEVERE",
      status: "INACTIVE",
      onsetAt: "2020-01-01T00:00:00.000Z",
      reaction: null,
      note: null,
      reactionEncrypted: Buffer.from(reaction).toString("base64"),
      notesEncrypted: Buffer.from(allergyNote).toString("base64"),
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      deletedAt: deletedAt.toISOString(),
    });
  });

  it("threads an illness flare's parentConditionId and nests its day-log + symptom", async () => {
    const prisma = buildMockPrisma();
    const section = await buildRecordsBackupSection(prisma as never, USER_ID);

    const flare = section.illnessEpisodes.find((e) => e.id === "ep-flare");
    expect(flare?.parentConditionId).toBe("ep-parent");
    expect(flare?.note).toBe("Triggered by travel.");
    // The portable file carries the body site readable, like the note.
    expect(flare?.bodySite).toBe("Temple");
    expect(flare?.laterality).toBe("RIGHT");
    expect(flare?.dayLogs).toHaveLength(1);
    expect(flare?.dayLogs[0].note).toBe("Bad day.");
    expect(flare?.dayLogs[0].symptoms).toEqual([
      { key: "headache", severity: 3 },
    ]);
  });

  it("never carries the document's raw content bytes in the manifest entry", async () => {
    const prisma = buildMockPrisma();
    const section = await buildRecordsBackupSection(prisma as never, USER_ID);

    expect(section.documents[0]).not.toHaveProperty("contentEncrypted");
    expect(section.documents[0]).not.toHaveProperty("content");
    // The read itself never selects the blob column — pin the `select`.
    const call = prisma.inboundDocument.findMany.mock.calls[0][0];
    expect(call.select).not.toHaveProperty("contentEncrypted");
  });

  it("discloses the document + workout exclusions in the manifest", async () => {
    const prisma = buildMockPrisma();
    const section = await buildRecordsBackupSection(prisma as never, USER_ID);

    expect(section.manifest.documents).toEqual({
      included: "metadata-only",
      note: DOCUMENTS_MANIFEST_NOTE,
    });
    expect(section.manifest.workouts).toEqual({
      included: "summary-only",
      note: WORKOUTS_MANIFEST_NOTE,
    });
  });

  it("counts every domain, including nested illness day-logs", async () => {
    const prisma = buildMockPrisma();
    const section = await buildRecordsBackupSection(prisma as never, USER_ID);
    const counts = countRecordsBackupSection(section);

    expect(counts).toEqual({
      labResults: 1,
      biomarkers: 1,
      illnessEpisodes: 2,
      illnessDayLogs: 1,
      allergies: 1,
      familyHistory: 1,
      workouts: 1,
      documents: 1,
    });
  });

  it("marks an undecryptable note (not a throw, and not a silent null)", async () => {
    const prisma = buildMockPrisma();
    // Corrupt the ciphertext so decrypt throws internally. The row must still
    // come back and must never abort the whole backup — that part is
    // unchanged. What it must NOT come back as is `null`, which this test used
    // to require: in an export file a null note is byte-identical to a note
    // that was never written, so the restore writes nothing and the loss is
    // invisible. It comes back as a marker instead.
    prisma.labResult.findMany.mockResolvedValueOnce([
      {
        panel: null,
        analyte: "HbA1c",
        value: 5.4,
        valueText: null,
        unit: "%",
        referenceLow: null,
        referenceHigh: null,
        takenAt: new Date("2026-04-01T09:00:00.000Z"),
        source: "MANUAL",
        biomarker: null,
        noteEncrypted: new Uint8Array([1, 2, 3, 4]),
      },
    ]);

    const section = await buildRecordsBackupSection(prisma as never, USER_ID);
    expect(section.labResults[0].note).toBe(UNREADABLE_EXPORT_MARKER);
  });
});
