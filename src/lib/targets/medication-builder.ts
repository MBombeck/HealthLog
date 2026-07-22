import {
  buildComplianceMedicationContext,
  calculateCompliance,
  lastNonSkippedTakenAt,
} from "@/lib/analytics/compliance";
import { userDayKey } from "@/lib/tz/resolver";
import { rollupFromDayMap } from "./consistency";
import type {
  DayBand,
  TargetIntakeEvent,
  TargetItem,
  TargetMedication,
} from "./types";

interface MedicationTargetInput {
  activeMedications: TargetMedication[];
  intakeEvents: TargetIntakeEvent[];
  timezone: string;
  now: Date;
}

export function buildMedicationTarget({
  activeMedications,
  intakeEvents,
  timezone,
  now,
}: MedicationTargetInput): TargetItem | null {
  if (activeMedications.length === 0) return null;

  const medicationStats = activeMedications.map((medication) => {
    const events = intakeEvents.filter(
      (event) => event.medicationId === medication.id,
    );
    const medicationContext = buildComplianceMedicationContext(
      medication,
      lastNonSkippedTakenAt(events),
      timezone,
    );
    const compliance7 = calculateCompliance(
      events,
      medication.schedules,
      7,
      medication.createdAt,
      { medicationContext },
    );
    const compliance30 = calculateCompliance(
      events,
      medication.schedules,
      30,
      medication.createdAt,
      { medicationContext },
    );
    return {
      name: medication.name,
      compliance7: compliance7.rate,
      compliance30: compliance30.rate,
      totalExpected7: compliance7.totalExpected,
      taken7: compliance7.taken,
      totalExpected30: compliance30.totalExpected,
      taken30: compliance30.taken,
    };
  });

  const totalExpected7 = medicationStats.reduce(
    (sum, medication) => sum + medication.totalExpected7,
    0,
  );
  const totalTaken7 = medicationStats.reduce(
    (sum, medication) => sum + medication.taken7,
    0,
  );
  const totalExpected30 = medicationStats.reduce(
    (sum, medication) => sum + medication.totalExpected30,
    0,
  );
  const totalTaken30 = medicationStats.reduce(
    (sum, medication) => sum + medication.taken30,
    0,
  );
  const complianceRate7 =
    totalExpected7 > 0
      ? Math.round(
          (Math.min(1, totalTaken7 / totalExpected7) * 100 + Number.EPSILON) *
            10,
        ) / 10
      : null;
  const complianceRate30 =
    totalExpected30 > 0
      ? Math.round(
          (Math.min(1, totalTaken30 / totalExpected30) * 100 + Number.EPSILON) *
            10,
        ) / 10
      : complianceRate7;

  const countsByDay = new Map<string, { taken: number; expected: number }>();
  for (const event of intakeEvents) {
    const key = userDayKey(event.scheduledFor, timezone);
    const counts = countsByDay.get(key) ?? { taken: 0, expected: 0 };
    counts.expected += 1;
    if (event.takenAt && !event.skipped) counts.taken += 1;
    countsByDay.set(key, counts);
  }
  const bandsByDay = new Map<string, DayBand | null>();
  for (const [key, counts] of countsByDay) {
    if (counts.expected === 0) {
      bandsByDay.set(key, null);
      continue;
    }
    const ratio = counts.taken / counts.expected;
    bandsByDay.set(key, ratio >= 0.99 ? "in" : ratio >= 0.5 ? "near" : "out");
  }

  return {
    type: "MEDICATION_COMPLIANCE",
    label: "Medication compliance",
    current: complianceRate7,
    average30: complianceRate30,
    trend: null,
    unit: "%",
    range: { min: 90, max: 100 },
    classification:
      complianceRate7 != null
        ? complianceRate7 >= 90
          ? { category: "Very good", color: "var(--success)" }
          : complianceRate7 >= 70
            ? { category: "Good", color: "var(--dracula-yellow)" }
            : { category: "Low", color: "var(--destructive)" }
        : null,
    source: "7-day",
    details: {
      medications: medicationStats.map((medication) => ({
        name: medication.name,
        compliance7: medication.compliance7,
        compliance30: medication.compliance30,
      })),
    },
    ...rollupFromDayMap({
      dayBandByKey: bandsByDay,
      timezone,
      now,
    }),
  };
}
