import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

/**
 * v1.4.37 — silent browser-zone auto-seed for the timezone picker.
 *
 * Until v1.4.37 the picker carried a "Browser-Zeitzone übernehmen" /
 * "Use browser timezone" button so the user could overwrite the
 * Europe/Berlin seed with their detected zone on demand. The button
 * was visually noisy next to the picker on mobile and almost every
 * user wants the browser zone anyway, so the affordance retired and
 * the bootstrap effect seeds the form for them.
 *
 * Rules:
 *
 *   - If the stored value is anything other than the Europe/Berlin
 *     default, respect it. The user explicitly picked it.
 *   - If the stored value is the Europe/Berlin default but the
 *     browser actually IS in Berlin, leave it alone — the picker
 *     stays on Berlin and the next save is a no-op.
 *   - If the stored value is the default AND the browser reports a
 *     non-Berlin zone, pre-fill the picker with the detected zone.
 *     The form's existing submit handler persists the change on the
 *     next save; no toast, no banner, no opt-in.
 *
 * The bootstrap deliberately runs inline during render (the strict
 * `react-hooks/set-state-in-effect` rule outlaws setState in an
 * effect for this hydration shape), so this helper has to stay
 * pure — no DOM access, no `useState`. The detected browser zone is
 * passed in by the caller via `detectBrowserTimezone()`.
 */
export function resolveInitialTimezone(
  storedTimezone: string | null | undefined,
  detectedBrowserTimezone: string,
): string {
  const stored = storedTimezone || DEFAULT_TIMEZONE;
  const shouldAutoSeed =
    stored === DEFAULT_TIMEZONE &&
    detectedBrowserTimezone.length > 0 &&
    detectedBrowserTimezone !== DEFAULT_TIMEZONE;
  return shouldAutoSeed ? detectedBrowserTimezone : stored;
}

/**
 * v1.16.4 — settings status hints store the i18n KEY (+ params), not
 * the translated string: a locale switch re-renders the hint in the
 * new language instead of freezing the old-language snapshot. The
 * `text` variant rides a server string verbatim — reserved for
 * endpoints whose message is already a specific, hand-curated,
 * person-safe sentence (e.g. the timezone endpoint's own IANA
 * validation text). It must never carry a generic validator message;
 * the profile save path resolves `meta.errorCode` into a `key` instead
 * so nothing server-generated reaches this screen untranslated.
 */
export type StatusMessage =
  { key: string; params?: Record<string, string | number> } | { text: string };

export function statusText(
  msg: StatusMessage,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  return "key" in msg ? t(msg.key, msg.params) : msg.text;
}

/**
 * Naming a rejected profile field is shared with the onboarding
 * baseline step — see `src/lib/profile/rejected-fields.ts`. This screen
 * uses the default label map, which points at the labels these inputs
 * already carry.
 */

/**
 * Drop one field's refusal as the person edits that field.
 *
 * A refusal answers a value. Once the value changes it answers nothing,
 * so it goes instead of sitting under an input that has already been
 * corrected — the same rule the onboarding baseline step applies in its
 * `patch` helper. Only the edited slot is dropped: the other fields the
 * same save refused were not touched, so their sentences still stand.
 *
 * The map is returned unchanged when the slot holds nothing, so typing
 * in a field that was never refused does not re-render the form.
 */
export function clearRejectedField(
  errors: Record<string, string>,
  slot: string,
): Record<string, string> {
  if (!(slot in errors)) return errors;
  const next = { ...errors };
  delete next[slot];
  return next;
}
