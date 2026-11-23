/**
 * What a change to an account's identity fields must refresh.
 *
 * Four writers set these fields on a user row: the profile PUT
 * (`applyProfileUpdate`), the timezone picker (`/api/auth/me/timezone`), a
 * record's settings (`/api/record-settings/[family]`), and a Guardian editing a
 * managed profile (`updateManagedProfile`). Each used to carry its own list of
 * side effects, and the lists disagreed: the managed-profile edit refreshed
 * nothing, so a profile's day grid and compliance stayed in the old zone and
 * its age- and sex-dependent targets stayed stale until the caches aged out.
 * Every writer calls this once the write has committed.
 */
import {
  invalidateUserMedications,
  invalidateUserProfile,
} from "@/lib/cache/invalidate";
import { enqueueSupplementNutrientRecompute } from "@/lib/medications/ingredients/recompute-job";
import { invalidateUserTimezone } from "@/lib/tz/resolver";

export interface IdentityFieldsChanged {
  /** Height, date of birth or sex was written. */
  anthropometrics: boolean;
  /** The timezone was written with a value other than the one stored. */
  timezone: boolean;
}

export async function afterIdentityFieldsChanged(
  userId: string,
  changed: IdentityFieldsChanged,
): Promise<void> {
  // The targets grid (BMI band, BP-by-age range, body-fat band), the
  // derived-score baseline (age, sex, height) and the analytics snapshot.
  if (changed.anthropometrics) invalidateUserProfile(userId);
  if (changed.timezone) {
    // The resolved zone is cached for a minute in process.
    invalidateUserTimezone(userId);
    // The medication payloads are computed in the zone but keyed by the
    // user alone, so the next read would serve the old zone's day grid.
    invalidateUserMedications(userId, { evict: true });
    // Supplement nutrient rows are keyed by the local day of the dose.
    await enqueueSupplementNutrientRecompute(userId);
  }
}
