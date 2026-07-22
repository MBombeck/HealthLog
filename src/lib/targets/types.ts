import type {
  GlucoseContext,
  MeasurementType,
} from "@/generated/prisma/client";
import type { SleepStageRow } from "@/lib/analytics/sleep-night";
import type {
  ComplianceSchedule,
  IntakeEvent,
  MedicationPauseEraLike,
} from "@/lib/analytics/compliance";
import type { ScheduleRevisionLike } from "@/lib/medications/scheduling/schedule-eras";
import type { ThresholdOverridesJson } from "@/lib/analytics/effective-range";

export type TargetTrend = "up" | "down" | "stable" | null;
export type DayBand = "in" | "near" | "out";

export interface TargetConsistency {
  daysInRange7d: number;
  daysLogged7d: number;
  daysInRange30d: number;
  daysLogged30d: number;
  lastMetGoalAt: string | null;
  streakDays: number;
  insufficientData: boolean;
  consistency7d: ReadonlyArray<DayBand | null>;
}

export interface TargetItem extends TargetConsistency {
  type: string;
  label: string;
  current: number | null;
  average30: number | null;
  trend: TargetTrend;
  unit: string;
  range: { min: number; max: number } | null;
  classification: { category: string; color: string } | null;
  source: string;
  details?: {
    medications?: Array<{
      name: string;
      compliance7: number;
      compliance30: number;
    }>;
  };
}

export interface TargetPageSummary {
  targetsMetThisWeek: number;
  totalTargets: number;
  streakHighlight: { metric: string; days: number } | null;
}

export interface TargetMeasurement {
  type: MeasurementType;
  value: number;
  measuredAt: Date;
}

export type TargetValueByType = Partial<Record<MeasurementType, number | null>>;

export interface TargetMedication {
  id: string;
  name: string;
  createdAt: Date;
  startsOn: Date | null;
  endsOn: Date | null;
  oneShot: boolean;
  schedules: ComplianceSchedule[];
  scheduleRevisions?: ScheduleRevisionLike[];
  pauseEras?: MedicationPauseEraLike[];
}

export interface TargetIntakeEvent extends IntakeEvent {
  medicationId: string;
}

export interface TargetMoodRollup {
  bucketStart: Date;
  count: number;
  mean: number;
}

export interface TargetMoodEntry {
  score: number;
  moodLoggedAt: Date;
}

export interface TargetGlucoseRow {
  value: number;
  measuredAt: Date;
  glucoseContext: GlucoseContext | null;
}

export interface TargetProfile {
  heightCm: number | null;
  dateOfBirth: Date | null;
  gender: string | null;
  glucoseUnit: string | null;
  hasDiabetes: boolean;
  thresholdsJson: ThresholdOverridesJson | null;
}

export type TargetSleepStageRow = SleepStageRow;
