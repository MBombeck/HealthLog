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
 *     "mood": { "reminderHour": 0..23 },
 *     "cycle": { "clientManaged": boolean }
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
    /**
     * v1.16.11 — low-stock alert threshold as REMAINING RUNWAY: notify
     * when a tracked medication's projected supply covers fewer than
     * this many days. 1–60; `null` switches the alert off entirely.
     * Default 7 (see `DEFAULT_NOTIFICATION_PREFS`). Read once daily by
     * the medication-low-stock cron.
     */
    lowStockRunwayDays: z.number().int().min(1).max(60).nullable(),
    /**
     * v1.17.0 — reorder lead time (days) the low-stock alert assumes
     * between placing a refill order and the new supply arriving. The
     * engine fires the alert when the projected runway drops to or below
     * `max(lowStockRunwayDays, reorderLeadDays + one dose-interval)`, so
     * the warning lands BEFORE the last dose for any cadence (a weekly
     * injection no longer alerts only when ~1 dose is left). 0–60;
     * default 10. A per-medication `Medication.reorderLeadDays` overrides
     * this user default when set.
     */
    reorderLeadDays: z.number().int().min(0).max(60),
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
 * v1.15 — cycle category schema. `clientManaged` mirrors the medication
 * gate: when the iOS app owns local cycle reminders (period-soon /
 * period-start-confirm), it flips this to `true` and the server-side
 * cycle cron suppresses its APNs send for that user, exactly as the
 * medication path does. Sub-object form keeps the layout open for future
 * cycle-notification knobs.
 */
const cyclePrefsSchema = z
  .object({
    clientManaged: z.boolean(),
  })
  .partial();

/**
 * v1.17.1 — measurement / Vorsorge reminder category schema.
 * `clientManaged` mirrors the medication + cycle gate: when the iOS app
 * owns local Vorsorge reminders it flips this to `true` and the
 * server-side measurement-reminder cron suppresses its APNs send for that
 * user. Sub-object form keeps the layout open for future Vorsorge knobs.
 */
const measurementReminderPrefsSchema = z
  .object({
    clientManaged: z.boolean(),
  })
  .partial();

/**
 * v1.15.20 — coach category schema. `nudgesEnabled` gates the proactive
 * Coach nudge cron (05:15 Europe/Berlin): default ON (the nudge is an
 * opt-out surface — it only fires for users who kept the Coach enabled
 * AND have a working provider), flipped off from Settings →
 * Notifications. Sub-object form keeps the layout open for future
 * coach-notification knobs (quiet days, trigger selection, …).
 */
const coachPrefsSchema = z
  .object({
    nudgesEnabled: z.boolean(),
    /**
     * v1.16.5 — per-trigger-group opt-outs underneath the master
     * switch. Groups, not individual triggers, so the UI stays three
     * comprehensible toggles as the trigger list grows:
     *   medication → compliance; vitals → bp / score / weight / sleep;
     *   routine → measurement-gap / self-context check-up.
     */
    nudgeMedication: z.boolean(),
    nudgeVitals: z.boolean(),
    nudgeRoutine: z.boolean(),
    /** v1.16.5 — frequency cap: one nudge per 7 or per 14 days. */
    nudgeFrequency: z.enum(["weekly", "biweekly"]),
    /**
     * v1.25.0 — opt-IN for AI-composed nudge copy. Default OFF: the proactive
     * nudge ships a deterministic warm localized template, and that template is
     * always the fail-closed fallback. When this is on AND a provider is
     * healthy the 05:15 tick composes the nudge through the model instead —
     * under a per-user budget gate, a tight per-call timeout and a per-tick
     * ceiling, with any error/timeout/budget falling silently back to the
     * template. Off by default so provider saturation is opt-in, never the
     * baseline.
     */
    nudgeAiComposed: z.boolean(),
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
    cycle: cyclePrefsSchema,
    coach: coachPrefsSchema,
    measurementReminder: measurementReminderPrefsSchema,
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
    /**
     * v1.16.11 — low-stock runway threshold in days (1–60), or `null`
     * when the alert is off. Default 7.
     */
    lowStockRunwayDays: number | null;
    /**
     * v1.17.0 — reorder lead time (days) the low-stock alert assumes.
     * 0–60; default 10. Per-medication `reorderLeadDays` overrides it.
     */
    reorderLeadDays: number;
  };
  mood: {
    /** v1.7.0 — local-time hour (0–23) for the daily mood reminder. */
    reminderHour: number;
  };
  cycle: {
    /**
     * v1.15 — when true the iOS app owns local cycle reminders and the
     * server-side cycle cron suppresses its APNs send (the medication
     * `clientManaged` precedent).
     */
    clientManaged: boolean;
  };
  coach: {
    /**
     * v1.15.20 — proactive Coach nudge opt-out. Default `true`; the
     * 05:15 nudge cron skips the user when `false`.
     */
    nudgesEnabled: boolean;
    /** v1.16.5 — medication-group triggers (compliance). Default on. */
    nudgeMedication: boolean;
    /** v1.16.5 — vitals-group triggers (bp / score / weight / sleep). */
    nudgeVitals: boolean;
    /** v1.16.5 — routine-group triggers (measurement gap / self-context). */
    nudgeRoutine: boolean;
    /** v1.16.5 — cap interval: "weekly" (7 d) or "biweekly" (14 d). */
    nudgeFrequency: "weekly" | "biweekly";
    /**
     * v1.25.0 — opt-in for AI-composed nudge copy. Default `false`; the
     * deterministic template stays the default + fail-closed fallback.
     */
    nudgeAiComposed: boolean;
  };
  measurementReminder: {
    /**
     * v1.17.1 — when true the iOS app owns local Vorsorge reminders and
     * the server-side measurement-reminder cron suppresses its APNs send
     * (the medication / cycle `clientManaged` precedent).
     */
    clientManaged: boolean;
  };
}

