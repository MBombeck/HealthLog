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
}

export function confirmedModules(needs: OnboardingNeeds): ConfirmedModules {
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
  return {
    chosen: MODULE_KEYS.filter((key) => on.has(key) && !alwaysOn.has(key)),
    alwaysOn: MODULE_KEYS.filter((key) => alwaysOn.has(key)),
  };
}
