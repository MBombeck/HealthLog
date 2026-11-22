/**
 * HealthKit reproductive-category → CycleDayLog / CycleProfile mapping.
 *
 * The single source of truth for how an Apple Health reproductive sample
 * folds into HealthLog's cycle model. Both the `export.xml` streaming
 * importer (`src/lib/measurements/import-apple-health-export.ts`) and the
 * iOS batch contract reference this table; the canonical key tables also
 * live in `docs/api/cycle-healthkit-mapping.md` so a self-hoster reading
 * the importer and a developer reading the docs see one mapping.
 *
 * Routing rules (per `.planning/v1.15-cycle/ios-contract.md` §5):
 *   - MenstrualFlow / IntermenstrualBleeding / CervicalMucusQuality /
 *     OvulationTestResult / SexualActivity / Pregnancy/Progesterone test
 *     results → fields on a `CycleDayLog` (the day-log write helper), NOT
 *     `Measurement`.
 *   - Pregnancy / Lactation STATUS → the `CycleProfile` pregnancy state
 *     (`pregnancy-import.ts`); Contraceptive STATUS → the goal
 *     nudge. NOT day-logs.
 *   - Symptom category types → seeded `CycleSymptom` keys via the
 *     `CycleSymptomLink` join.
 *   - BBT (`basalBodyTemperature`) stays a `Measurement(BODY_TEMPERATURE)`
 *     AND mirrors `CycleDayLog.basalBodyTempC`; it is NOT routed here (it
 *     is a quantity sample handled by the measurement mapping + the cycle
 *     day-log mirror).
 *   - BleedingDuringPregnancy / BleedingAfterPregnancy stay unmapped. The
 *     pregnancy state is set by the owner, or from the pregnancy and
 *     lactation status samples (`pregnancy-import.ts`); bleeding in or after
 *     a pregnancy is not a period and must not start a cycle, and the day
 *     log has no field of its own for it.
 *
 * Apple's `export.xml` writes a category sample's `value` as the symbolic
 * `HKCategoryValue…` name; the live HealthKit API uses the integer
 * codepoint. Every lookup table below is keyed by BOTH so the importer and
 * the batch ingest resolve a sample regardless of which form it carries.
 */
import type {
  FlowLevel,
  OvulationTest,
  CervicalMucus,
  HomeTestResult,
  ContraceptiveKind,
} from "@/generated/prisma/client";

/* ── HK identifier constants ─────────────────────────────────────── */

export const HK_MENSTRUAL_FLOW = "HKCategoryTypeIdentifierMenstrualFlow";
export const HK_INTERMENSTRUAL_BLEEDING =
  "HKCategoryTypeIdentifierIntermenstrualBleeding";
export const HK_CERVICAL_MUCUS = "HKCategoryTypeIdentifierCervicalMucusQuality";
export const HK_OVULATION_TEST = "HKCategoryTypeIdentifierOvulationTestResult";
export const HK_SEXUAL_ACTIVITY = "HKCategoryTypeIdentifierSexualActivity";
export const HK_PREGNANCY_TEST = "HKCategoryTypeIdentifierPregnancyTestResult";
export const HK_PROGESTERONE_TEST =
  "HKCategoryTypeIdentifierProgesteroneTestResult";
export const HK_CONTRACEPTIVE = "HKCategoryTypeIdentifierContraceptive";
export const HK_PREGNANCY = "HKCategoryTypeIdentifierPregnancy";
export const HK_LACTATION = "HKCategoryTypeIdentifierLactation";

/**
 * The HealthKit metadata key carrying the protection-used boolean on a
 * SexualActivity sample. Apple writes it as a `<MetadataEntry>` child with
 * a `"0"`/`"1"` (or `"true"`/`"false"`) value.
 */
export const HK_SEXUAL_ACTIVITY_PROTECTION_META =
  "HKMetadataKeySexualActivityProtectionUsed";

/* ── category-value lookup tables (symbolic name + integer) ──────── */

/**
 * HKCategoryValueMenstrualFlow: unspecified(1)/light(2)/medium(3)/heavy(4)/
 * none(5). HK `unspecified` maps to LIGHT as the conservative boundary
 * (a logged-but-unspecified bleeding day is at least light flow); HK
 * `none` maps to our NONE. Documented with iOS in the spotting boundary
 * note — HealthLog's SPOTTING has no HK counterpart, so it is only ever
 * produced by a manual MANUAL-source entry.
 */
