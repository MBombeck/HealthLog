import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetCryptoCacheForTests, encrypt } from "@/lib/crypto";
import { UNREADABLE_EXPORT_MARKER } from "@/lib/export/unreadable-marker";

import { buildCycleBackupSection } from "../backup";

const deletedAt = new Date("2026-07-19T12:00:00.000Z");
const createdAt = new Date("2026-07-01T08:00:00.000Z");
const updatedAt = new Date("2026-07-19T11:00:00.000Z");

describe("buildCycleBackupSection disaster-recovery mode", () => {
  it("preserves stable ids, reconciliation fields, and tombstones", async () => {
    const prisma = {
      cycleProfile: {
        findUnique: vi.fn().mockResolvedValue({
          id: "profile-dr",
          goal: "GENERAL_HEALTH",
          cycleTrackingEnabled: true,
          typicalCycleLength: 28,
          typicalPeriodLength: 5,
          lutealPhaseLength: 14,
          secondarySymptom: "MUCUS",
          predictionEnabled: true,
          rawChartMode: false,
          discreetNotifications: true,
          sensitiveCategoryEncryption: true,
          createdAt,
          updatedAt,
        }),
      },
      cycleSymptom: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "sym-custom",
            key: "custom_ache",
            labelKey: "cycle.symptom.custom_ache",
            categoryId: "cat-1",
            icon: "Activity",
            sortOrder: 3,
            isActive: true,
          },
        ]),
      },
      menstrualCycle: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "cycle-dr",
            startDate: "2026-07-01",
            endDate: "2026-07-28",
            periodEndDate: "2026-07-05",
            lengthDays: 28,
            ovulationDate: "2026-07-14",
            ovulationConfirmed: true,
            isPredicted: false,
            tz: "Europe/London",
            syncVersion: 5,
            deletedAt,
            createdAt,
            updatedAt,
          },
        ]),
      },
      cycleDayLog: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "cycle-day-dr",
            date: "2026-07-02",
            cycleId: "cycle-dr",
            flow: "HEAVY",
            intermenstrualBleeding: false,
            basalBodyTempC: 36.7,
            temperatureExcluded: true,
            ovulationTest: "NEGATIVE",
            cervicalMucus: "CREAMY",
            cervixPosition: "LOW",
            cervixFirmness: "FIRM",
            cervixOpening: "CLOSED",
            sexualActivity: false,
            protectedSex: null,
            pregnancyTest: null,
            progesteroneTest: null,
            contraceptive: null,
            sensitiveEncrypted: "sensitive-ciphertext",
            notesEncrypted: "notes-ciphertext",
            source: "APPLE_HEALTH",
            externalId: "cycle-day-external",
            tz: "Europe/London",
            syncVersion: 9,
            deletedAt,
            createdAt,
            updatedAt,
            // One symptom the person put a number on, one they did not.
            symptomLinks: [
              { severity: 4, symptom: { key: "cramps" } },
              { severity: null, symptom: { key: "fatigue" } },
            ],
          },
        ]),
      },
    };

    const section = await buildCycleBackupSection(prisma as never, "user-1", {
      purpose: "disaster-recovery",
    });

    expect(prisma.menstrualCycle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
    expect(prisma.cycleDayLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
    expect(section.cycleProfile).toEqual({
      id: "profile-dr",
      goal: "GENERAL_HEALTH",
      cycleTrackingEnabled: true,
      typicalCycleLength: 28,
      typicalPeriodLength: 5,
      lutealPhaseLength: 14,
      secondarySymptom: "MUCUS",
      predictionEnabled: true,
      rawChartMode: false,
      discreetNotifications: true,
      sensitiveCategoryEncryption: true,
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
    expect(section.cycles[0]).toEqual({
      id: "cycle-dr",
      startDate: "2026-07-01",
      endDate: "2026-07-28",
      periodEndDate: "2026-07-05",
      lengthDays: 28,
      ovulationDate: "2026-07-14",
      ovulationConfirmed: true,
      isPredicted: false,
      tz: "Europe/London",
      syncVersion: 5,
      deletedAt: deletedAt.toISOString(),
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
    expect(section.cycleDayLogs[0]).toEqual({
      id: "cycle-day-dr",
      date: "2026-07-02",
      cycleId: "cycle-dr",
      flow: "HEAVY",
      intermenstrualBleeding: false,
      basalBodyTempC: 36.7,
      temperatureExcluded: true,
      ovulationTest: "NEGATIVE",
      cervicalMucus: "CREAMY",
      cervixPosition: "LOW",
      cervixFirmness: "FIRM",
      cervixOpening: "CLOSED",
      sexualActivity: false,
      protectedSex: null,
      pregnancyTest: null,
      progesteroneTest: null,
      contraceptive: null,
      sensitiveEncrypted: "sensitive-ciphertext",
      notesEncrypted: "notes-ciphertext",
      source: "APPLE_HEALTH",
      externalId: "cycle-day-external",
      tz: "Europe/London",
      syncVersion: 9,
      deletedAt: deletedAt.toISOString(),
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      symptomKeys: ["cramps", "fatigue"],
      // Only the rated link is listed. An unrated one is left out rather than
      // written as a zero, so the file says "never rated" and not "rated none".
      symptomSeverities: [{ key: "cramps", severity: 4 }],
    });
  });
});

describe("a symptom the account created survives the round trip", () => {
  /**
   * The defect this pins: the seeded symptom catalogue is reference data every
   * instance already has, but a symptom the user made exists only in their
   * account. It was never carried, so on restore its key resolved to nothing —
   * and the link was silently filtered out. The day-log came back, one of its
   * symptoms did not, and the restore reported success.
   */
  function client(customSymptoms: unknown[]) {
    return {
      cycleProfile: { findUnique: vi.fn().mockResolvedValue(null) },
      menstrualCycle: { findMany: vi.fn().mockResolvedValue([]) },
      cycleDayLog: { findMany: vi.fn().mockResolvedValue([]) },
      cycleSymptom: { findMany: vi.fn().mockResolvedValue(customSymptoms) },
    } as never;
  }

  it("carries the account's own symptom definitions", async () => {
    const section = await buildCycleBackupSection(
      client([
        {
          id: "sym-1",
          key: "custom_ache",
          labelKey: "cycle.symptom.custom_ache",
          categoryId: "cat-1",
          icon: null,
          sortOrder: 2,
          isActive: true,
        },
      ]),
      "user-1",
      { purpose: "disaster-recovery" },
    );

    expect(section.customSymptoms).toHaveLength(1);
    expect(section.customSymptoms[0]).toMatchObject({
      key: "custom_ache",
      labelKey: "cycle.symptom.custom_ache",
      categoryId: "cat-1",
      sortOrder: 2,
      isActive: true,
    });
  });

  it("asks only for the account's own rows, never the seeded catalogue", async () => {
    // Carrying the seeded rows would let one instance's restore rewrite
    // another instance's reference data.
    const c = client([]);
    await buildCycleBackupSection(c, "user-1", {});
    expect(
      (c as unknown as { cycleSymptom: { findMany: ReturnType<typeof vi.fn> } })
        .cycleSymptom.findMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
  });

  it("writes an empty list rather than omitting the section", async () => {
    // An absent key and an empty list read the same to a careless consumer.
    // The restore distinguishes them, so the builder must be explicit.
    const section = await buildCycleBackupSection(client([]), "user-1", {});
    expect(section.customSymptoms).toEqual([]);
  });
});

describe("a portable file carries the cycle free text readable", () => {
  // Ciphertext in a portable file is noise on any host with another key, so
  // the note, the sensitive envelope and a custom label travel opened, and
  // the restore seals them under the receiving host's key.
  const savedKey = process.env.ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = "ab".repeat(32);
    _resetCryptoCacheForTests();
  });
  afterEach(() => {
    process.env.ENCRYPTION_KEY = savedKey;
    _resetCryptoCacheForTests();
  });

  function client(dayLog: Record<string, unknown>, label: string | null) {
    return {
      cycleProfile: { findUnique: vi.fn().mockResolvedValue(null) },
      menstrualCycle: { findMany: vi.fn().mockResolvedValue([]) },
      cycleDayLog: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { date: "2026-07-02", symptomLinks: [], ...dayLog },
          ]),
      },
      cycleSymptom: {
        findMany: vi.fn().mockResolvedValue([
          {
            key: "custom_ache",
            labelKey: "cycle.symptom.custom_ache",
            categoryId: "cat-1",
            icon: null,
            sortOrder: 0,
            isActive: true,
            labelEncrypted: label,
          },
        ]),
      },
    } as never;
  }

  it("opens each sealed value and carries no ciphertext", async () => {
    const section = await buildCycleBackupSection(
      client(
        {
          notesEncrypted: encrypt("Cramps at four"),
          sensitiveEncrypted: encrypt(
            JSON.stringify({ sexualActivity: true, contraceptive: "ORAL" }),
          ),
        },
        encrypt("Back ache"),
      ),
      "user-1",
      {},
    );
    const day = section.cycleDayLogs[0];
    expect(day.note).toBe("Cramps at four");
    expect(day.sensitive).toEqual({
      sexualActivity: true,
      contraceptive: "ORAL",
    });
    expect(day).not.toHaveProperty("notesEncrypted");
    expect(day).not.toHaveProperty("sensitiveEncrypted");
    expect(section.customSymptoms[0].label).toBe("Back ache");
    expect(section.customSymptoms[0]).not.toHaveProperty("labelEncrypted");
  });

  it("writes the unreadable marker where this host cannot open a value", async () => {
    const section = await buildCycleBackupSection(
      client(
        {
          notesEncrypted: "v9.bm90LWEtcmVhbC1jaXBoZXJ0ZXh0LWF0LWFsbC1yZWFsbHk=",
        },
        null,
      ),
      "user-1",
      {},
    );
    expect(section.cycleDayLogs[0].note).toBe(UNREADABLE_EXPORT_MARKER);
    expect(section.cycleDayLogs[0].sensitive).toBeNull();
    expect(section.customSymptoms[0].label).toBeNull();
  });
});