/**
 * v1.7.0 — default mood-reminder hour. 22:00 reproduces the legacy
 * hardcoded window, so any user with an unset value sees zero change.
 */
export const DEFAULT_MOOD_REMINDER_HOUR = 22;

/**
 * v1.16.11 — default low-stock runway threshold: notify when the
 * remaining supply covers fewer than 7 days.
 */
export const DEFAULT_LOW_STOCK_RUNWAY_DAYS = 7;

/**
 * v1.17.0 — default reorder lead time: assume 10 days between ordering a
 * refill and the new supply arriving. The alert engine widens the
 * trigger by this lead plus one dose-interval so a sparse cadence is
 * warned before its last dose.
 */
export const DEFAULT_REORDER_LEAD_DAYS = 10;

/**
 * Safe defaults. Every category is off so the server reminders flow
 * unchanged for any user the iOS app has not explicitly opted in.
 * The maintainer's directive: zero regression for clients without working
 * local reminders.
 */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  medication: {
    clientManaged: false,
    deliveryDefault: "server",
    lowStockRunwayDays: DEFAULT_LOW_STOCK_RUNWAY_DAYS,
    reorderLeadDays: DEFAULT_REORDER_LEAD_DAYS,
  },
  mood: {
    reminderHour: DEFAULT_MOOD_REMINDER_HOUR,
  },
  cycle: {
    clientManaged: false,
  },
  coach: {
    nudgesEnabled: true,
    nudgeMedication: true,
    nudgeVitals: true,
    nudgeRoutine: true,
    nudgeFrequency: "weekly",
    nudgeAiComposed: false,
  },
  measurementReminder: {
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
  return applyDeliveryDefaultMapping({
    medication: {
      ...base.medication,
      ...(incoming.medication ?? {}),
    },
    mood: {
      ...base.mood,
      ...(incoming.mood ?? {}),
    },
    cycle: {
      ...base.cycle,
      ...(incoming.cycle ?? {}),
    },
    coach: {
      ...base.coach,
      ...(incoming.coach ?? {}),
    },
    measurementReminder: {
      ...base.measurementReminder,
      ...(incoming.measurementReminder ?? {}),
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
function applyDeliveryDefaultMapping(
  prefs: NotificationPrefs,
): NotificationPrefs {
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
    cycle: { ...prefs.cycle },
    coach: { ...prefs.coach },
    measurementReminder: { ...prefs.measurementReminder },
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
 * Cron-side helper. Returns `true` when the user has opted in to
 * client-managed CYCLE reminders (iOS owns the local period-soon /
 * period-start-confirm nudges) and the server-side push should be
 * suppressed. Tolerates a null / missing prefs row. Mirrors
 * `isMedicationReminderClientManaged`.
 */
export function isCycleReminderClientManaged(raw: unknown): boolean {
  return parseNotificationPrefs(raw).cycle.clientManaged === true;
}

/**
 * v1.17.1 — cron-side helper. Returns `true` when the user has opted in
 * to client-managed Vorsorge (measurement) reminders so the server-side
 * push should be suppressed. Tolerates a null / missing prefs row.
 * Mirrors `isMedicationReminderClientManaged` / `isCycleReminderClientManaged`.
 */
export function isMeasurementReminderClientManaged(raw: unknown): boolean {
  return parseNotificationPrefs(raw).measurementReminder.clientManaged === true;
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

/**
 * Cron-side helper. Resolve the user's low-stock runway threshold in
 * days from the persisted prefs blob: 1–60, or `null` when the user
 * switched the alert off. A null / drifted row resolves to the default
 * (7 days) so the alert works out of the box.
 */
export function resolveLowStockRunwayDays(raw: unknown): number | null {
  return parseNotificationPrefs(raw).medication.lowStockRunwayDays;
}

/**
 * v1.17.0 — resolve the EFFECTIVE reorder lead time (days) for one
 * medication: the per-medication override when set, otherwise the
 * user-level default from the prefs blob (a null / drifted row resolves
 * to the documented 10-day default). The low-stock alert adds this lead
 * plus one dose-interval on top of the runway threshold.
 */
export function resolveReorderLeadDays(
  raw: unknown,
  medicationOverride: number | null | undefined,
): number {
  if (typeof medicationOverride === "number" && medicationOverride >= 0) {
    return medicationOverride;
  }
  return parseNotificationPrefs(raw).medication.reorderLeadDays;
}

/**
 * v1.16.5 — fully-resolved Coach-nudge view for the cron: the master
 * switch, the three per-group toggles, and the frequency cap mapped to
 * days. One call so the nudge tick reads a single shape instead of
 * threading the whole prefs object.
 */
export interface CoachNudgePrefs {
  enabled: boolean;
  groups: {
    medication: boolean;
    vitals: boolean;
    routine: boolean;
  };
  /** 7 for "weekly", 14 for "biweekly". */
  minIntervalDays: number;
  /**
   * v1.25.0 — when true the nudge tick composes the copy through the model
   * (under hard guards) instead of the deterministic template. Default false.
   */
  aiComposed: boolean;
}

export function resolveCoachNudgePrefs(raw: unknown): CoachNudgePrefs {
  const coach = parseNotificationPrefs(raw).coach;
  return {
    enabled: coach.nudgesEnabled,
    groups: {
      medication: coach.nudgeMedication,
      vitals: coach.nudgeVitals,
      routine: coach.nudgeRoutine,
    },
    minIntervalDays: coach.nudgeFrequency === "biweekly" ? 14 : 7,
    aiComposed: coach.nudgeAiComposed,
  };
}

function cloneDefaults(): NotificationPrefs {
  return {
    medication: { ...DEFAULT_NOTIFICATION_PREFS.medication },
    mood: { ...DEFAULT_NOTIFICATION_PREFS.mood },
    cycle: { ...DEFAULT_NOTIFICATION_PREFS.cycle },
    coach: { ...DEFAULT_NOTIFICATION_PREFS.coach },
    measurementReminder: {
      ...DEFAULT_NOTIFICATION_PREFS.measurementReminder,
    },
  };
}

function mergeOverDefaults(input: NotificationPrefsInput): NotificationPrefs {
  return applyDeliveryDefaultMapping({
    medication: {
      ...DEFAULT_NOTIFICATION_PREFS.medication,
      ...(input.medication ?? {}),
    },
    mood: {
      ...DEFAULT_NOTIFICATION_PREFS.mood,
      ...(input.mood ?? {}),
    },
    cycle: {
      ...DEFAULT_NOTIFICATION_PREFS.cycle,
      ...(input.cycle ?? {}),
    },
    coach: {
      ...DEFAULT_NOTIFICATION_PREFS.coach,
      ...(input.coach ?? {}),
    },
    measurementReminder: {
      ...DEFAULT_NOTIFICATION_PREFS.measurementReminder,
      ...(input.measurementReminder ?? {}),
    },
  });
}
