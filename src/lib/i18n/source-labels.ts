/**
 * One place that says which i18n key labels which provenance enum member.
 *
 * Three surfaces render a source to the user and each one carried its own
 * copy of the map: Settings → Sources, the sleep discrepancy tooltip, and
 * the measurement list (filter dropdown + table badge). Every copy was
 * written when the enum was shorter, and every copy fell through to the raw
 * SCREAMING_SNAKE value for the providers added afterwards — the settings
 * ladder listed `GOOGLE_HEALTH`, `OURA`, `POLAR` and `STRAVA` verbatim.
 *
 * The maps live here so a new provider is one edit, and they are keyed by
 * the enum itself so the edit is not optional: leaving a member out is a
 * type error, and `measurement-source-label-coverage.test.ts` proves the
 * keys resolve in the message bundle.
 */
import { measurementSourceEnum } from "@/lib/validations/measurement";

export type MeasurementSourceValue =
  (typeof measurementSourceEnum.options)[number];

/**
 * Settings → Sources ("Source priority by metric") and the sleep
 * source-discrepancy tooltip. Reads as a provenance name: "Manual entry",
 * "Computed", and the provider's own brand spelling for everything else.
 */
export const MEASUREMENT_SOURCE_SETTINGS_LABEL_KEYS: Record<
  MeasurementSourceValue,
  string
> = {
  WITHINGS: "settings.sections.sources.sourceLabels.WITHINGS",
  APPLE_HEALTH: "settings.sections.sources.sourceLabels.APPLE_HEALTH",
  MANUAL: "settings.sections.sources.sourceLabels.MANUAL",
  IMPORT: "settings.sections.sources.sourceLabels.IMPORT",
  WHOOP: "settings.sections.sources.sourceLabels.WHOOP",
  COMPUTED: "settings.sections.sources.sourceLabels.COMPUTED",
  FITBIT: "settings.sections.sources.sourceLabels.FITBIT",
  NIGHTSCOUT: "settings.sections.sources.sourceLabels.NIGHTSCOUT",
  POLAR: "settings.sections.sources.sourceLabels.POLAR",
  OURA: "settings.sections.sources.sourceLabels.OURA",
  TELEGRAM: "settings.sections.sources.sourceLabels.TELEGRAM",
  MCP: "settings.sections.sources.sourceLabels.MCP",
  GOOGLE_HEALTH: "settings.sections.sources.sourceLabels.GOOGLE_HEALTH",
  STRAVA: "settings.sections.sources.sourceLabels.STRAVA",
  // v1.38.x — readings pushed in under a `measurements:write` token.
  // Never offered in the ladder (it is on no default priority list), but
  // the map is keyed by the enum, so the entry is not optional.
  EXTERNAL: "settings.sections.sources.sourceLabels.EXTERNAL",
};

/**
 * The measurement list — the source facet in the filter rail and the badge
 * in the table's source column. Its own catalogue because the badge column
 * is narrow: "Manual" where the settings ladder says "Manual entry".
 */
export const MEASUREMENT_SOURCE_LIST_LABEL_KEYS: Record<
  MeasurementSourceValue,
  string
> = {
  MANUAL: "measurements.sourceManual",
  WITHINGS: "measurements.sourceWithings",
  IMPORT: "measurements.sourceImport",
  APPLE_HEALTH: "measurements.sourceAppleHealth",
  COMPUTED: "measurements.sourceComputed",
  WHOOP: "measurements.sourceWhoop",
  FITBIT: "measurements.sourceFitbit",
  NIGHTSCOUT: "measurements.sourceNightscout",
  POLAR: "measurements.sourcePolar",
  OURA: "measurements.sourceOura",
  TELEGRAM: "measurements.sourceTelegram",
  MCP: "measurements.sourceMcp",
  GOOGLE_HEALTH: "measurements.sourceGoogleHealth",
  STRAVA: "measurements.sourceStrava",
  EXTERNAL: "measurements.sourceExternal",
};

/**
 * `IntakeSource` — where a medication intake was logged. Not a Zod enum
 * anywhere (the write surfaces validate against narrower literals), so the
 * member list is written out and pinned against `prisma/schema.prisma` by
 * the coverage guard.
 */
export const INTAKE_SOURCE_VALUES = [
  "WEB",
  "API",
  "REMINDER",
  "IMPORT",
  "APPLE_HEALTH",
] as const;

export type IntakeSourceValue = (typeof INTAKE_SOURCE_VALUES)[number];

/** The "via {origin}" caption on a medication intake row. */
export const INTAKE_SOURCE_LABEL_KEYS: Record<IntakeSourceValue, string> = {
  WEB: "medications.sourceWeb",
  API: "medications.sourceApi",
  REMINDER: "medications.sourceReminder",
  IMPORT: "medications.sourceImport",
  APPLE_HEALTH: "medications.sourceAppleHealth",
};
