type PulseGender = "MALE" | "FEMALE" | null | undefined;

interface PulsePercentileRow {
  minAge: number;
  maxAge: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
}

const MALE_PERCENTILES: PulsePercentileRow[] = [
  { minAge: 20, maxAge: 39, p10: 55, p25: 61, p75: 76, p90: 84 },
  { minAge: 40, maxAge: 59, p10: 55, p25: 61, p75: 77, p90: 85 },
  { minAge: 60, maxAge: 79, p10: 54, p25: 60, p75: 75, p90: 84 },
  { minAge: 80, maxAge: 200, p10: 54, p25: 61, p75: 78, p90: 86 },
];

const FEMALE_PERCENTILES: PulsePercentileRow[] = [
  { minAge: 20, maxAge: 39, p10: 60, p25: 66, p75: 82, p90: 89 },
  { minAge: 40, maxAge: 59, p10: 59, p25: 64, p75: 79, p90: 86 },
  { minAge: 60, maxAge: 79, p10: 59, p25: 64, p75: 78, p90: 86 },
  { minAge: 80, maxAge: 200, p10: 59, p25: 64, p75: 77, p90: 85 },
];

export interface PersonalizedPulseTarget {
  greenMin: number;
  greenMax: number;
  orangeMin: number;
  orangeMax: number;
  source: string;
}

export interface PulseTargetClassification {
  category: string;
  color: string;
  severity: "info" | "normal" | "warning" | "danger";
}

function resolveRow(
  age: number,
  table: PulsePercentileRow[],
): PulsePercentileRow {
  return (
    table.find((row) => age >= row.minAge && age <= row.maxAge) ??
    table[table.length - 1]
  );
}

export function getAgeFromDateOfBirth(
  dateOfBirth: Date | string | null | undefined,
): number | null {
  if (!dateOfBirth) return null;
  const dob =
    typeof dateOfBirth === "string" ? new Date(dateOfBirth) : dateOfBirth;
  if (Number.isNaN(dob.getTime())) return null;

  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age--;
  }
  return age;
}

export function getPersonalizedPulseTarget(
  age: number | null,
  gender: PulseGender,
): PersonalizedPulseTarget {
  // AHA fallback for adults when profile context is missing.
  if (age == null || age < 20) {
    return {
      greenMin: 60,
      greenMax: 100,
      orangeMin: 55,
      orangeMax: 105,
      source: "AHA (Erwachsene, Ruhepuls 60-100 bpm)",
    };
  }

  const male = resolveRow(age, MALE_PERCENTILES);
  const female = resolveRow(age, FEMALE_PERCENTILES);

  const selected =
    gender === "MALE"
      ? male
      : gender === "FEMALE"
        ? female
        : {
            p10: (male.p10 + female.p10) / 2,
            p25: (male.p25 + female.p25) / 2,
            p75: (male.p75 + female.p75) / 2,
            p90: (male.p90 + female.p90) / 2,
          };

  return {
    greenMin: Math.round(selected.p25),
    greenMax: Math.round(selected.p75),
    orangeMin: Math.round(selected.p10),
    orangeMax: Math.round(selected.p90),
    source: "CDC/NCHS",
  };
}

export function classifyPulseByTarget(
  bpm: number,
  target: PersonalizedPulseTarget,
): PulseTargetClassification {
  if (bpm < target.orangeMin) {
    return { category: "Deutlich niedrig", color: "#8be9fd", severity: "info" };
  }
  if (bpm < target.greenMin) {
    return {
      category: "Leicht niedrig",
      color: "#ffb86c",
      severity: "warning",
    };
  }
  if (bpm <= target.greenMax) {
    return { category: "Zielbereich", color: "#50fa7b", severity: "normal" };
  }
  if (bpm <= target.orangeMax) {
    return { category: "Leicht erhöht", color: "#ffb86c", severity: "warning" };
  }
  return { category: "Deutlich erhöht", color: "#ff5555", severity: "danger" };
}
