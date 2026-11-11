/**
 * v1.18.1 — the Vorsorge measurement-type allow-list. Widened from
 * the original 7 to the ~15 active-measurement set (vitals + the
 * body-composition family). App-layer only — the DB column is the full
 * MeasurementType enum, so this is the gate, not a migration.
 */
import { describe, expect, it } from "vitest";

import {
  measurementReminderTypeEnum,
  createMeasurementReminderSchema,
} from "../measurement-reminders";

describe("measurementReminderTypeEnum (V3 — completeness)", () => {
  const allowed = measurementReminderTypeEnum.options;

  it("exposes the full active set: vitals + body composition + screenings", () => {
    expect(new Set(allowed)).toEqual(
      new Set([
        // Vitals
        "WEIGHT",
        "BLOOD_PRESSURE_SYS",
        "PULSE",
        "BLOOD_GLUCOSE",
        "BLOOD_KETONES",
        "OXYGEN_SATURATION",
        "BODY_TEMPERATURE",
        // Body composition
        "BODY_FAT",
        "FAT_MASS",
        "FAT_FREE_MASS",
        "MUSCLE_MASS",
        "LEAN_BODY_MASS",
        "BONE_MASS",
        "TOTAL_BODY_WATER",
        "VISCERAL_FAT",
        "BODY_MASS_INDEX",
        "WAIST_CIRCUMFERENCE",
        // v1.27.6 — plannable mental-wellbeing screenings
        "PHQ9_SCORE",
        "GAD7_SCORE",
        // v1.27.9 — WHO-5 + SCI join on the identical contract
        "WHO5_SCORE",
        "SCI_SCORE",
      ]),
    );
  });

  it("accepts the WHO-5 / SCI screenings with the 4-week default cadence", () => {
    for (const measurementType of ["WHO5_SCORE", "SCI_SCORE"]) {
      const parsed = createMeasurementReminderSchema.safeParse({
        label: "Screening check-in",
        measurementType,
        intervalDays: 28,
      });
      expect(parsed.success, `expected ${measurementType} to be allowed`).toBe(
        true,
      );
    }
  });

  it("accepts a plannable screening reminder with the 4-week default cadence", () => {
    const parsed = createMeasurementReminderSchema.safeParse({
      label: "PHQ-9 Check-in",
      measurementType: "PHQ9_SCORE",
      intervalDays: 28,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a newly-added body-composition type on create", () => {
    const parsed = createMeasurementReminderSchema.safeParse({
      label: "Körperzusammensetzung messen",
      measurementType: "MUSCLE_MASS",
      intervalDays: 7,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts WAIST_CIRCUMFERENCE (the added body-composition target)", () => {
    expect(allowed).toContain("WAIST_CIRCUMFERENCE");
    const parsed = createMeasurementReminderSchema.safeParse({
      label: "Taillenumfang messen",
      measurementType: "WAIST_CIRCUMFERENCE",
      intervalDays: 30,
    });
    expect(parsed.success).toBe(true);
  });

  it("does NOT add WAIST_TO_HEIGHT (only waist circumference was requested)", () => {
    expect(allowed).not.toContain("WAIST_TO_HEIGHT");
  });

  it("matches BP on the SYS sentinel only (DIA would double-count)", () => {
    expect(allowed).toContain("BLOOD_PRESSURE_SYS");
    expect(allowed).not.toContain("BLOOD_PRESSURE_DIA");
  });

  it("deliberately excludes passive / cumulative / event types", () => {
    for (const excluded of [
      "RESTING_HEART_RATE",
      "HEART_RATE_VARIABILITY",
      "VO2_MAX",
      "ACTIVITY_STEPS",
      "RECOVERY_SCORE",
      "SLEEP_DURATION",
      "IRREGULAR_RHYTHM_NOTIFICATION",
    ]) {
      expect(allowed).not.toContain(excluded);
    }
  });

  it("still accepts a free-text reminder (null type) resolving on satisfy / lab", () => {
    const parsed = createMeasurementReminderSchema.safeParse({
      label: "Großes Blutbild",
      measurementType: null,
      rrule: "FREQ=YEARLY",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("createMeasurementReminderSchema — first-due date", () => {
  const base = { label: "Blood test", intervalDays: 365 };
  it.each([
    ["2026-10-01", true],
    ["2026-10-01T00:00:00.000Z", true],
    ["2026-10-01T00:00:00-07:00", true],
    ["2026-10-01T00:00:00", false],
    ["01.10.2026", false],
  ])("anchorDate %s is accepted: %s", (anchorDate, ok) => {
    expect(
      createMeasurementReminderSchema.safeParse({ ...base, anchorDate })
        .success,
    ).toBe(ok);
  });
});
