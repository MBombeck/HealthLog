/**
 * Built-in symptoms: the Apple Health symptom types the symptom batch accepts.
 *
 * Each code names one HealthKit category type
 * (`HKCategoryTypeIdentifier<suffix>`, all valued `HKCategoryValueSeverity`).
 * The first sample of a code creates the account's built-in definition for
 * it (`SymptomDefinition.code`), labelled in the person's language and given
 * the icon below; every later sample lands on the same row by code, whatever
 * the person renamed it to or whether they hid it.
 *
 * The eleven types the cycle day log also carries (headache, nausea, ...) are
 * here too, so someone who does not track a cycle still sees a headache they
 * logged in Apple Health. A code missing from this list is skipped
 * `unknown_code`, so the list can grow on the server first.
 *
 * Client-safe: no server imports, so the diary can name a built-in's code.
 */
import type { SymptomIconName } from "./shared";

export interface SymptomBuiltin {
  /** The HealthKit category type suffix, for documentation and the app. */
  hkSuffix: string;
  icon: SymptomIconName;
}

export const SYMPTOM_BUILTINS = {
  ABDOMINAL_CRAMPS: { hkSuffix: "AbdominalCramps", icon: "Zap" },
  ACNE: { hkSuffix: "Acne", icon: "CircleDot" },
  APPETITE_CHANGES: { hkSuffix: "AppetiteChanges", icon: "Cookie" },
  BLADDER_INCONTINENCE: { hkSuffix: "BladderIncontinence", icon: "Droplet" },
  BLOATING: { hkSuffix: "Bloating", icon: "CircleDot" },
  BREAST_PAIN: { hkSuffix: "BreastPain", icon: "Heart" },
  CHEST_TIGHTNESS_OR_PAIN: { hkSuffix: "ChestTightnessOrPain", icon: "Heart" },
  CHILLS: { hkSuffix: "Chills", icon: "Snowflake" },
  CONSTIPATION: { hkSuffix: "Constipation", icon: "Soup" },
  COUGHING: { hkSuffix: "Coughing", icon: "Stethoscope" },
  DIARRHEA: { hkSuffix: "Diarrhea", icon: "Soup" },
  DIZZINESS: { hkSuffix: "Dizziness", icon: "Brain" },
  DRY_SKIN: { hkSuffix: "DrySkin", icon: "Droplet" },
  FAINTING: { hkSuffix: "Fainting", icon: "PersonStanding" },
  FATIGUE: { hkSuffix: "Fatigue", icon: "BatteryLow" },
  FEVER: { hkSuffix: "Fever", icon: "Thermometer" },
  GENERALIZED_BODY_ACHE: {
    hkSuffix: "GeneralizedBodyAche",
    icon: "PersonStanding",
  },
  HAIR_LOSS: { hkSuffix: "HairLoss", icon: "Tag" },
  HEADACHE: { hkSuffix: "Headache", icon: "Brain" },
  HEARTBURN: { hkSuffix: "Heartburn", icon: "Flame" },
  HOT_FLASHES: { hkSuffix: "HotFlashes", icon: "Flame" },
  LOSS_OF_SMELL: { hkSuffix: "LossOfSmell", icon: "CircleDot" },
  LOSS_OF_TASTE: { hkSuffix: "LossOfTaste", icon: "Cookie" },
  LOWER_BACK_PAIN: { hkSuffix: "LowerBackPain", icon: "PersonStanding" },
  MEMORY_LAPSE: { hkSuffix: "MemoryLapse", icon: "Brain" },
  MOOD_CHANGES: { hkSuffix: "MoodChanges", icon: "Drama" },
  NAUSEA: { hkSuffix: "Nausea", icon: "Frown" },
  NIGHT_SWEATS: { hkSuffix: "NightSweats", icon: "MoonStar" },
  PELVIC_PAIN: { hkSuffix: "PelvicPain", icon: "CircleDot" },
  RAPID_POUNDING_OR_FLUTTERING_HEARTBEAT: {
    hkSuffix: "RapidPoundingOrFlutteringHeartbeat",
    icon: "HeartPulse",
  },
  RUNNY_NOSE: { hkSuffix: "RunnyNose", icon: "Droplet" },
  SHORTNESS_OF_BREATH: { hkSuffix: "ShortnessOfBreath", icon: "Activity" },
  SINUS_CONGESTION: { hkSuffix: "SinusCongestion", icon: "Stethoscope" },
  SKIPPED_HEARTBEAT: { hkSuffix: "SkippedHeartbeat", icon: "HeartPulse" },
  SLEEP_CHANGES: { hkSuffix: "SleepChanges", icon: "MoonStar" },
  SORE_THROAT: { hkSuffix: "SoreThroat", icon: "Frown" },
  VAGINAL_DRYNESS: { hkSuffix: "VaginalDryness", icon: "Droplet" },
  VOMITING: { hkSuffix: "Vomiting", icon: "Soup" },
  WHEEZING: { hkSuffix: "Wheezing", icon: "Activity" },
} as const satisfies Record<string, SymptomBuiltin>;

export type SymptomBuiltinCode = keyof typeof SYMPTOM_BUILTINS;

export const SYMPTOM_BUILTIN_CODES = Object.keys(
  SYMPTOM_BUILTINS,
) as SymptomBuiltinCode[];

export function isSymptomBuiltinCode(
  value: string,
): value is SymptomBuiltinCode {
  return Object.prototype.hasOwnProperty.call(SYMPTOM_BUILTINS, value);
}

/** The i18n key of a built-in's default label. */
export function symptomBuiltinLabelKey(code: SymptomBuiltinCode): string {
  return `symptoms.builtin.${code}`;
}
