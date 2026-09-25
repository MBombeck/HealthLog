/**
 * The doctor-report leaf catalogue: every piece of the record a user can
 * release or withhold, and the group it is presented under.
 *
 * A LEAF is the smallest releasable unit. There are exactly two kinds: every
 * `MeasurementType` enum member, and the structured sections of the report
 * payload that are not measurement series (identity, insurance, the glucose
 * panel, labs, the three medication blocks, GLP-1, allergies, illness
 * episodes, family history, mood, cycle).
 *
 * One catalogue drives the selection panel, the aggregator, the PDF, the
 * clinician share view and the guard tests, so a control can never again exist
 * without a gating path behind it, and a gate can never exist without a
 * control.
 *
 * Two of the three new-metric locks live here:
 *
 *   - `MEASUREMENT_LEAF_GROUP` is a `Record<MeasurementType, ReportGroupId>`.
 *     Adding an enum member without deciding its group fails `pnpm typecheck`,
 *     which runs in the pre-commit hook and in CI. The decision has to be made
 *     in the same commit as the enum member, and it has no effect on anyone's
 *     saved selection.
 *   - `STRUCTURED_LEAF_GROUP` does the same over the closed structured union.
 *
 * The third lock is set membership: a stored selection is a list of what was
 * chosen, so a leaf that did not exist when it was saved is not in it. See
 * `./selection.ts`.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import type { ModuleKey } from "@/lib/modules/registry";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/lib/measurements/type-label-keys";

/**
 * The structured (non-measurement) leaves. A closed union, so
 * `STRUCTURED_LEAF_GROUP` below is exhaustive by the compiler rather than by
 * review.
 */
export type StructuredLeafId =
  | "PATIENT_IDENTITY"
  | "EMERGENCY"
  | "INSURANCE"
  | "GLUCOSE_PANEL"
  | "LAB_RESULTS"
  | "MEDICATION_LIST"
  | "MEDICATION_ADMINISTRATIONS"
  | "MEDICATION_COMPLIANCE"
  | "GLP1_THERAPY"
  | "ALLERGIES"
  | "ILLNESS_EPISODES"
  | "VISITS"
  | "SURGICAL_HISTORY"
  | "IMMUNIZATIONS"
  | "FAMILY_HISTORY"
  | "MOOD"
  | "CYCLE"
  | "ANAMNESIS";

/** Every leaf id: the measurement types plus closed structured sections. */
export type ReportLeafId = MeasurementType | StructuredLeafId;

/** The presentation groups, in the order the panel and the PDF render them. */
export const REPORT_GROUP_ORDER = [
  "identity",
  "vitals",
  "cardio",
  "body",
  "sleepRecovery",
  "activity",
  "mobility",
  "environment",
  "glucose",
  "labs",
  "medications",
  "history",
  "sensitive",
] as const;

export type ReportGroupId = (typeof REPORT_GROUP_ORDER)[number];

/**
 * The fenced tier. It renders below a separator with no group checkbox, so no
 * single control can turn on more than one of these at a time, and it is never
 * in the shipped template. Mental-health screening totals, mood and cycle are
 * the user's own sensitive data; family history is third-party information
 * about people who consented to nothing.
 */
export const SENSITIVE_GROUP_ID = "sensitive" satisfies ReportGroupId;

/**
 * Measurement leaf → group. Exhaustive over the enum by construction.
 *
 * Two placements carry a stated reason. `PAIN_NRS` sits in vitals because pain
 * is read as a vital sign in every intake, not because it is a device reading.
 * The four screening totals are fenced because a depression or anxiety
 * instrument is not something to hand over as part of a bundle.
 */
