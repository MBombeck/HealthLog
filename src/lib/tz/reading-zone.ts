/**
 * The time zone of one reading (iOS #181).
 *
 * A measurement may carry the IANA zone it was taken in (`Measurement.
 * timeZone`, sent by the iOS app from HealthKit's `HKMetadataKeyTimeZone`).
 * The rule every reader follows:
 *
 *   the local day and the wall clock of a reading are read in its own zone
 *   when it has one, and in the profile zone otherwise.
 *
 * So a night slept in New York by a Berlin profile is filed under the New
 * York wake day, and a reading without a zone (every row written before the
 * column, every writer that does not send one) reads exactly as it did.
 *
 * What does NOT read the reading's zone:
 *
 *   - The rollup tier. Its buckets are UTC days (`utcBucketStart`), the same
 *     for every zone, and a reading's zone does not move it between buckets.
 *     Surfaces that show local days read raw rows through the helpers below.
 *   - Windows. A read of one local day still selects rows by an instant
 *     window built in the profile zone; `READING_ZONE_SLACK_MS` widens it so
 *     a reading whose own zone puts it on that day is fetched, and the day is
 *     then decided per row.
 */
import { isValidTimezone, userDayKey } from "./format";

/**
 * The widest a reading's own zone can move its local day from the profile
 * zone's: UTC-12 against UTC+14 is 26 hours.
 */
export const READING_ZONE_SLACK_MS = 26 * 60 * 60 * 1000;

/** IANA names are ASCII letters, digits, `_`, `-`, `+` and `/`. */
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

/**
 * Whether a client-sent zone name can be stored: a well-formed IANA name the
 * runtime knows. The batch route additionally checks it against Postgres
 * (`zonesKnownToPostgres` in `./reading-zone-sql.ts`), because the SQL readers hand it to `AT TIME ZONE`.
 */
export function isStorableTimeZone(value: string): boolean {
  return ZONE_SHAPE.test(value) && isValidTimezone(value);
}

/** The zone a reading is read in. */
export function readingZone(
  rowZone: string | null | undefined,
  profileZone: string,
): string {
  return rowZone ?? profileZone;
}

/** The local day (`YYYY-MM-DD`) of a reading. */
export function readingDayKey(
  at: Date,
  rowZone: string | null | undefined,
  profileZone: string,
): string {
  return userDayKey(at, readingZone(rowZone, profileZone));
}
