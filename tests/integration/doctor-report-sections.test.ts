/**
 * v1.4.25 W6c — per-section toggle integration tests.
 *
 * Asserts the privacy-by-default contract for mood data: when the user
 * submits `sections.mood = false`, the generated PDF MUST NOT contain
 * any mood-related text, and the aggregator MUST NOT have fetched the
 * underlying `MoodEntry` rows in the first place.
 *
 * Also asserts the "skip section when toggle off" contract for the
 * non-privacy-sensitive sections (BP / weight / pulse / compliance) so
 * the dialog's toggles produce the expected printed artefact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { collectDoctorReportData } from "@/lib/doctor-report-data";
import { ALL_LEAF_IDS } from "@/lib/report-selection/catalogue";
import {
  EMPTY_REPORT_SELECTION,
  selectionFromLeaves,
} from "@/lib/report-selection/selection";
import { renderDoctorReportPdfBytes } from "@/lib/doctor-report-pdf-core";
import { getServerTranslator } from "@/lib/i18n/server-translator";

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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const RANGE = {
  start: new Date("2026-01-01T00:00:00.000Z"),
  end: new Date("2026-05-01T00:00:00.000Z"),
  days: 120,
};

/**
 * Seed a user plus one row of every measurement type the toggles
 * gate. Returns the user id for the test to thread into the aggregator
 * and PDF renderer.
 */
async function seedUserWithEveryDataType(username: string): Promise<string> {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      heightCm: 180,
    },
  });
  const measuredAt = new Date("2026-03-01T08:00:00.000Z");

  await prisma.measurement.createMany({
    data: [
      {
        userId: user.id,
        type: "WEIGHT",
        value: 82.5,
        unit: "kg",
        measuredAt,
      },
      {
        userId: user.id,
        type: "BLOOD_PRESSURE_SYS",
        value: 128,
        unit: "mmHg",
        measuredAt,
      },
      {
        userId: user.id,
        type: "BLOOD_PRESSURE_DIA",
        value: 82,
        unit: "mmHg",
        measuredAt,
      },
      {
        userId: user.id,
        type: "PULSE",
        value: 65,
        unit: "bpm",
        measuredAt,
      },
      // v1.18.0 module-gated data types (no `sections` toggle of their own).
      {
        userId: user.id,
        type: "BLOOD_GLUCOSE",
        value: 95,
        unit: "mg/dL",
        glucoseContext: "FASTING",
        measuredAt,
      },
      {
        userId: user.id,
        type: "RECOVERY_SCORE",
        value: 72,
        unit: "score",
        source: "WHOOP",
        measuredAt,
      },
      {
        userId: user.id,
        type: "STRESS_SCORE",
        value: 40,
        unit: "score",
        measuredAt,
      },
      {
        userId: user.id,
        type: "STRAIN_SCORE",
        value: 12,
        unit: "score",
        measuredAt,
      },
      {
        userId: user.id,
        type: "ACTIVITY_STEPS",
        value: 8200,
        unit: "count",
        measuredAt,
      },
    ],
  });

  // Lab result — module `labs` owns these; the `labs` section toggle is ON by
  // default so a present `labs` module surfaces the panel.
  await prisma.labResult.create({
    data: {
      userId: user.id,
      panel: "Lipids",
      analyte: "LDL",
      value: 110,
      unit: "mg/dL",
      takenAt: measuredAt,
    },
  });

  await prisma.moodEntry.create({
    data: {
      userId: user.id,
      score: 4,
      mood: "GUT",
      moodLoggedAt: measuredAt,
      date: "2026-03-01",
    },
  });

  // Medication compliance — one taken intake event against a scheduled
  // medication. The ledger compliance builder (v1.17 W1a) only tallies
  // medications that carry a schedule (no schedule = PRN/as-needed = no
  // expected dose = excluded so the report never prints a fabricated
  // 100 %), so the fixture must seed a window for the drug to appear in
  // `data.compliance`.
  const med = await prisma.medication.create({
    data: {
      userId: user.id,
      name: "Metformin",
      dose: "500 mg",
      active: true,
      schedules: {
        create: [{ windowStart: "08:00", windowEnd: "10:00" }],
      },
    },
  });
  await prisma.medicationIntakeEvent.create({
    data: {
      userId: user.id,
      medicationId: med.id,
      scheduledFor: measuredAt,
      takenAt: measuredAt,
    },
  });

  return user.id;
}

/**
 * Pull plain UTF-8 text out of the PDF byte stream. jsPDF's text
 * operator stores the strings inline as `(...)` tokens, so a naive
 * regex scan over the buffer is enough to assert presence/absence of a
 * label — we don't need to actually decode the streams. False positives
 * are tolerable because the assertions are negative ("doesn't contain
 * `Stimmung`") and the strings are distinctive.
 */
function pdfContainsText(bytes: Uint8Array, needle: string): boolean {
  const haystack = Buffer.from(bytes).toString("latin1");
  return haystack.includes(needle);
}

