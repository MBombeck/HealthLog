/**
 * The per-user (LAYER 2) cycle-tracking decision, pure.
 *
 * A leaf, imported by both the module gate (`@/lib/modules/gate`, which
 * AND-s it with the operator kill-switch) and the cycle route guard
 * (`./gate.ts`, which asks the module gate). Kept apart from both so the
 * two gates do not import each other. See `./gate.ts` for the layering.
 */
/**
 * Resolve whether cycle tracking is enabled for an account.
 *
 * @param gender the user's `gender` column (`"MALE" | "FEMALE" | null`).
 * @param profile the user's `CycleProfile`, or just its
 *   `cycleTrackingEnabled` field (NULL ⇒ derive from gender).
 */
export function isCycleEnabled(
  gender: string | null | undefined,
  profile: { cycleTrackingEnabled: boolean | null } | null | undefined,
): boolean {
  const toggle = profile?.cycleTrackingEnabled;
  if (toggle === true) return true;
  if (toggle === false) return false;
  // NULL toggle → derive from gender.
  return gender === "FEMALE";
}
