/**
 * The option lists and label keys of the managed-record settings forms:
 * which Coach metrics and data clusters a guardian can exclude, and the
 * bundle key each option, insights section and threshold metric renders
 * with. Data only; the forms live in `managed-record/`.
 */
import type { InsightsSectionId } from "@/lib/insights-layout";
import type { ThresholdMetric } from "@/lib/analytics/effective-range";

export const COACH_EXCLUDE_METRICS = [
  "bp",
  "weight",
  "pulse",
  "mood",
  "compliance",
  "hrv",
  "sleep",
  "resting_hr",
  "steps",
  "medications",
  "anthropometrics",
] as const;
export const COACH_DATA_CLUSTERS = [
  "cardio",
  "body",
  "activity",
  "workouts",
  "sleep",
  "mood",
  "glucose",
  "medication",
  "mobility",
  "environment",
] as const;
export const COACH_EXCLUDE_METRIC_LABEL_KEYS: Record<
  (typeof COACH_EXCLUDE_METRICS)[number],
  string
> = {
  bp: "settings.sharedRecord.managedSettings.coach.metrics.bp",
  weight: "settings.sharedRecord.managedSettings.coach.metrics.weight",
  pulse: "settings.sharedRecord.managedSettings.coach.metrics.pulse",
  mood: "settings.sharedRecord.managedSettings.coach.metrics.mood",
  compliance: "settings.sharedRecord.managedSettings.coach.metrics.compliance",
  hrv: "settings.sharedRecord.managedSettings.coach.metrics.hrv",
  sleep: "settings.sharedRecord.managedSettings.coach.metrics.sleep",
  resting_hr: "settings.sharedRecord.managedSettings.coach.metrics.restingHr",
  steps: "settings.sharedRecord.managedSettings.coach.metrics.steps",
  medications:
    "settings.sharedRecord.managedSettings.coach.metrics.medications",
  anthropometrics:
    "settings.sharedRecord.managedSettings.coach.metrics.anthropometrics",
};
export const COACH_DATA_CLUSTER_LABEL_KEYS: Record<
  (typeof COACH_DATA_CLUSTERS)[number],
  string
> = {
  cardio: "settings.sharedRecord.managedSettings.coach.clusters.cardio",
  body: "settings.sharedRecord.managedSettings.coach.clusters.body",
  activity: "settings.sharedRecord.managedSettings.coach.clusters.activity",
  workouts: "settings.sharedRecord.managedSettings.coach.clusters.workouts",
  sleep: "settings.sharedRecord.managedSettings.coach.clusters.sleep",
  mood: "settings.sharedRecord.managedSettings.coach.clusters.mood",
  glucose: "settings.sharedRecord.managedSettings.coach.clusters.glucose",
  medication: "settings.sharedRecord.managedSettings.coach.clusters.medication",
  mobility: "settings.sharedRecord.managedSettings.coach.clusters.mobility",
  environment:
    "settings.sharedRecord.managedSettings.coach.clusters.environment",
};
export const INSIGHTS_SECTION_LABEL_KEYS: Record<InsightsSectionId, string> = {
  "wellness-scores":
    "settings.sharedRecord.managedSettings.insights.sectionLabels.wellnessScores",
  "daily-briefing":
    "settings.sharedRecord.managedSettings.insights.sectionLabels.dailyBriefing",
  vitals: "settings.sharedRecord.managedSettings.insights.sectionLabels.vitals",
  trends: "settings.sharedRecord.managedSettings.insights.sectionLabels.trends",
  "period-review":
    "settings.sharedRecord.managedSettings.insights.sectionLabels.periodReview",
  "cycle-summary":
    "settings.sharedRecord.managedSettings.insights.sectionLabels.cycleSummary",
  signals:
    "settings.sharedRecord.managedSettings.insights.sectionLabels.signals",
  "rhythm-events":
    "settings.sharedRecord.managedSettings.insights.sectionLabels.rhythmEvents",
  "health-status":
    "settings.sharedRecord.managedSettings.insights.sectionLabels.healthStatus",
  breathing:
    "settings.sharedRecord.managedSettings.insights.sectionLabels.breathing",
  "labs-changes":
    "settings.sharedRecord.managedSettings.insights.sectionLabels.labsChanges",
  ecg: "settings.sharedRecord.managedSettings.insights.sectionLabels.ecg",
};
export const METRIC_LABEL_KEYS: Record<ThresholdMetric, string> = {
  WEIGHT: "thresholds.metricWeight",
  BLOOD_PRESSURE_SYS: "thresholds.metricBpSys",
  BLOOD_PRESSURE_DIA: "thresholds.metricBpDia",
  PULSE: "thresholds.metricPulse",
  BODY_FAT: "thresholds.metricBodyFat",
  SLEEP_DURATION: "thresholds.metricSleep",
  ACTIVITY_STEPS: "thresholds.metricSteps",
  BLOOD_GLUCOSE_FASTING: "thresholds.metricGlucoseFasting",
  BLOOD_GLUCOSE_POSTPRANDIAL: "thresholds.metricGlucosePostprandial",
  BLOOD_GLUCOSE_RANDOM: "thresholds.metricGlucoseRandom",
  BLOOD_GLUCOSE_BEDTIME: "thresholds.metricGlucoseBedtime",
  TOTAL_BODY_WATER: "thresholds.metricBodyWater",
  BONE_MASS: "thresholds.metricBoneMass",
  OXYGEN_SATURATION: "thresholds.metricOxygenSaturation",
};