export const HK_MENSTRUAL_FLOW_VALUES: Record<string, FlowLevel> = {
  "1": "LIGHT", // HKCategoryValueMenstrualFlowUnspecified
  HKCategoryValueMenstrualFlowUnspecified: "LIGHT",
  "2": "LIGHT", // HKCategoryValueMenstrualFlowLight
  HKCategoryValueMenstrualFlowLight: "LIGHT",
  "3": "MEDIUM", // HKCategoryValueMenstrualFlowMedium
  HKCategoryValueMenstrualFlowMedium: "MEDIUM",
  "4": "HEAVY", // HKCategoryValueMenstrualFlowHeavy
  HKCategoryValueMenstrualFlowHeavy: "HEAVY",
  "5": "NONE", // HKCategoryValueMenstrualFlowNone
  HKCategoryValueMenstrualFlowNone: "NONE",
};

/**
 * HKCategoryValueOvulationTestResult: negative(1)/luteinizingHormoneSurge(2)/
 * indeterminate(3)/estrogenSurge(4).
 */
export const HK_OVULATION_TEST_VALUES: Record<string, OvulationTest> = {
  "1": "NEGATIVE",
  HKCategoryValueOvulationTestResultNegative: "NEGATIVE",
  "2": "POSITIVE_LH_SURGE",
  HKCategoryValueOvulationTestResultLuteinizingHormoneSurge:
    "POSITIVE_LH_SURGE",
  "3": "INDETERMINATE",
  HKCategoryValueOvulationTestResultIndeterminate: "INDETERMINATE",
  "4": "ESTROGEN_SURGE",
  HKCategoryValueOvulationTestResultEstrogenSurge: "ESTROGEN_SURGE",
};

/**
 * HKCategoryValueCervicalMucusQuality: dry(1)/sticky(2)/creamy(3)/watery(4)/
 * eggWhite(5).
 */
export const HK_CERVICAL_MUCUS_VALUES: Record<string, CervicalMucus> = {
  "1": "DRY",
  HKCategoryValueCervicalMucusQualityDry: "DRY",
  "2": "STICKY",
  HKCategoryValueCervicalMucusQualitySticky: "STICKY",
  "3": "CREAMY",
  HKCategoryValueCervicalMucusQualityCreamy: "CREAMY",
  "4": "WATERY",
  HKCategoryValueCervicalMucusQualityWatery: "WATERY",
  "5": "EGG_WHITE",
  HKCategoryValueCervicalMucusQualityEggWhite: "EGG_WHITE",
};

/**
 * Shared home-test result enum for the pregnancy- and progesterone-test
 * category types: negative(1)/positive(2)/indeterminate(3).
 */
export const HK_HOME_TEST_VALUES: Record<string, HomeTestResult> = {
  "1": "NEGATIVE",
  HKCategoryValuePregnancyTestResultNegative: "NEGATIVE",
  HKCategoryValueProgesteroneTestResultNegative: "NEGATIVE",
  "2": "POSITIVE",
  HKCategoryValuePregnancyTestResultPositive: "POSITIVE",
  HKCategoryValueProgesteroneTestResultPositive: "POSITIVE",
  "3": "INDETERMINATE",
  HKCategoryValuePregnancyTestResultIndeterminate: "INDETERMINATE",
  HKCategoryValueProgesteroneTestResultIndeterminate: "INDETERMINATE",
};

/**
 * HKCategoryValueContraceptive: unspecified(1)/implant(2)/injection(3)/
 * intrauterineDevice(4)/intravaginalRing(5)/oral(6)/patch(7)/emergency(8).
 * Routed to the CycleProfile contraception flag (status), but a same-day
 * contraceptive sample also lands on the day-log `contraceptive` field so
 * the timeline shows the method that was active.
 */
export const HK_CONTRACEPTIVE_VALUES: Record<string, ContraceptiveKind> = {
  "1": "UNSPECIFIED",
  HKCategoryValueContraceptiveUnspecified: "UNSPECIFIED",
  "2": "IMPLANT",
  HKCategoryValueContraceptiveImplant: "IMPLANT",
  "3": "INJECTION",
  HKCategoryValueContraceptiveInjection: "INJECTION",
  "4": "IUD",
  HKCategoryValueContraceptiveIntrauterineDevice: "IUD",
  "5": "INTRAVAGINAL_RING",
  HKCategoryValueContraceptiveIntravaginalRing: "INTRAVAGINAL_RING",
  "6": "ORAL",
  HKCategoryValueContraceptiveOral: "ORAL",
  "7": "PATCH",
  HKCategoryValueContraceptivePatch: "PATCH",
  "8": "EMERGENCY",
  HKCategoryValueContraceptiveEmergency: "EMERGENCY",
};