describe("doctor-report — per-section toggles", () => {
  it("drops mood data entirely when the mood leaf is not chosen", async () => {
    const userId = await seedUserWithEveryDataType("dr-sections-mood-off");

    const data = await collectDoctorReportData(
      userId,
      RANGE,
      selectionFromLeaves([
        "BLOOD_PRESSURE_SYS",
        "BLOOD_PRESSURE_DIA",
        "WEIGHT",
        "PULSE",
        "BODY_MASS_INDEX",
        "MEDICATION_COMPLIANCE",
        "SLEEP_DURATION",
      ]),
    );

    // The aggregator must NOT return mood data when the toggle is off.
    // The contract: the data never leaves the DB row, so the JSON
    // payload (this `data` object) is the canonical proof.
    expect(data.mood).toBeNull();

    // The PDF rendered from this data must not mention the German or
    // English mood section header — both locales render against the
    // same `data` payload so both must be clean.
    const { t: tDe } = getServerTranslator("de");
    const { t: tEn } = getServerTranslator("en");
    const pdfDe = renderDoctorReportPdfBytes(data, {
      t: tDe,
      locale: "de",
      timeFormat: "AUTO",
      dateFormat: "AUTO",
    });
    const pdfEn = renderDoctorReportPdfBytes(data, {
      t: tEn,
      locale: "en",
      timeFormat: "AUTO",
      dateFormat: "AUTO",
    });

    expect(pdfContainsText(pdfDe, "Stimmung")).toBe(false);
    expect(pdfContainsText(pdfEn, "Mood")).toBe(false);
  });

  it("includes mood data when the mood leaf is chosen by name", async () => {
    const userId = await seedUserWithEveryDataType("dr-sections-mood-on");

    const data = await collectDoctorReportData(
      userId,
      RANGE,
      selectionFromLeaves(["MOOD"]),
    );

    expect(data.mood).not.toBeNull();
    expect(data.mood?.count).toBe(1);
  });

  it("strips BP / weight / pulse / compliance when their leaves are not chosen", async () => {
    const userId = await seedUserWithEveryDataType("dr-sections-others-off");

    const data = await collectDoctorReportData(
      userId,
      RANGE,
      selectionFromLeaves(["LAB_RESULTS"]),
    );

    expect(data.stats.BLOOD_PRESSURE_SYS).toBeUndefined();
    expect(data.stats.BLOOD_PRESSURE_DIA).toBeUndefined();
    expect(data.stats.WEIGHT).toBeUndefined();
    expect(data.stats.PULSE).toBeUndefined();
    expect(data.compliance).toEqual({});
    expect(data.bmi).toBeNull();
    expect(data.mood).toBeNull();
  });

  it("serves nothing at all for an empty selection", async () => {
    // The case the release exists for. An account with data in every domain
    // and a caller that named no leaf gets an empty record — not the
    // "everything except mood and cycle" the old defaults produced.
    const userId = await seedUserWithEveryDataType("dr-sections-defaults");

    const data = await collectDoctorReportData(
      userId,
      RANGE,
      EMPTY_REPORT_SELECTION,
    );

    expect(data.mood).toBeNull();
    expect(data.stats).toEqual({});
    expect(data.measurements).toEqual({});
    expect(data.bmi).toBeNull();
    expect(data.compliance).toEqual({});
    expect(data.medications).toEqual([]);
    expect(data.labResults).toBeNull();
    expect(data.allergies).toBeNull();
    expect(data.familyHistory).toBeNull();
    expect(data.patient.username).toBeNull();
    expect(data.patient.insurerName).toBeNull();
  });
});

