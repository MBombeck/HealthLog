/**
 * v1.39 (C2) — what the confirm screen says is switched on.
 *
 * A READ of the registry's derivation, never a second mapping: the list the
 * person confirms is `deriveOnboardingModuleDefaults` applied to the same
 * answers `POST /api/onboarding/complete` will apply it to, with the same
 * conservative defaults for a skipped question. A wizard that computed its
 * own list would drift from the one the route actually writes, and the
 * confirm screen would then be confirming something else.
 *
 * What the route writes on top of this — the merge that never retracts a
 * module switched on by hand or one holding data — only ever ADDS to the
 * list, which is why the sentence beside it says "everything else stays
 * under Settings" rather than "is off".
 */
import {
  deriveOnboardingModuleDefaults,
  mergeDerivedModulePreferences,
  MODULE_KEYS,
  ONBOARDING_ALWAYS_ON_MODULES,
  type ModuleKey,
} from "@/lib/modules/registry";

import type { OnboardingNeeds } from "./needs";

export interface ConfirmedModules {
  /** What the answers switch on, in registry order — the always-on trio aside. */
  chosen: ModuleKey[];
  /** On whatever the answers say. */
  alwaysOn: ModuleKey[];
  /**
   * v1.39 (Wave C, C4) — what the derivation takes OUT of the navigation:
   * modules this record shows today that the answers do not ask for
   * (research I6). Empty until the account payload has resolved, because a
   * module the payload says nothing about is a module this screen knows
   * nothing about.
   */
  wouldSwitchOff: ModuleKey[];
}

/**
 * @param current the module map the record shows today (`user.modules`), so
 * the screen names only modules that are actually in the navigation now.
 */
export function confirmedModules(
  needs: OnboardingNeeds,
  current: Partial<Record<ModuleKey, boolean>> = {},
): ConfirmedModules {
  const derived = deriveOnboardingModuleDefaults({
    // Q1 is required and a confirm screen is never reached without it; the
    // fallback only keeps the type total.
    recordTarget: needs.recordTarget ?? "me",
    areas: needs.areas,
    // The same defaults the route applies to a skipped question.
    medication: needs.medication ?? "no",
    visit: needs.visit ?? "no",
  });
  const on = new Set<ModuleKey>();
  for (const [key, value] of Object.entries(derived.preferences)) {
    if (value) on.add(key as ModuleKey);
  }
  if (derived.cycleTracking) on.add("cycle");
  const alwaysOn = new Set<ModuleKey>(ONBOARDING_ALWAYS_ON_MODULES);
  // The registry's own merge rule decides what a derivation puts at `false`,
  // so this screen never restates it. It is asked with nothing to spare —
  // no stored preference, no domain holding rows — because that is the
  // record the confirm screen is looking at on a first run, and it is the
  // maximum the completion can take away. What the merge would spare on a
  // re-run (a module switched on by hand, one holding data) it spares
  // server-side, so this list can only ever be longer than what happens,
  // never shorter, and the sentence beside it says how to get one back.
  const afterDerivation = mergeDerivedModulePreferences(
    {},
    derived.preferences,
    new Set<string>(),
  );
  return {
    chosen: MODULE_KEYS.filter((key) => on.has(key) && !alwaysOn.has(key)),
    alwaysOn: MODULE_KEYS.filter((key) => alwaysOn.has(key)),
    wouldSwitchOff: MODULE_KEYS.filter(
      (key) =>
        !alwaysOn.has(key) &&
        current[key] === true &&
        afterDerivation[key] === false,
    ),
  };
}
