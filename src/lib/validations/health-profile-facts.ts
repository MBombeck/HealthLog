import { z } from "zod/v4";
import { isoDateTime } from "@/lib/validations/datetime";
import { ownValue } from "@/lib/own-key";

export const HEALTH_PROFILE_AI_SECTIONS = [
  "ABOUT_ME",
  "CONDITIONS",
  "ALLERGIES",
  "COACH_FOCUS",
  "FAMILY_HISTORY",
  "SMOKING_STATUS",
  "ALCOHOL_PATTERN",
  "SHIFT_SCHEDULE",
] as const;

export type HealthProfileAiSection =
  (typeof HEALTH_PROFILE_AI_SECTIONS)[number];

export const DEFAULT_HEALTH_PROFILE_AI_SECTIONS = [
  "ABOUT_ME",
  "CONDITIONS",
  "ALLERGIES",
  "COACH_FOCUS",
  "FAMILY_HISTORY",
  "SMOKING_STATUS",
  "ALCOHOL_PATTERN",
  "SHIFT_SCHEDULE",
] as const satisfies readonly HealthProfileAiSection[];

export const healthProfileAiSectionSchema = z.enum(HEALTH_PROFILE_AI_SECTIONS);

/**
 * Every value the `ai_included_sections` column can hold: the eight above and
 * the four life-circumstance sections (v1.43, #614). The eight-value schema is
 * the wire form of `/api/coach/about-me`, which older app builds decode
 * closed; this one is for the places that carry the column as stored, the
 * backup file first among them, where dropping a value would silently take an
 * opt-in back on restore.
 */
export const STORED_HEALTH_PROFILE_AI_SECTIONS = [
  ...HEALTH_PROFILE_AI_SECTIONS,
  "ACTIVITY",
  "WORK",
  "HABITS",
  "GOALS",
] as const;
export type StoredHealthProfileAiSection =
  (typeof STORED_HEALTH_PROFILE_AI_SECTIONS)[number];
export const storedHealthProfileAiSectionSchema = z.enum(
  STORED_HEALTH_PROFILE_AI_SECTIONS,
);

/** Narrow a stored section list to the eight the about-me wire carries. */
export function aboutMeAiSections(
  stored: readonly string[],
): HealthProfileAiSection[] {
  return stored.filter((section): section is HealthProfileAiSection =>
    (HEALTH_PROFILE_AI_SECTIONS as readonly string[]).includes(section),
  );
}

export const SMOKING_STATUS_VALUES = ["NEVER", "FORMER", "CURRENT"] as const;
export const ALCOHOL_PATTERN_VALUES = [
  "NONE",
  "OCCASIONAL",
  "WEEKLY",
  "MOST_DAYS",
] as const;
export const SHIFT_SCHEDULE_VALUES = [
  "NONE",
  "FIXED_SHIFT",
  "ROTATING",
] as const;

export const HEALTH_PROFILE_FACT_KINDS = [
  "SMOKING_STATUS",
  "ALCOHOL_PATTERN",
  "SHIFT_SCHEDULE",
] as const;

export type HealthProfileFactKind = (typeof HEALTH_PROFILE_FACT_KINDS)[number];
export type SmokingStatusValue = (typeof SMOKING_STATUS_VALUES)[number];
export type AlcoholPatternValue = (typeof ALCOHOL_PATTERN_VALUES)[number];
export type ShiftScheduleValue = (typeof SHIFT_SCHEDULE_VALUES)[number];
export type HealthProfileFactValue =
  SmokingStatusValue | AlcoholPatternValue | ShiftScheduleValue;
export const HEALTH_PROFILE_FACT_VALUES: Record<
  HealthProfileFactKind,
  Readonly<Record<string, true>>
> = {
  SMOKING_STATUS: { NEVER: true, FORMER: true, CURRENT: true },
  ALCOHOL_PATTERN: {
    NONE: true,
    OCCASIONAL: true,
    WEEKLY: true,
    MOST_DAYS: true,
  },
  SHIFT_SCHEDULE: { NONE: true, FIXED_SHIFT: true, ROTATING: true },
};
export const healthProfileFactKindSchema = z.enum(HEALTH_PROFILE_FACT_KINDS);

export function isHealthProfileFactValue(
  kind: HealthProfileFactKind,
  value: string,
): value is HealthProfileFactValue {
  return ownValue(HEALTH_PROFILE_FACT_VALUES[kind], value) === true;
}

export function validateCorrectedFactValue(
  kind: HealthProfileFactKind,
  value: string,
): HealthProfileFactValue | null {
  return isHealthProfileFactValue(kind, value) ? value : null;
}

export const healthProfileFactDtoSchema = z.object({
  id: z.string(),
  kind: healthProfileFactKindSchema,
  value: z.string().nullable(),
  unreadable: z.boolean(),
  validFrom: isoDateTime(),
  validUntil: isoDateTime().nullable(),
  provenance: z.enum(["USER_REPORTED", "USER_CORRECTION"]),
  supersededByRevisionId: z.string().nullable(),
  createdAt: isoDateTime(),
});

export const healthProfileFactsResponseSchema = z.object({
  current: z.object({
    SMOKING_STATUS: healthProfileFactDtoSchema.nullable(),
    ALCOHOL_PATTERN: healthProfileFactDtoSchema.nullable(),
    SHIFT_SCHEDULE: healthProfileFactDtoSchema.nullable(),
  }),
  history: z.array(healthProfileFactDtoSchema),
});
