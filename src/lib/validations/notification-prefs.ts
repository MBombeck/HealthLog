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
 *     "medication": { "clientManaged": boolean },
 *     "mood": { "reminderHour": 0..23 }
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
    /**
     * v1.7.0 — roaming user-level delivery default. "server" = the
     * server fires APNs (the legacy behaviour); "client" = the iOS app
     * manages reminders locally. Kept as a SEPARATE field from
     * `clientManaged` (the established cron gate the reminder worker
     * reads verbatim at `reminder-worker.ts`); the resolver maps
     * `deliveryDefault === "client"` onto `clientManaged: true` for
     * backward compatibility so the cron keeps reading one boolean.
     */
    deliveryDefault: z.enum(["server", "client"]),
  })
  .partial();

/**
 * v1.7.0 — mood category schema. `reminderHour` is the local-time hour
 * (0–23) at which the daily mood reminder fires. Sub-object form keeps
 * the layout open for future mood knobs (quiet days, snooze, …).
 * Default is 22:00 — see `DEFAULT_NOTIFICATION_PREFS` — so an unset
 * value is identical to the legacy hardcoded behaviour.
 */
const moodPrefsSchema = z
  .object({
    reminderHour: z.number().int().min(0).max(23),
  })
  .partial();

/**
 * v1.7.0 — per-device delivery override schema for the device PATCH.
 * NULL clears the override (the device inherits the user-level roaming
 * default).
 */
export const deviceDeliverySchema = z.enum(["server", "client"]).nullable();

/**
 * Top-level prefs schema. Every category is optional so a PATCH that
 * only touches `medication` doesn't have to re-state future siblings.
 * The route layer deep-merges the partial input over the persisted
 * row before persisting so the column shape stays stable.
 */
export const notificationPrefsSchema = z
  .object({
    medication: medicationPrefsSchema,
    mood: moodPrefsSchema,
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
    /** v1.7.0 — roaming user-level delivery default. */
    deliveryDefault: "server" | "client";
  };
  mood: {
    /** v1.7.0 — local-time hour (0–23) for the daily mood reminder. */
    reminderHour: number;
  };
}

/**
 * v1.7.0 — default mood-reminder hour. 22:00 reproduces the legacy
 * hardcoded window, so any user with an unset value sees zero change.
 */
export const DEFAULT_MOOD_REMINDER_HOUR = 22;

/**
 * Safe defaults. Every category is off so the server reminders flow
 * unchanged for any user the iOS app has not explicitly opted in.
 * Marc's directive: zero regression for clients without working
 * local reminders.
 */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  medication: {
    clientManaged: false,
    deliveryDefault: "server",
  },
  mood: {
    reminderHour: DEFAULT_MOOD_REMINDER_HOUR,
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
  return applyDeliveryDefaultMapping({
    medication: {
      ...base.medication,
      ...(incoming.medication ?? {}),
    },
    mood: {
      ...base.mood,
      ...(incoming.mood ?? {}),
    },
  });
}

/**
 * v1.7.0 — map the human-meaningful `deliveryDefault` onto the
 * established `clientManaged` cron gate. When the user sets
 * `deliveryDefault: "client"` ("Alle Geräte" → local), the reminder
 * worker must suppress server APNs, which it does by reading
 * `clientManaged`. Keeping two fields lets the iOS UI surface the
 * "server / client" choice while the cron keeps reading one boolean.
 * The mapping never flips `clientManaged` back to false on its own —
 * an explicit `clientManaged` in the input still wins.
 */
function applyDeliveryDefaultMapping(prefs: NotificationPrefs): NotificationPrefs {
  const clientManaged =
    prefs.medication.deliveryDefault === "client"
      ? true
      : prefs.medication.clientManaged;
  return {
    medication: {
      ...prefs.medication,
      clientManaged,
    },
    mood: { ...prefs.mood },
  };
}

/**
 * Cron-side helper. Returns `true` when the user has opted in to
 * client-managed medication reminders and the server-side push
 * should be suppressed. Tolerates a null / missing prefs row. v1.7.0 —
 * also true when the roaming `deliveryDefault` is "client".
 */
export function isMedicationReminderClientManaged(raw: unknown): boolean {
  const prefs = parseNotificationPrefs(raw);
  return (
    prefs.medication.clientManaged === true ||
    prefs.medication.deliveryDefault === "client"
  );
}

/**
 * v1.7.0 — resolve the effective delivery channel for a device. The
 * per-device override wins; otherwise the user-level roaming default;
 * otherwise "server" (the safe default). This is an iOS-display concern
 * in v1.7.0 — which device shows the local banner — not a server
 * fan-out concern, so the reminder cron stays user-level (APNs already
 * fans out to all the user's devices and iOS dedupes locally).
 */
export function resolveDeviceDelivery(
  raw: unknown,
  deviceOverride: string | null | undefined,
): "server" | "client" {
  if (deviceOverride === "server" || deviceOverride === "client") {
    return deviceOverride;
  }
  return parseNotificationPrefs(raw).medication.deliveryDefault;
}

/**
 * Cron-side helper. Resolve the user's local-time mood-reminder hour
 * (0–23) from the persisted prefs blob, falling back to the default
 * (22:00) for a null / drifted row. Pulled out so the mood-reminder
 * cron reads one number instead of threading the whole prefs object.
 */
export function resolveMoodReminderHour(raw: unknown): number {
  return parseNotificationPrefs(raw).mood.reminderHour;
}

function cloneDefaults(): NotificationPrefs {
  return {
    medication: { ...DEFAULT_NOTIFICATION_PREFS.medication },
    mood: { ...DEFAULT_NOTIFICATION_PREFS.mood },
  };
}

function mergeOverDefaults(
  input: NotificationPrefsInput,
): NotificationPrefs {
  return applyDeliveryDefaultMapping({
    medication: {
      ...DEFAULT_NOTIFICATION_PREFS.medication,
      ...(input.medication ?? {}),
    },
    mood: {
      ...DEFAULT_NOTIFICATION_PREFS.mood,
      ...(input.mood ?? {}),
    },
  });
}
