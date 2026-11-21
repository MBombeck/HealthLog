/**
 * FHIR vital-sign Observations onto native measurement types.
 *
 * A closed table, by LOINC code, with the units each code is read in. A
 * vital in any other unit is refused (`unit_mismatch`) rather than guessed:
 * a weight in an unknown unit is worse than a missing one. Blood pressure
 * arrives as the 85354-9 panel with its two components, or as the two codes
 * on their own.
 */
import type { MeasurementType } from "@/generated/prisma/client";

type Converter = (value: number) => number;

interface VitalSpec {
  type: MeasurementType;
  units: Record<string, Converter>;
}

const same: Converter = (v) => v;
const PER_MINUTE = {
  "/min": same,
  "{beats}/min": same,
  "beats/min": same,
  "beats/minute": same,
  bpm: same,
  "{breaths}/min": same,
  "breaths/min": same,
};
const PERCENT = { "%": same };
const MMHG = { "mm[hg]": same, mmhg: same };

export const VITAL_LOINC: Record<string, VitalSpec> = {
  "29463-7": {
    type: "WEIGHT",
    units: {
      kg: same,
      g: (v) => v / 1000,
      "[lb_av]": (v) => v * 0.45359237,
      lb: (v) => v * 0.45359237,
      lbs: (v) => v * 0.45359237,
    },
  },
  "3141-9": {
    type: "WEIGHT",
    units: { kg: same, g: (v) => v / 1000, "[lb_av]": (v) => v * 0.45359237 },
  },
  "8867-4": { type: "PULSE", units: PER_MINUTE },
  "40443-4": { type: "RESTING_HEART_RATE", units: PER_MINUTE },
  "59408-5": { type: "OXYGEN_SATURATION", units: PERCENT },
  "2708-6": { type: "OXYGEN_SATURATION", units: PERCENT },
  "9279-1": { type: "RESPIRATORY_RATE", units: PER_MINUTE },
  "8310-5": {
    type: "BODY_TEMPERATURE",
    units: {
      cel: same,
      "°c": same,
      c: same,
      "[degf]": (v) => ((v - 32) * 5) / 9,
      "°f": (v) => ((v - 32) * 5) / 9,
      f: (v) => ((v - 32) * 5) / 9,
    },
  },
  "39156-5": {
    type: "BODY_MASS_INDEX",
    units: { "kg/m2": same, "kg/m^2": same },
  },
  "41982-0": { type: "BODY_FAT", units: PERCENT },
  "8480-6": { type: "BLOOD_PRESSURE_SYS", units: MMHG },
  "8462-4": { type: "BLOOD_PRESSURE_DIA", units: MMHG },
};

export const BP_PANEL_CODES = new Set(["85354-9", "55284-4"]);

/** The LOINC codes a CodeableConcept carries. */
export function loincCodes(concept: unknown): string[] {
  if (!concept || typeof concept !== "object") return [];
  const coding = (concept as { coding?: unknown }).coding;
  if (!Array.isArray(coding)) return [];
  const out: string[] = [];
  for (const c of coding) {
    if (!c || typeof c !== "object") continue;
    const { system, code } = c as { system?: unknown; code?: unknown };
    if (typeof code !== "string") continue;
    if (typeof system === "string" && !system.includes("loinc.org")) continue;
    out.push(code.trim());
  }
  return out;
}

/** A Quantity's value in the spec's unit, or a reason it has none. */
export function vitalValue(
  spec: VitalSpec,
  quantity: unknown,
): { value: number } | { reason: "no_value" | "unit_mismatch" } {
  if (!quantity || typeof quantity !== "object") return { reason: "no_value" };
  const q = quantity as { value?: unknown; code?: unknown; unit?: unknown };
  if (typeof q.value !== "number" || !Number.isFinite(q.value)) {
    return { reason: "no_value" };
  }
  for (const raw of [q.code, q.unit]) {
    if (typeof raw !== "string") continue;
    const convert = spec.units[raw.trim().toLowerCase()];
    if (convert) return { value: convert(q.value) };
  }
  return { reason: "unit_mismatch" };
}
