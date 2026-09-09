import { z } from "zod/v4";

import {
  ACCEPTED_INSIGHTS_TILE_IDS,
  INSIGHTS_SECTION_IDS,
} from "@/lib/insights-layout";
import { MODULE_REGISTRY } from "@/lib/modules/registry";
import { coachPrefsSchema } from "@/lib/validations/coach-prefs";
import {
  modulePrefsPatchSchema,
  WRITABLE_MODULE_KEYS,
} from "@/lib/validations/modules";
import { thresholdsUpdateSchema } from "@/lib/validations/thresholds";

/**
 * The target-record configuration boundary. These literals are both the DTO
 * contract and the reviewable answer to which fields a Guardian may change.
 * Identity, credentials, delivery channels, memories, provider connections,
 * and every future field fail closed because no family accepts them.
 */
export const MANAGED_RECORD_SETTINGS_FIELD_ALLOWLIST = {
  profile: [
    "displayName",
    "heightCm",
    "dateOfBirth",
    "gender",
    "locale",
    "timezone",
    "unitPreference",
    "timeFormat",
    "dateFormat",
  ],
  modules: ["modulePreferences", "cycleTrackingEnabled"],
  notifications: ["moodReminderEnabled", "notificationPreferences"],
  thresholds: ["overrides"],
  coach: ["disableCoach", "preferences"],
  insights: ["layout"],
} as const;

export type ManagedRecordSettingsFamily =
  keyof typeof MANAGED_RECORD_SETTINGS_FIELD_ALLOWLIST;

const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((timezone) => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
      return true;
    } catch {
      return false;
    }
  }, "Expected an IANA timezone");

const profilePatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100).nullable().optional(),
    heightCm: z.number().finite().min(30).max(300).nullable().optional(),
    dateOfBirth: z.string().date().nullable().optional(),
    gender: z.enum(["MALE", "FEMALE", "OTHER"]).nullable().optional(),
    locale: z
      .enum(["de", "en", "es", "fr", "it", "pl", "ko"])
      .nullable()
      .optional(),
    timezone: timezoneSchema.optional(),
    unitPreference: z.enum(["metric", "imperial"]).optional(),
    timeFormat: z.enum(["AUTO", "H12", "H24"]).optional(),
    dateFormat: z.enum(["AUTO", "DMY", "MDY", "YMD"]).optional(),
  })
  .strict();

const insightsLayoutSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    sections: z
      .array(
        z
          .object({
            id: z.enum(INSIGHTS_SECTION_IDS),
            visible: z.boolean(),
            order: z.number().int().min(0).max(99),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    tiles: z
      .array(
        z
          .object({
            id: z.enum(ACCEPTED_INSIGHTS_TILE_IDS),
            visible: z.boolean(),
            order: z.number().int().min(0).max(99),
          })
          .strict(),
      )
      .min(1)
      .max(ACCEPTED_INSIGHTS_TILE_IDS.length)
      .optional(),
  })
  .strict();

// Delivery ownership is the actor's personal channel choice. A Guardian may
// set only the record's reminder timing and low-stock thresholds, never hand
// a managed record to an actor's phone or provider channel.
const managedNotificationPreferencesSchema = z
  .object({
    medication: z
      .object({
        lowStockRunwayDays: z.number().int().min(1).max(60).nullable(),
        reorderLeadDays: z.number().int().min(0).max(60),
      })
      .strict()
      .partial()
      .optional(),
    mood: z
      .object({ reminderHour: z.number().int().min(0).max(23) })
      .strict()
      .partial()
      .optional(),
  })
  .strict();

const managedCoachPreferencesSchema = coachPrefsSchema
  .pick({
    tone: true,
    verbosity: true,
    excludeMetrics: true,
    defaultWindow: true,
    dataClusters: true,
  })
  .strict();

/**
 * One strict patch schema per family. Exported so the OpenAPI registry can
 * publish the same objects the handler parses rather than a restatement of
 * them — every family is `strict()`, so a published paraphrase that drifted
 * would promise a field the route answers 422 for.
 */
export const MANAGED_RECORD_SETTINGS_PATCH_SCHEMAS = {
  profile: profilePatchSchema,
  /**
   * Two fields because the module foundation has two kinds of key, and only
   * one of them lives in `modulePreferencesJson`.
   *
   * `cycle` is a DELEGATED module: its user-layer state is owned by
   * `CycleProfile.cycleTrackingEnabled` (NULL derives from `User.gender`), and
   * `modulePreferencesJson.cycle` is ignored on purpose — which is why
   * `modulePrefsPatchSchema` refuses the key. A guardian therefore had no way
   * to turn Cycle off for a record whose sex says it should be on, and no row
   * for it in the list either: it is simply not a writable key (#939). Naming
   * the real column here writes the real source of truth rather than minting a
   * second one that the gate would ignore.
   *
   * Both optional so a client may send either alone; at least one required, so
   * an empty body is a refusal rather than a save that changed nothing.
   */
  modules: z
    .object({
      modulePreferences: modulePrefsPatchSchema.optional(),
      cycleTrackingEnabled: z.boolean().optional(),
    })
    .strict()
    .refine((patch) => Object.values(patch).some((v) => v !== undefined), {
      message: "Name at least one field to change",
    }),
  notifications: z
    .object({
      moodReminderEnabled: z.boolean().optional(),
      notificationPreferences: managedNotificationPreferencesSchema.optional(),
    })
    .strict(),
  thresholds: z.object({ overrides: thresholdsUpdateSchema }).strict(),
  coach: z
    .object({
      disableCoach: z.boolean().optional(),
      preferences: managedCoachPreferencesSchema.optional(),
    })
    .strict(),
  insights: z.object({ layout: insightsLayoutSchema }).strict(),
} as const;

export type ManagedRecordSettingsPatch = {
  profile: z.infer<typeof profilePatchSchema>;
  modules: z.infer<(typeof MANAGED_RECORD_SETTINGS_PATCH_SCHEMAS)["modules"]>;
  notifications: z.infer<
    (typeof MANAGED_RECORD_SETTINGS_PATCH_SCHEMAS)["notifications"]
  >;
  thresholds: z.infer<
    (typeof MANAGED_RECORD_SETTINGS_PATCH_SCHEMAS)["thresholds"]
  >;
  coach: z.infer<(typeof MANAGED_RECORD_SETTINGS_PATCH_SCHEMAS)["coach"]>;
  insights: z.infer<(typeof MANAGED_RECORD_SETTINGS_PATCH_SCHEMAS)["insights"]>;
};

export function isManagedRecordSettingsFamily(
  value: string,
): value is ManagedRecordSettingsFamily {
  return Object.hasOwn(MANAGED_RECORD_SETTINGS_PATCH_SCHEMAS, value);
}

/** Parse one named DTO family. Strict schemas make an actor field a 422. */
export function parseManagedRecordSettingsPatch<
  Family extends ManagedRecordSettingsFamily,
>(family: Family, value: unknown): ManagedRecordSettingsPatch[Family] {
  return MANAGED_RECORD_SETTINGS_PATCH_SCHEMAS[family].parse(
    value,
  ) as ManagedRecordSettingsPatch[Family];
}

export function safeParseManagedRecordSettingsPatch<
  Family extends ManagedRecordSettingsFamily,
>(family: Family, value: unknown) {
  return MANAGED_RECORD_SETTINGS_PATCH_SCHEMAS[family].safeParse(value);
}

/**
 * The same direct module inventory and default posture as `/api/auth/me/modules`.
 * Every entry is present for a fresh record so a Guardian can administer the
 * whole supported surface instead of seeing only previously persisted keys.
 */
export const MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS = Object.freeze(
  Object.fromEntries(
    WRITABLE_MODULE_KEYS.map((key) => [key, !MODULE_REGISTRY[key].optIn]),
  ),
) as Readonly<Record<(typeof WRITABLE_MODULE_KEYS)[number], boolean>>;

/** Preserve only directly-owned module keys from a legacy persisted blob. */
export function managedModulePreferencesFrom(
  raw: unknown,
): ManagedRecordSettingsPatch["modules"]["modulePreferences"] {
  const allowed: Record<string, boolean> = {
    ...MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS,
  };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return allowed;
  }

  for (const [key, value] of Object.entries(raw)) {
    const parsed = modulePrefsPatchSchema.safeParse({ [key]: value });
    if (parsed.success && value !== undefined) {
      allowed[key] = value as boolean;
    }
  }
  return allowed;
}
