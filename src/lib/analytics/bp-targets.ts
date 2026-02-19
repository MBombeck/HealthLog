/**
 * Automatic BP target calculation based on ESC/ESH 2018 guidelines.
 *
 * Age-based systolic/diastolic target ranges:
 * - <65:  Sys 120–129, Dia 70–79
 * - 65–79: Sys 130–139, Dia 70–79
 * - ≥80:  Sys 130–139, Dia 70–79
 */

export interface BpTargets {
  sysLow: number;
  sysHigh: number;
  diaLow: number;
  diaHigh: number;
}

function getAge(dateOfBirth: Date): number {
  const today = new Date();
  let age = today.getFullYear() - dateOfBirth.getFullYear();
  const monthDiff = today.getMonth() - dateOfBirth.getMonth();
  if (
    monthDiff < 0 ||
    (monthDiff === 0 && today.getDate() < dateOfBirth.getDate())
  ) {
    age--;
  }
  return age;
}

export function getBpTargets(dateOfBirth: Date | null): BpTargets | null {
  if (!dateOfBirth) return null;

  const age = getAge(dateOfBirth);

  if (age < 65) {
    return { sysLow: 120, sysHigh: 129, diaLow: 70, diaHigh: 79 };
  }
  // 65+ (both 65–79 and ≥80 have the same targets per ESC/ESH)
  return { sysLow: 130, sysHigh: 139, diaLow: 70, diaHigh: 79 };
}