describe("doctor-report — module enable/disable gating", () => {
  // A fully-enabled module map (the default-on shape `resolveModuleMap` would
  // return for an account that never toggled a module off).
  const ALL_ON = {
    cycle: true,
    mood: true,
    sleep: true,
    glucose: true,
    workouts: true,
    recovery: true,
    labs: true,
    illness: true,
    achievements: true,
    coach: true,
    insights: true,
    medications: true,
    doctorReport: true,
    environment: true,
    mcp: true,
    inboundDocuments: true,
    mentalHealth: true,
    nutrients: true,
    vaccinations: true,
  } as const;

  it("includes every module's data when all modules are enabled", async () => {
    const userId = await seedUserWithEveryDataType("dr-modules-all-on");

    const data = await collectDoctorReportData(
      userId,
      RANGE,
      selectionFromLeaves(ALL_LEAF_IDS),
      { moduleMap: { ...ALL_ON } },
    );

    expect(Object.keys(data.glucoseStats).length).toBeGreaterThan(0);
    expect(data.measurements.ACTIVITY_STEPS).toBeDefined();
    expect(data.measurements.BLOOD_GLUCOSE).toBeDefined();
    expect(data.labResults).not.toBeNull();
    expect(data.mood).not.toBeNull();
    const scoreTypes = (data.wellnessScores ?? []).map((s) => s.type);
    expect(scoreTypes).toEqual(
      expect.arrayContaining([
        "RECOVERY_SCORE",
        "STRESS_SCORE",
        "STRAIN_SCORE",
      ]),
    );
  });

  it("excludes a disabled module's section/resources from the payload", async () => {
    const userId = await seedUserWithEveryDataType("dr-modules-off");

    const data = await collectDoctorReportData(
      userId,
      RANGE,
      // Every leaf chosen at the report level, but the modules are off — the
      // module gate wins, so none of these surface.
      selectionFromLeaves(ALL_LEAF_IDS),
      {
        moduleMap: {
          ...ALL_ON,
          glucose: false,
          sleep: false,
          workouts: false,
          recovery: false,
          labs: false,
          mood: false,
        },
      },
    );

    // Glucose panel collapses entirely (stats + raw series).
    expect(data.glucoseStats).toEqual({});
    expect(data.glucoseRanges).toEqual({});
    expect(data.measurements.BLOOD_GLUCOSE).toBeUndefined();
    // Sleep series stripped (sections + module agree).
    expect(data.measurements.SLEEP_DURATION).toBeUndefined();
    // Workout activity series stripped.
    expect(data.measurements.ACTIVITY_STEPS).toBeUndefined();
    expect(data.stats.ACTIVITY_STEPS).toBeUndefined();
    // Labs panel gone.
    expect(data.labResults).toBeNull();
    // Mood never assembled.
    expect(data.mood).toBeNull();
    // Recovery + strain wellness scores dropped (recovery + workouts off).
    const scoreTypes = (data.wellnessScores ?? []).map((s) => s.type);
    expect(scoreTypes).not.toContain("RECOVERY_SCORE");
    expect(scoreTypes).not.toContain("STRESS_SCORE");
    expect(scoreTypes).not.toContain("STRAIN_SCORE");
    // Core clinical sections stay unconditional.
    expect(data.stats.WEIGHT).toBeDefined();
    expect(data.stats.BLOOD_PRESSURE_SYS).toBeDefined();
    expect(data.stats.PULSE).toBeDefined();
    expect(Object.keys(data.compliance).length).toBeGreaterThan(0);
  });

  it("gates recovery and workouts independently (recovery off, workouts on)", async () => {
    const userId = await seedUserWithEveryDataType("dr-modules-recovery-off");

    const data = await collectDoctorReportData(
      userId,
      RANGE,
      selectionFromLeaves(ALL_LEAF_IDS),
      { moduleMap: { ...ALL_ON, recovery: false } },
    );

    const scoreTypes = (data.wellnessScores ?? []).map((s) => s.type);
    // Recovery readiness scores gone…
    expect(scoreTypes).not.toContain("RECOVERY_SCORE");
    expect(scoreTypes).not.toContain("STRESS_SCORE");
    // …but the workout-owned strain score + activity series stay.
    expect(scoreTypes).toContain("STRAIN_SCORE");
    expect(data.measurements.ACTIVITY_STEPS).toBeDefined();
  });
});

describe("doctor-report — MedicationAdministration export cap", () => {
  it("caps the administration set at the configured ceiling and flags the truncation", async () => {
    // The default ceiling is 5000; pin the operator-configurable
    // `FHIR_MAX_MEDICATION_ADMINISTRATIONS` to 1000 so the cap is exercised
    // with a tractable row count (the cap is resolved per call).
    vi.stubEnv("FHIR_MAX_MEDICATION_ADMINISTRATIONS", "1000");
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "dr-admin-cap",
        email: "dr-admin-cap@example.test",
        heightCm: 180,
      },
    });
    const med = await prisma.medication.create({
      data: {
        userId: user.id,
        name: "Metformin",
        dose: "500 mg",
        active: true,
      },
    });

    // 1001 acted (taken) intakes spread across the window so the cap
    // must trim exactly one — the OLDEST — keeping the most-recent 1000.
    const rangeMs = RANGE.end.getTime() - RANGE.start.getTime();
    const rows = Array.from({ length: 1001 }, (_, i) => {
      const at = new Date(
        RANGE.start.getTime() + Math.floor((rangeMs * i) / 1001),
      );
      return {
        userId: user.id,
        medicationId: med.id,
        scheduledFor: at,
        takenAt: at,
      };
    });
    await prisma.medicationIntakeEvent.createMany({ data: rows });

    const data = await collectDoctorReportData(
      user.id,
      RANGE,
      selectionFromLeaves(["MEDICATION_ADMINISTRATIONS"]),
    );

    expect(data.medicationAdministrations).toBeDefined();
    expect(data.medicationAdministrations?.length).toBe(1000);
    expect(data.medicationAdministrationsTruncation).toEqual({
      total: 1001,
      included: 1000,
    });
    // The OLDEST row was dropped — the earliest surviving administration
    // is strictly after the window start.
    const first = data.medicationAdministrations?.[0];
    expect(new Date(first!.effectiveAt).getTime()).toBeGreaterThan(
      RANGE.start.getTime(),
    );
  });

  it("leaves the set untouched (no truncation flag) below the cap", async () => {
    const userId = await seedUserWithEveryDataType("dr-admin-no-cap");

    const data = await collectDoctorReportData(
      userId,
      RANGE,
      selectionFromLeaves(["MEDICATION_ADMINISTRATIONS"]),
    );

    expect(data.medicationAdministrations?.length).toBe(1);
    expect(data.medicationAdministrationsTruncation ?? null).toBeNull();
  });
});
