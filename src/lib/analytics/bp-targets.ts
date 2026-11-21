import { ageInYears } from "@/lib/tz/date-only";

/**
 * Automatic BP target calculation based on ESH 2023 guidelines (the
 * last *joint* ESC/ESH document was 2018; ESC withdrew from the 2023
 * authoring, so "ESC/ESH 2023" does not exist as a reference). Target
 * bands are unchanged 2018 → 2023 — only the citation moves.
 *
 *   Mancia G et al. "2023 ESH Guidelines for the management of
 *   arterial hypertension." J Hypertens. 2023.
 *   https://journals.lww.com/jhypertension/fulltext/2023/12000/2023_esh_guidelines_for_the_management_of_arterial.2.aspx
 *
 * Age-based systolic/diastolic target ranges:
 * - <65:  Sys 120–129, Dia 70–79
 * - 65–79: Sys 130–139, Dia 70–79
 * - ≥80:  Sys 130–139, Dia 70–79
 *
 * Cross-checked against:
 * - ACC/AHA 2017 hypertension guideline (≥130/80 stage 1) — HealthLog
 *   intentionally uses the European bands; ACC/AHA's lower threshold
 *   is referenced only as a comparison anchor in the AI prompt.
 * - DEGAM S3 / Hausärzteverband (2024 update): aligns with ESH
 *   targets for primary care.
 */

export interface BpTargets {
  sysLow: number;
  sysHigh: number;
  diaLow: number;
  diaHigh: number;
}

export function bpTargetsEqual(
  left: BpTargets | null,
  right: BpTargets | null,
): boolean {
  return (
    left?.sysLow === right?.sysLow &&
    left?.sysHigh === right?.sysHigh &&
    left?.diaLow === right?.diaLow &&
    left?.diaHigh === right?.diaHigh
  );
}

export function getBpTargets(
  dateOfBirth: Date | null,
  timezone: string,
  now: Date = new Date(),
): BpTargets | null {
  const age = ageInYears(dateOfBirth, timezone, now);
  if (age === null) return null;

  if (age < 65) {
    return { sysLow: 120, sysHigh: 129, diaLow: 70, diaHigh: 79 };
  }
  // 65+ (both 65–79 and ≥80 have the same targets per ESH 2023)
  return { sysLow: 130, sysHigh: 139, diaLow: 70, diaHigh: 79 };
}