export const MEASUREMENT_LEAF_GROUP: Record<MeasurementType, ReportGroupId> = {
  // ── vitals ──
  BLOOD_PRESSURE_SYS: "vitals",
  BLOOD_PRESSURE_DIA: "vitals",
  PULSE: "vitals",
  OXYGEN_SATURATION: "vitals",
  RESPIRATORY_RATE: "vitals",
  BODY_TEMPERATURE: "vitals",
  PAIN_NRS: "vitals",

  // ── cardio ──
  RESTING_HEART_RATE: "cardio",
  HEART_RATE_VARIABILITY: "cardio",
  HRV_RMSSD: "cardio",
  VO2_MAX: "cardio",
  WALKING_HEART_RATE_AVERAGE: "cardio",
  AVERAGE_HEART_RATE: "cardio",
  MAX_HEART_RATE: "cardio",
  CARDIO_RECOVERY: "cardio",
  CARDIO_LOAD: "cardio",
  PULSE_WAVE_VELOCITY: "cardio",
  VASCULAR_AGE: "cardio",
  IRREGULAR_RHYTHM_NOTIFICATION: "cardio",
  HIGH_HEART_RATE_EVENT: "cardio",
  LOW_HEART_RATE_EVENT: "cardio",

  // ── body ──
  WEIGHT: "body",
  BODY_MASS_INDEX: "body",
  BODY_FAT: "body",
  FAT_MASS: "body",
  FAT_FREE_MASS: "body",
  MUSCLE_MASS: "body",
  LEAN_BODY_MASS: "body",
  TOTAL_BODY_WATER: "body",
  BONE_MASS: "body",
  VISCERAL_FAT: "body",
  WAIST_CIRCUMFERENCE: "body",
  WAIST_TO_HEIGHT: "body",

  // ── sleep & recovery ──
  SLEEP_DURATION: "sleepRecovery",
  SLEEP_SCORE: "sleepRecovery",
  SLEEP_PERFORMANCE: "sleepRecovery",
  SLEEP_EFFICIENCY: "sleepRecovery",
  SLEEP_CONSISTENCY: "sleepRecovery",
  SLEEP_NEED: "sleepRecovery",
  SLEEP_DISTURBANCE_COUNT: "sleepRecovery",
  BREATHING_DISTURBANCES: "sleepRecovery",
  BREATHING_DISTURBANCE_EVENT: "sleepRecovery",
  RECOVERY_SCORE: "sleepRecovery",
  STRESS_SCORE: "sleepRecovery",
  RESILIENCE: "sleepRecovery",
  ANS_CHARGE: "sleepRecovery",
  SKIN_TEMPERATURE: "sleepRecovery",
  WRIST_TEMPERATURE: "sleepRecovery",
  BODY_TEMPERATURE_DEVIATION: "sleepRecovery",

  // ── activity ──
  ACTIVITY_STEPS: "activity",
  WALKING_RUNNING_DISTANCE: "activity",
  FLIGHTS_CLIMBED: "activity",
  ACTIVE_ENERGY_BURNED: "activity",
  ENERGY_EXPENDITURE_KJ: "activity",
  STRAIN_SCORE: "activity",
  DAY_STRAIN: "activity",
  WORKOUT_STRAIN: "activity",

  // ── mobility & gait ──
  WALKING_SPEED: "mobility",
  WALKING_ASYMMETRY: "mobility",
  WALKING_DOUBLE_SUPPORT: "mobility",
  WALKING_STEP_LENGTH: "mobility",
  WALKING_STEADINESS: "mobility",
  WALKING_STEADINESS_EVENT: "mobility",
  STAIR_ASCENT_SPEED: "mobility",
  STAIR_DESCENT_SPEED: "mobility",
  SIX_MINUTE_WALK_DISTANCE: "mobility",
  FALL_COUNT: "mobility",
  GRIP_STRENGTH: "mobility",

  // ── environment ──
  AUDIO_EXPOSURE_ENV: "environment",
  AUDIO_EXPOSURE_HEADPHONE: "environment",
  AUDIO_EXPOSURE_EVENT: "environment",
  TIME_IN_DAYLIGHT: "environment",

  // ── glucose ──
  BLOOD_GLUCOSE: "glucose",

  // ── fenced ──
  PHQ9_SCORE: "sensitive",
  GAD7_SCORE: "sensitive",
  WHO5_SCORE: "sensitive",
  SCI_SCORE: "sensitive",
};

