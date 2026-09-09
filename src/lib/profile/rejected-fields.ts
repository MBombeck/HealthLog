/**
 * Naming the profile fields a save declined.
 *
 * `applyProfileUpdate` (`src/lib/auth/profile-update.ts`) writes every
 * field that validated and reports the rest back: `data.rejectedFields`
 * on a partial success, `details.issues` when nothing could be written
 * at all. Both carry the schema key (`heightCm`, `gender`, ...) and a
 * machine-readable code — never a sentence a person should read.
 *
 * Turning that key into words is the client's job, and every screen
 * that writes the profile has to do it the same way, or the same
 * rejection reads differently depending on where the person happened
 * to be standing. This module is that one way: the settings account
 * form and the onboarding baseline step both resolve the key through
 * it, each passing the labels its own inputs already carry.
 */

/** A single rejected-field entry from `applyProfileUpdate`'s wire shape
 * (`details.issues` on failure, `data.rejectedFields` on a partial
 * success) — `path` is the schema field name, never shown verbatim. */
export interface RejectedProfileField {
  path: string;
  code: string;
  message?: string;
}

/**
 * Maps a rejected field's schema `path` to the same i18n label already
 * shown next to that input on the settings account form. The server
 * only ever knows the field by its schema key — naming it in a
 * person-facing sentence is the client's job, using labels that already
 * exist and are already localized for that form.
 *
 * A screen with different labels for the same fields (the onboarding
 * baseline step calls them by its own names) passes its own map to
 * `describeRejectedProfileField` instead.
 */
export const PROFILE_FIELD_LABEL_KEYS: Record<string, string> = {
  email: "auth.email",
  heightCm: "settings.height",
  dateOfBirth: "settings.dateOfBirth",
  gender: "settings.gender",
  fullName: "settings.identity.fullName",
  insurerName: "settings.identity.insurer",
  insuranceNumber: "settings.identity.insuranceNumber",
};

/**
 * Renders the first rejected field's label, falling back to its raw
 * schema key for a field the calling screen has no input for
 * (defensive — every field a form submits is expected in its map).
 */
export function describeRejectedProfileField(
  fields: RejectedProfileField[] | undefined,
  t: (key: string) => string,
  labelKeys: Record<string, string> = PROFILE_FIELD_LABEL_KEYS,
): string | null {
  const first = fields?.[0];
  if (!first) return null;
  const labelKey = labelKeys[first.path];
  return labelKey ? t(labelKey) : first.path;
}

/**
 * The sentence a person reads under the input, keyed by the validator
 * code the server sent back. The code is the only reason that crosses
 * the wire — `message` is the validator's own prose and is deliberately
 * never shown — so each code gets one plain sentence saying what was
 * wrong with the value, in the person's language.
 *
 * A code with no entry here falls back to `other`, which says the field
 * was not accepted without inventing a reason. New Zod codes therefore
 * degrade to something honest instead of to silence.
 */
const REJECTION_REASON_KEYS: Record<string, string> = {
  too_big: "settings.profileRejection.tooBig",
  too_small: "settings.profileRejection.tooSmall",
  invalid_value: "settings.profileRejection.invalidValue",
  invalid_format: "settings.profileRejection.invalidFormat",
  invalid_type: "settings.profileRejection.invalidType",
};

const REJECTION_FALLBACK_KEY = "settings.profileRejection.other";

/**
 * Turn a rejection list into one sentence per field, keyed by the
 * schema path so a form can drop each one into the slot under the
 * input it belongs to.
 *
 * Every refused field is carried, not just the first: a submission with
 * two bad values that only names one sends the person round the loop
 * twice. Where a field is refused for several reasons at once the first
 * one wins — the others are restatements of the same wrong value.
 *
 * No label map is needed: the sentence sits under the input, which
 * already carries the label, and the key is the schema path so the
 * calling screen can place it without a rename. A path the screen has
 * no input for still gets an entry rather than being dropped, so the
 * caller can decide what to do with it.
 */
export function describeRejectedProfileFields(
  fields: RejectedProfileField[] | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields ?? []) {
    if (out[field.path]) continue;
    const key = REJECTION_REASON_KEYS[field.code] ?? REJECTION_FALLBACK_KEY;
    out[field.path] = t(key);
  }
  return out;
}
