/**
 * The snooze length of a dose reminder ("Remind me later"): one value per
 * person (`notificationPrefs.medication.snoozeMinutes`) that the web card,
 * Telegram and the app all use. Client-safe constants, no schema import.
 */
export const MIN_SNOOZE_MINUTES = 5;
export const MAX_SNOOZE_MINUTES = 240;
/** "Remind me later" defers a dose reminder by this much unless set. */
export const DEFAULT_SNOOZE_MINUTES = 30;
/** The lengths the settings offer. */
export const SNOOZE_MINUTE_CHOICES = [10, 15, 30, 45, 60, 90, 120] as const;