/** Structured leaf → group. Exhaustive over the closed union. */
export const STRUCTURED_LEAF_GROUP: Record<StructuredLeafId, ReportGroupId> = {
  PATIENT_IDENTITY: "identity",
  EMERGENCY: "identity",
  INSURANCE: "identity",
  GLUCOSE_PANEL: "glucose",
  LAB_RESULTS: "labs",
  MEDICATION_LIST: "medications",
  MEDICATION_ADMINISTRATIONS: "medications",
  MEDICATION_COMPLIANCE: "medications",
  GLP1_THERAPY: "medications",
  ALLERGIES: "history",
  ILLNESS_EPISODES: "history",
  VISITS: "history",
  SURGICAL_HISTORY: "history",
  IMMUNIZATIONS: "history",
  FAMILY_HISTORY: "sensitive",
  MOOD: "sensitive",
  CYCLE: "sensitive",
  ANAMNESIS: "sensitive",
};

/** i18n label keys for the 18 structured leaves. */
export const STRUCTURED_LEAF_LABEL_KEYS: Record<StructuredLeafId, string> = {
  PATIENT_IDENTITY: "reportSelection.leafPatientIdentity",
  EMERGENCY: "reportSelection.leafEmergency",
  INSURANCE: "reportSelection.leafInsurance",
  GLUCOSE_PANEL: "reportSelection.leafGlucosePanel",
  LAB_RESULTS: "reportSelection.leafLabResults",
  MEDICATION_LIST: "reportSelection.leafMedicationList",
  MEDICATION_ADMINISTRATIONS: "reportSelection.leafMedicationAdministrations",
  MEDICATION_COMPLIANCE: "reportSelection.leafMedicationCompliance",
  GLP1_THERAPY: "reportSelection.leafGlp1Therapy",
  ALLERGIES: "reportSelection.leafAllergies",
  ILLNESS_EPISODES: "reportSelection.leafIllnessEpisodes",
  VISITS: "reportSelection.leafVisits",
  SURGICAL_HISTORY: "reportSelection.leafSurgicalHistory",
  IMMUNIZATIONS: "reportSelection.leafImmunizations",
  FAMILY_HISTORY: "reportSelection.leafFamilyHistory",
  MOOD: "reportSelection.leafMood",
  CYCLE: "reportSelection.leafCycle",
  ANAMNESIS: "reportSelection.leafAnamnesis",
};

/** i18n label keys for the groups, including the fenced tier's heading. */
export const REPORT_GROUP_LABEL_KEYS: Record<ReportGroupId, string> = {
  identity: "reportSelection.groupIdentity",
  vitals: "reportSelection.groupVitals",
  cardio: "reportSelection.groupCardio",
  body: "reportSelection.groupBody",
  sleepRecovery: "reportSelection.groupSleepRecovery",
  activity: "reportSelection.groupActivity",
  mobility: "reportSelection.groupMobility",
  environment: "reportSelection.groupEnvironment",
  glucose: "reportSelection.groupGlucose",
  labs: "reportSelection.groupLabs",
  medications: "reportSelection.groupMedications",
  history: "reportSelection.groupHistory",
  sensitive: "reportSelection.groupSensitive",
};

/**
 * v1.18.0 — leaf → owning module. The module map still ANDs over the
 * selection: a disabled module wins over a selected leaf, and a deselected
 * leaf wins over an enabled module. Neither softens the other.
 *
 * Core clinical leaves (blood pressure, weight, pulse, body composition,
 * identity) carry no module and are never gated here.
 */
