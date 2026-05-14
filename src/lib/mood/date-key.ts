/**
 * v1.4.25 W7b — per-row timezone attribution for MoodEntry rows.
 *
 * Background. Up to v1.4.24 the mood-entries POST handler computed
 * `MoodEntry.date` (YYYY-MM-DD) by formatting `moodLoggedAt` in
 * Europe/Berlin regardless of where the user actually was. That is
 * correct for users in DE, wrong for everyone else: a 23:45 NZST
 * reading would store `date` as the Berlin day, one day earlier than
 * the user's own "today".
 *
 * Decision A (proposal §7): forward-only fix.
 *
 *   - Schema. Add nullable `MoodEntry.tz` column (migration 0044).
 *
 *   - Writes. Every new row captures the user's current
 *     `displayTimezone`, stores it on the row's `tz` column, and
 *     computes `date` using THAT zone.
 *
 *   - Reads. Rows with `tz === null` (legacy) are interpreted as if
 *     `tz === "Europe/Berlin"`, matching the implicit write-time
 *     assumption. Rows with explicit `tz` are interpreted in their
 *     stored zone. No backfill is required because the read-side
 *     interpretation rebuilds the historical bucketing without
 *     touching the data.
 *
 * The helpers below are the single source of truth for both the write
 * path (`moodDateKey`) and any read path that needs to re-interpret a
 * legacy date string (`effectiveMoodTz`).
 */

export const DEFAULT_TIMEZONE = "Europe/Berlin";

/**
 * Build the `YYYY-MM-DD` day-key for a mood entry given the user's
 * timezone at write time. Used by `POST /api/mood-entries` and the
 * `PUT /api/mood-entries/:id` route when `moodLoggedAt` changes.
 *
 * The Swedish locale ("sv-SE") is the historical choice for ISO 8601
 * day output via `Intl.DateTimeFormat`; we keep it so the new path
 * produces byte-identical strings to the legacy `toBerlinDate()` for
 * Europe/Berlin users (the only path tested under the v1.4.24 suite).
 */
export function moodDateKey(date: Date, tz: string): string {
  const safe = tz && tz.length > 0 ? tz : DEFAULT_TIMEZONE;
  return new Intl.DateTimeFormat("sv-SE", { timeZone: safe }).format(date);
}

/**
 * Resolve the effective timezone for a MoodEntry row. Read-path
 * helpers (e.g. analytics aggregation by mood-day, export) call this
 * to know which zone the row's `date` string is anchored to. A
 * non-null `tz` column takes precedence; legacy rows fall back to
 * Europe/Berlin.
 */
export function effectiveMoodTz(row: {
  tz: string | null | undefined;
}): string {
  return row.tz && row.tz.length > 0 ? row.tz : DEFAULT_TIMEZONE;
}