/**
 * Symptom category types → seeded `CycleSymptom.key` (the catalogue keys
 * from migration 0129). One HK identifier per canonical symptom key; the
 * symptom severity (none/mild/moderate/severe) is carried on the link's
 * severity in the batch contract but the seeded catalogue join is
 * key-only, so severity is dropped on the XML import path (the symptom is
 * still recorded). Identifiers without a seeded counterpart are omitted —
 * they fall through to the importer's `deferred` tally rather than
 * inventing a catalogue row.
 */
export const HK_SYMPTOM_KEY_BY_IDENTIFIER: Record<string, string> = {
  HKCategoryTypeIdentifierAbdominalCramps: "cramps",
  HKCategoryTypeIdentifierHeadache: "headache",
  HKCategoryTypeIdentifierBloating: "bloating",
  HKCategoryTypeIdentifierAcne: "acne",
  HKCategoryTypeIdentifierBreastPain: "breast_tenderness",
  HKCategoryTypeIdentifierFatigue: "fatigue",
  HKCategoryTypeIdentifierLowerBackPain: "back_pain",
  HKCategoryTypeIdentifierSleepChanges: "insomnia",
  HKCategoryTypeIdentifierMoodChanges: "mood_swings",
  HKCategoryTypeIdentifierAppetiteChanges: "food_cravings",
  HKCategoryTypeIdentifierNausea: "nausea",
};

/**
 * HK severity codepoints for a symptom category sample:
 * notPresent(1)/present(2)/mild(3)/moderate(4)/severe(5). A `notPresent`
 * sample is an explicit "I did not have this" record — it must NOT create
 * a symptom link. Returns true when the sample asserts the symptom.
 */
export function hkSymptomIsPresent(rawValue: string | undefined): boolean {
  if (rawValue === undefined) return true; // sample present, no severity
  if (
    rawValue === "1" ||
    rawValue === "HKCategoryValueSeverityNotPresent" ||
    rawValue === "HKCategoryValuePresenceNotPresent"
  ) {
    return false;
  }
  return true;
}

/* ── routed-output shape ─────────────────────────────────────────── */

/** Partial CycleDayLog field set a single HK reproductive sample fills. */
export interface CycleDayLogFields {
  flow?: FlowLevel;
  intermenstrualBleeding?: boolean;
  ovulationTest?: OvulationTest;
  cervicalMucus?: CervicalMucus;
  sexualActivity?: boolean;
  protectedSex?: boolean | null;
  pregnancyTest?: HomeTestResult;
  progesteroneTest?: HomeTestResult;
  contraceptive?: ContraceptiveKind;
  /** Seeded symptom catalogue key to link on the day. */
  symptomKey?: string;
}

/**
 * CycleProfile status fields a HK STATUS sample updates. The v1.15.0
 * `CycleProfile` schema carries no dedicated pregnant/lactating columns
 * (pregnancy-mode is a deferred release), so the only profile signal a
 * status sample can land today is a goal nudge: an active contraceptive
 * method nudges the goal toward AVOID_PREGNANCY. The nudge is conservative
 * — the importer only applies it when the profile is still on its
 * GENERAL_HEALTH default, never clobbering an explicit user choice.
 */
export interface CycleProfileFields {
  /**
   * The contraceptive method the sample asserts, also written to the
   * day-log `contraceptive` field for the timeline. Drives the goal nudge.
   */
  contraceptive?: ContraceptiveKind;
}

export type HkCycleRoute =
  /** Fold the fields into the day's `CycleDayLog` (the common case). */
  | { kind: "day-log"; fields: CycleDayLogFields }
  /**
   * A contraceptive STATUS sample: record the method on the day-log AND
   * nudge the CycleProfile goal. Carries both payloads so the importer
   * applies them in one pass.
   */
  | {
      kind: "day-log+profile";
      fields: CycleDayLogFields;
      profile: CycleProfileFields;
    }
  /** No cycle destination (unrecognised value, or deferred pregnancy-mode). */
  | { kind: "skip" };