export const LEAF_MODULE: Partial<Record<ReportLeafId, ModuleKey>> = {
  // Activity / movement series and the training-load scores.
  ACTIVITY_STEPS: "workouts",
  ACTIVE_ENERGY_BURNED: "workouts",
  ENERGY_EXPENDITURE_KJ: "workouts",
  FLIGHTS_CLIMBED: "workouts",
  WALKING_RUNNING_DISTANCE: "workouts",
  WALKING_SPEED: "workouts",
  WALKING_ASYMMETRY: "workouts",
  WALKING_STEP_LENGTH: "workouts",
  WALKING_DOUBLE_SUPPORT: "workouts",
  WALKING_STEADINESS: "workouts",
  WALKING_STEADINESS_EVENT: "workouts",
  SIX_MINUTE_WALK_DISTANCE: "workouts",
  STAIR_ASCENT_SPEED: "workouts",
  STAIR_DESCENT_SPEED: "workouts",
  STRAIN_SCORE: "workouts",
  DAY_STRAIN: "workouts",
  WORKOUT_STRAIN: "workouts",
  // Readiness signals.
  RECOVERY_SCORE: "recovery",
  STRESS_SCORE: "recovery",
  RESILIENCE: "recovery",
  ANS_CHARGE: "recovery",
  // Sleep.
  SLEEP_DURATION: "sleep",
  SLEEP_SCORE: "sleep",
  SLEEP_PERFORMANCE: "sleep",
  SLEEP_EFFICIENCY: "sleep",
  SLEEP_CONSISTENCY: "sleep",
  SLEEP_NEED: "sleep",
  SLEEP_DISTURBANCE_COUNT: "sleep",
  BREATHING_DISTURBANCES: "sleep",
  BREATHING_DISTURBANCE_EVENT: "sleep",
  // Environment exposure.
  AUDIO_EXPOSURE_ENV: "environment",
  AUDIO_EXPOSURE_HEADPHONE: "environment",
  AUDIO_EXPOSURE_EVENT: "environment",
  TIME_IN_DAYLIGHT: "environment",
  // Glucose: the raw series and the derived panel.
  BLOOD_GLUCOSE: "glucose",
  GLUCOSE_PANEL: "glucose",
  // The screening totals ride the mental-health module as well as being
  // fenced in the panel. Item-level answers are never a Measurement, so only
  // the total — the intended clinical artefact — can reach this path at all.
  PHQ9_SCORE: "mentalHealth",
  GAD7_SCORE: "mentalHealth",
  WHO5_SCORE: "mentalHealth",
  SCI_SCORE: "mentalHealth",
  // Structured sections with an owning module.
  LAB_RESULTS: "labs",
  MOOD: "mood",
  CYCLE: "cycle",
  ILLNESS_EPISODES: "illness",
  MEDICATION_LIST: "medications",
  MEDICATION_ADMINISTRATIONS: "medications",
  MEDICATION_COMPLIANCE: "medications",
  GLP1_THERAPY: "medications",
  // The immunization log is its own opt-out module: the leaf hides when the
  // `vaccinations` module is off, and the deselected leaf hides regardless of
  // the module — the two exclude independently, like `ILLNESS_EPISODES`.
  IMMUNIZATIONS: "vaccinations",
  // VISITS is deliberately absent, like ALLERGIES beside it. A visit carries
  // no module of its own — it is core, like the checkups page it lives on —
  // and the whole report is already gated by `doctorReport`. Reading the
  // absence as an oversight is the mistake this comment exists to prevent.
  // SURGICAL_HISTORY is absent for the same reason: a procedure is a visit.
};

/** Every measurement leaf id, in enum order. */
export const MEASUREMENT_LEAF_IDS = Object.keys(
  MEASUREMENT_LEAF_GROUP,
) as MeasurementType[];

/** Every structured leaf id. */
export const STRUCTURED_LEAF_IDS = Object.keys(
  STRUCTURED_LEAF_GROUP,
) as StructuredLeafId[];

