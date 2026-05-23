/**
 * v1.4.49 M-DOUBLE-REMINDER — per-user notification preferences blob.
 *
 * Persisted on `User.notificationPrefs` as Postgres jsonb. Null = the
 * documented defaults (every category off). The flag is opt-in: the
 * iOS app flips it to `true` only after confirming local Spezi
 * reminders are wired, so existing users without a working local
 * notification path see zero regression.
 *
 * Shape (additive — future categories slot in next to `medication`):
 *   {
 *     "medication": { "clientManaged": boolean }
 *   }
 *
 * The schema is intentionally additive — every new category grows the
 * schema with a new optional sub-object plus an entry in
 * `DEFAULT_NOTIFICATION_PREFS`. Forward-compat: an unknown / drifted
 * shape falls back to defaults rather than throwing.
 */
import { z } from "zod/v4";

/**
 * Medication category schema. Currently a single boolean
 * (`clientManaged`); the sub-object exists so future per-category
 * knobs (e.g. quiet-hours overrides) can be added without breaking
 * the persisted layout.
 */
const medicationPrefsSchema = z
  .object({
    clientManaged: z.boolean(),
  })
  .partial();

/**
 * Top-level prefs schema. Every category is optional so a PATCH that
 * only touches `medication` doesn't have to re-state future siblings.
 * The route layer deep-merges the partial input over the persisted
 * row before persisting so the column shape stays stable.
 */
export const notificationPrefsSchema = z
  .object({
    medication: medicationPrefsSchema,
  })
  .partial();

export type NotificationPrefsInput = z.infer<typeof notificationPrefsSchema>;

/**
 * Fully-resolved prefs. Every key required so consumers (cron
 * suppression, GET response) don't need to thread "is this present?"
 * checks through their paths.
 */
export interface NotificationPrefs {
  medication: {
    clientManaged: boolean;
  };
}

/**
 * Safe defaults. Every category is off so the server reminders flow
 * unchanged for any user the iOS app has not explicitly opted in.
 * Marc's directive: zero regression for clients without working
 * local reminders.
 */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  medication: {
    clientManaged: false,
  },
};

/**
 * Parse the persisted `notificationPrefs` JSON blob into a typed
 * `NotificationPrefs`, falling back to the defaults when the row is
 * null OR the persisted shape has drifted (a forward-compat field
 * rename, an admin-side hand-edit, etc.). Missing keys are filled
 * from the defaults so callers always get a fully-resolved object.
 */
export function parseNotificationPrefs(raw: unknown): NotificationPrefs {
  if (raw == null) return cloneDefaults();
  const parsed = notificationPrefsSchema.safeParse(raw);
  if (!parsed.success) return cloneDefaults();
  return mergeOverDefaults(parsed.data);
}

/**
 * Deep-merge a partial input (typically from a PATCH body) over the
 * current persisted row, layering each supplied category's keys over
 * the existing category sub-object so future siblings are not
 * overwritten when the client only PATCHes `medication`.
 */
export function resolveNotificationPrefs(
  current: unknown,
  incoming: NotificationPrefsInput,
): NotificationPrefs {
  const base = parseNotificationPrefs(current);
  return {
    medication: {
      ...base.medication,
      ...(incoming.medication ?? {}),
    },
  };
}

/**
 * Cron-side helper. Returns `true` when the user has opted in to
 * client-managed medication reminders and the server-side push
 * should be suppressed. Tolerates a null / missing prefs row.
 */
export function isMedicationReminderClientManaged(raw: unknown): boolean {
  return parseNotificationPrefs(raw).medication.clientManaged === true;
}

function cloneDefaults(): NotificationPrefs {
  return {
    medication: { ...DEFAULT_NOTIFICATION_PREFS.medication },
  };
}

function mergeOverDefaults(
  input: NotificationPrefsInput,
): NotificationPrefs {
  return {
    medication: {
      ...DEFAULT_NOTIFICATION_PREFS.medication,
      ...(input.medication ?? {}),
    },
  };
}
