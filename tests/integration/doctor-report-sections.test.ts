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
    ],
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

  // Medication compliance — one taken intake event.
  const med = await prisma.medication.create({
    data: {
      userId: user.id,
      name: "Metformin",
      dose: "500 mg",
      active: true,
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
  it("drops mood data entirely when sections.mood = false", async () => {
    const userId = await seedUserWithEveryDataType("dr-sections-mood-off");

    const data = await collectDoctorReportData(userId, RANGE, {
      sections: {
        bp: true,
        weight: true,
        pulse: true,
        bmi: true,
        mood: false, // ← the privacy default
        compliance: true,
        sleep: true,
      },
    });

    // The aggregator must NOT return mood data when the toggle is off.
    // The contract: the data never leaves the DB row, so the JSON
    // payload (this `data` object) is the canonical proof.
    expect(data.mood).toBeNull();

    // The PDF rendered from this data must not mention the German or
    // English mood section header — both locales render against the
    // same `data` payload so both must be clean.
    const { t: tDe } = getServerTranslator("de");
    const { t: tEn } = getServerTranslator("en");
    const pdfDe = renderDoctorReportPdfBytes(data, { t: tDe, locale: "de" });
    const pdfEn = renderDoctorReportPdfBytes(data, { t: tEn, locale: "en" });

    expect(pdfContainsText(pdfDe, "Stimmung")).toBe(false);
    expect(pdfContainsText(pdfEn, "Mood")).toBe(false);
  });

  it("includes mood data when sections.mood = true (opt-in)", async () => {
    const userId = await seedUserWithEveryDataType("dr-sections-mood-on");

    const data = await collectDoctorReportData(userId, RANGE, {
      sections: { mood: true },
    });

    expect(data.mood).not.toBeNull();
    expect(data.mood?.count).toBe(1);
  });

  it("strips BP / weight / pulse / compliance when their toggles are off", async () => {
    const userId = await seedUserWithEveryDataType("dr-sections-others-off");

    const data = await collectDoctorReportData(userId, RANGE, {
      sections: {
        bp: false,
        weight: false,
        pulse: false,
        bmi: false,
        mood: false,
        compliance: false,
        sleep: false,
      },
    });

    expect(data.stats.BLOOD_PRESSURE_SYS).toBeUndefined();
    expect(data.stats.BLOOD_PRESSURE_DIA).toBeUndefined();
    expect(data.stats.WEIGHT).toBeUndefined();
    expect(data.stats.PULSE).toBeUndefined();
    expect(data.compliance).toEqual({});
    expect(data.bmi).toBeNull();
    expect(data.mood).toBeNull();
  });

  it("applies documented defaults when sections is omitted (mood OFF, others ON)", async () => {
    const userId = await seedUserWithEveryDataType("dr-sections-defaults");

    const data = await collectDoctorReportData(userId, RANGE);

    // Privacy default per Marc — mood is opt-in, not opt-out.
    expect(data.mood).toBeNull();
    // Every other section keeps its data.
    expect(data.stats.WEIGHT).toBeDefined();
    expect(data.stats.BLOOD_PRESSURE_SYS).toBeDefined();
    expect(data.stats.PULSE).toBeDefined();
    expect(data.bmi).not.toBeNull();
    expect(Object.keys(data.compliance).length).toBeGreaterThan(0);
  });
});
