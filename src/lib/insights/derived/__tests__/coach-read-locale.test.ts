/**
 * The "Coach read" strip's second line has to arrive in the reader's language.
 *
 * On a German metric page the strip used to print its own summary in German
 * and the pattern line under it in English, one under the other. Nothing was
 * mistranslated: the pattern line is a finished sentence the server writes,
 * the route never said who was reading, and the engine's optional locale
 * quietly answered in English.
 *
 * So this drives the REAL pipe — `buildCoachReadStrip` → `readCoachCorrelations`
 * → `discoverCorrelations` — with only the database reads faked, and asserts the
 * German sentence the German templates produce. Testing the engine alone would
 * have stayed green through the whole outage: the engine could always speak
 * German, it was simply never asked.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const measurementFindMany = vi.fn();
const measurementFindFirst = vi.fn();
const moodFindMany = vi.fn();
const userFindUnique = vi.fn();
const medicationFindMany = vi.fn();
const intakeEventFindMany = vi.fn();
const illnessEpisodeFindMany = vi.fn();
const illnessDayLogFindMany = vi.fn();
const labResultFindMany = vi.fn();
const environmentContextFindMany = vi.fn();
const customMetricFindMany = vi.fn();

vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: vi.fn(async () => true),
  // Every module on: the record's map feeds the matrix mask.
  resolveModuleMap: vi.fn(async () => ({})),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: (a: unknown) => measurementFindMany(a),
      findFirst: (a: unknown) => measurementFindFirst(a),
    },
    moodEntry: { findMany: (a: unknown) => moodFindMany(a) },
    user: { findUnique: (a: unknown) => userFindUnique(a) },
    medication: { findMany: (a: unknown) => medicationFindMany(a) },
    medicationIntakeEvent: { findMany: (a: unknown) => intakeEventFindMany(a) },
    illnessEpisode: { findMany: (a: unknown) => illnessEpisodeFindMany(a) },
    illnessDayLog: { findMany: (a: unknown) => illnessDayLogFindMany(a) },
    labResult: { findMany: (a: unknown) => labResultFindMany(a) },
    // The reader assembles the shared discovery matrix, which reads the
    // environmental-exposure and custom-metric channels too.
    environmentContext: {
      findMany: (a: unknown) => environmentContextFindMany(a),
    },
    customMetric: { findMany: (a: unknown) => customMetricFindMany(a) },
    symptomDefinition: { findMany: async () => [] },
  },
}));

// The band engine is `baseline.test.ts`'s subject; the strip's FIRST line is
// not what is under test here. Only the second line is, so the band degrades to
// "still learning" and the driver line stands alone.
const PROFILE = { ageYears: 40, sex: "MALE", heightCm: 180 };
vi.mock("@/lib/insights/derived", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/insights/derived")>();
  return {
    ...actual,
    loadBaselineProfile: async () => PROFILE,
    computeCoincidentDeviation: async () => null,
  };
});
vi.mock("@/lib/insights/derived/baseline", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/insights/derived/baseline")>();
  return {
    ...actual,
    loadBaselineProfile: async () => PROFILE,
    computeVitalsBaseline: async () => ({
      status: "insufficient" as const,
      reason: "not under test",
    }),
  };
});

import { buildCoachReadStrip } from "@/lib/insights/derived/coach-read";

const DAYS = 45;
const BASE = Date.UTC(2026, 4, 1, 12, 0, 0); // midday → a tz-stable day key

function dayKey(offset: number): string {
  const d = new Date(BASE + offset * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * 45 days where today's symptom burden runs against tomorrow's sleep, strongly
 * enough to clear n ≥ 20, p < 0.05, the FDR control and the effect-size floor.
 * Same fixture shape the correlations reader's own real-engine test uses.
 */
function seedSymptomDrivesSleep() {
  const dayLogs: Array<{
    date: string;
    functionalImpact: number;
    symptomLinks: Array<{ severity: number }>;
  }> = [];
  const measurements: Array<{ type: string; value: number; measuredAt: Date }> =
    [];
  for (let i = 0; i < DAYS; i++) {
    const burden = i % 4;
    dayLogs.push({
      date: dayKey(i),
      functionalImpact: burden,
      symptomLinks: [],
    });
    measurements.push({
      type: "SLEEP_DURATION",
      value: 8 - burden,
      measuredAt: new Date(BASE + (i + 1) * 86_400_000),
    });
  }
  measurementFindMany.mockResolvedValue(measurements);
  illnessEpisodeFindMany.mockResolvedValue([
    {
      id: "ep1",
      onsetAt: new Date(BASE),
      resolvedAt: new Date(BASE + DAYS * 86_400_000),
    },
  ]);
  illnessDayLogFindMany.mockResolvedValue(dayLogs);
}

describe("buildCoachReadStrip — the pattern line speaks the reader's language", () => {
  beforeEach(() => {
    measurementFindMany.mockReset().mockResolvedValue([]);
    measurementFindFirst.mockReset().mockResolvedValue({ value: 7 });
    moodFindMany.mockReset().mockResolvedValue([]);
    userFindUnique.mockReset().mockResolvedValue({ timezone: "Europe/Berlin" });
    medicationFindMany.mockReset().mockResolvedValue([]);
    intakeEventFindMany.mockReset().mockResolvedValue([]);
    illnessEpisodeFindMany.mockReset().mockResolvedValue([]);
    illnessDayLogFindMany.mockReset().mockResolvedValue([]);
    labResultFindMany.mockReset().mockResolvedValue([]);
    environmentContextFindMany.mockReset().mockResolvedValue([]);
    customMetricFindMany.mockReset().mockResolvedValue([]);
    seedSymptomDrivesSleep();
  });

  it("writes the driver note in German for a German reader", async () => {
    const strip = await buildCoachReadStrip("u1", "SLEEP_DURATION", "de", {
      tz: "UTC",
    });

    expect(strip.driver).not.toBeNull();
    const note = strip.driver!.note;

    // The exact German sentence, not merely "different from the English one".
    // A sentence that is different but wrong is still a broken page.
    expect(note).toBe(
      "Wenn die Symptomstärke höher liegt, scheint die Schlafdauer am " +
        "Folgetag nach bisheriger Datenlage eher niedriger auszufallen — ein " +
        "Muster, das Beachtung verdient, keine Ursache.",
    );
  });

  it("writes the same driver note in English for an English reader", async () => {
    const strip = await buildCoachReadStrip("u1", "SLEEP_DURATION", "en", {
      tz: "UTC",
    });

    expect(strip.driver).not.toBeNull();
    expect(strip.driver!.note).toBe(
      "Higher symptom severity looks like it goes with lower next-day sleep " +
        "duration in your data, on the evidence so far — a pattern worth " +
        "watching, not a cause.",
    );
  });

  it("keeps the driver's matching keys language-independent", async () => {
    // Only the sentence is localised. `outcome` is how the strip finds the
    // driver that belongs to THIS metric, so it has to stay the same string in
    // every language or a German page would find no driver at all.
    const de = await buildCoachReadStrip("u1", "SLEEP_DURATION", "de", {
      tz: "UTC",
    });
    const en = await buildCoachReadStrip("u1", "SLEEP_DURATION", "en", {
      tz: "UTC",
    });

    expect(de.driver!.outcome).toBe("sleep duration");
    expect(en.driver!.outcome).toBe("sleep duration");
    expect(de.driver!.behaviour).toBe(en.driver!.behaviour);
    expect(de.driver!.note).not.toBe(en.driver!.note);
  });
});