/** Every HK identifier this module routes (status + day-log + symptoms). */
export const HK_CYCLE_IDENTIFIERS: ReadonlySet<string> = new Set<string>([
  HK_MENSTRUAL_FLOW,
  HK_INTERMENSTRUAL_BLEEDING,
  HK_CERVICAL_MUCUS,
  HK_OVULATION_TEST,
  HK_SEXUAL_ACTIVITY,
  HK_PREGNANCY_TEST,
  HK_PROGESTERONE_TEST,
  HK_CONTRACEPTIVE,
  ...Object.keys(HK_SYMPTOM_KEY_BY_IDENTIFIER),
]);

/** Does this module own the inbound identifier? */
export function isCycleHkIdentifier(hkIdentifier: string): boolean {
  return HK_CYCLE_IDENTIFIERS.has(hkIdentifier);
}

/**
 * Map one inbound HK reproductive sample to its cycle destination.
 *
 * @param hkIdentifier the `HKCategoryTypeIdentifier…` string.
 * @param rawValue the sample's `value` attribute (symbolic name OR integer
 *   codepoint as a string), `undefined` for a presence-only sample.
 * @param protectionUsed resolved `HKMetadataKeySexualActivityProtectionUsed`
 *   metadata for a SexualActivity sample (`undefined` when absent).
 * @returns a routed destination, or `{ kind: "skip" }` when the value is
 *   unrecognised or the identifier carries no cycle meaning.
 */
export function mapHkCycleSample(
  hkIdentifier: string,
  rawValue: string | undefined,
  protectionUsed?: boolean,
): HkCycleRoute {
  // Symptom category types → catalogue key (skip an explicit not-present).
  const symptomKey = HK_SYMPTOM_KEY_BY_IDENTIFIER[hkIdentifier];
  if (symptomKey) {
    if (!hkSymptomIsPresent(rawValue)) return { kind: "skip" };
    return { kind: "day-log", fields: { symptomKey } };
  }

  switch (hkIdentifier) {
    case HK_MENSTRUAL_FLOW: {
      const flow = rawValue ? HK_MENSTRUAL_FLOW_VALUES[rawValue] : undefined;
      if (!flow) return { kind: "skip" };
      return { kind: "day-log", fields: { flow } };
    }
    case HK_INTERMENSTRUAL_BLEEDING:
      // A present sample asserts spotting outside the period window.
      return { kind: "day-log", fields: { intermenstrualBleeding: true } };
    case HK_CERVICAL_MUCUS: {
      const cervicalMucus = rawValue
        ? HK_CERVICAL_MUCUS_VALUES[rawValue]
        : undefined;
      if (!cervicalMucus) return { kind: "skip" };
      return { kind: "day-log", fields: { cervicalMucus } };
    }
    case HK_OVULATION_TEST: {
      const ovulationTest = rawValue
        ? HK_OVULATION_TEST_VALUES[rawValue]
        : undefined;
      if (!ovulationTest) return { kind: "skip" };
      return { kind: "day-log", fields: { ovulationTest } };
    }
    case HK_SEXUAL_ACTIVITY:
      return {
        kind: "day-log",
        fields: {
          sexualActivity: true,
          protectedSex: protectionUsed === undefined ? null : protectionUsed,
        },
      };
    case HK_PREGNANCY_TEST: {
      const pregnancyTest = rawValue
        ? HK_HOME_TEST_VALUES[rawValue]
        : undefined;
      if (!pregnancyTest) return { kind: "skip" };
      return { kind: "day-log", fields: { pregnancyTest } };
    }
    case HK_PROGESTERONE_TEST: {
      const progesteroneTest = rawValue
        ? HK_HOME_TEST_VALUES[rawValue]
        : undefined;
      if (!progesteroneTest) return { kind: "skip" };
      return { kind: "day-log", fields: { progesteroneTest } };
    }
    case HK_CONTRACEPTIVE: {
      const contraceptive = rawValue
        ? HK_CONTRACEPTIVE_VALUES[rawValue]
        : undefined;
      if (!contraceptive) return { kind: "skip" };
      // Record the method on the day-log timeline AND nudge the profile
      // goal toward AVOID_PREGNANCY (the importer applies the nudge only
      // when the goal is still on its GENERAL_HEALTH default).
      return {
        kind: "day-log+profile",
        fields: { contraceptive },
        profile: { contraceptive },
      };
    }
    // HK_PREGNANCY / HK_LACTATION are status, not day logs: the importer
    // hands them to `CycleImportAccumulator.consumeStatus` before this
    // mapping runs (v1.49), so here they fall through to skip.
    default:
      return { kind: "skip" };
  }
}