/**
 * Every leaf id, grouped and ordered the way the panel renders them: group
 * order first, structured leaves before measurement leaves inside a group.
 * The PDF and the clinician view read the same order, so the panel is a table
 * of contents for the artefact.
 */
export const REPORT_GROUPS: ReadonlyArray<{
  id: ReportGroupId;
  labelKey: string;
  leaves: readonly ReportLeafId[];
}> = REPORT_GROUP_ORDER.map((id) => ({
  id,
  labelKey: REPORT_GROUP_LABEL_KEYS[id],
  leaves: [
    ...STRUCTURED_LEAF_IDS.filter((leaf) => STRUCTURED_LEAF_GROUP[leaf] === id),
    ...MEASUREMENT_LEAF_IDS.filter(
      (leaf) => MEASUREMENT_LEAF_GROUP[leaf] === id,
    ),
  ],
}));

/** The full ordered leaf list — the stable order a stored selection uses. */
export const ALL_LEAF_IDS: readonly ReportLeafId[] = REPORT_GROUPS.flatMap(
  (group) => group.leaves,
);

/**
 * The wire shape for `GET /api/meta/capabilities` `share.groups`: each group
 * carries its own member leaves, and the fenced tier carries `sensitive:
 * true`, derived from `SENSITIVE_GROUP_ID` rather than a second string
 * literal. A native client that cannot see group membership cannot mirror the
 * fence (no single control switching on more than one sensitive leaf), so
 * this — not `REPORT_GROUP_ORDER` alone — is what the endpoint should ship.
 *
 * Order matches `REPORT_GROUPS` exactly: group order is `REPORT_GROUP_ORDER`,
 * leaf order within a group is structured-then-measurement, so this shape and
 * the flat `ALL_LEAF_IDS` list agree leaf-for-leaf.
 */
export const SHARE_GROUPS: ReadonlyArray<{
  id: ReportGroupId;
  leaves: readonly ReportLeafId[];
  sensitive?: true;
}> = REPORT_GROUPS.map((group) => ({
  id: group.id,
  leaves: group.leaves,
  ...(group.id === SENSITIVE_GROUP_ID ? { sensitive: true as const } : {}),
}));

const ALL_LEAF_SET = new Set<string>(ALL_LEAF_IDS);

/** Whether a raw string is a leaf id this build knows. */
export function isReportLeafId(value: unknown): value is ReportLeafId {
  return typeof value === "string" && ALL_LEAF_SET.has(value);
}

const STRUCTURED_LEAF_SET = new Set<string>(STRUCTURED_LEAF_IDS);

/** Whether a leaf id is one of the structured sections. */
export function isStructuredLeafId(
  leaf: ReportLeafId,
): leaf is StructuredLeafId {
  return STRUCTURED_LEAF_SET.has(leaf);
}

/** The fenced leaves, as a set, for the template-purity guard and the panel. */
export const SENSITIVE_LEAF_IDS: readonly ReportLeafId[] = ALL_LEAF_IDS.filter(
  (leaf) =>
    isStructuredLeafId(leaf)
      ? STRUCTURED_LEAF_GROUP[leaf] === SENSITIVE_GROUP_ID
      : MEASUREMENT_LEAF_GROUP[leaf] === SENSITIVE_GROUP_ID,
);

/** The i18n label key for any leaf. */
export function leafLabelKey(leaf: ReportLeafId): string {
  return isStructuredLeafId(leaf)
    ? STRUCTURED_LEAF_LABEL_KEYS[leaf]
    : MEASUREMENT_TYPE_LABEL_KEYS[leaf];
}

/** The group a leaf belongs to. */
export function leafGroup(leaf: ReportLeafId): ReportGroupId {
  return isStructuredLeafId(leaf)
    ? STRUCTURED_LEAF_GROUP[leaf]
    : MEASUREMENT_LEAF_GROUP[leaf];
}
