/**
 * v1.39 (C2) — the confirm screen's list is the registry's derivation and
 * nothing else.
 */
import { describe, expect, it } from "vitest";

import {
  deriveOnboardingModuleDefaults,
  ONBOARDING_ALWAYS_ON_MODULES,
  OWNED_MODULE_KEYS,
} from "@/lib/modules/registry";

import { confirmedModules } from "../confirm-summary";
import { emptyOnboardingNeeds } from "../needs";

describe("confirmedModules", () => {
  it("lists exactly what the derivation switches on, the always-on trio aside", () => {
    const needs = {
      ...emptyOnboardingNeeds(),
      recordTarget: "me" as const,
      areas: ["glucose" as const, "sleep" as const],
      medication: "yes" as const,
      visit: "within-a-month" as const,
    };
    const derived = deriveOnboardingModuleDefaults(needs);
    const expected = OWNED_MODULE_KEYS.filter(
      (key) =>
        derived.preferences[key] && !ONBOARDING_ALWAYS_ON_MODULES.includes(key),
    );
    const { chosen, alwaysOn } = confirmedModules(needs);
    expect(chosen).toEqual(expected);
    expect(chosen).toContain("medications");
    expect(chosen).toContain("doctorReport");
    // Registry order, so the two lists read in the same order everywhere.
    expect(alwaysOn).toEqual(
      OWNED_MODULE_KEYS.filter((key) =>
        ONBOARDING_ALWAYS_ON_MODULES.includes(key),
      ),
    );
  });

  it("names cycle when the area was ticked, though the map never owns it", () => {
    const { chosen } = confirmedModules({
      ...emptyOnboardingNeeds(),
      recordTarget: "me",
      areas: ["cycle"],
    });
    expect(chosen).toContain("cycle");
  });

  it("reads a skipped question as the route does — nothing switched on for it", () => {
    const { chosen } = confirmedModules({
      ...emptyOnboardingNeeds(),
      recordTarget: "me",
    });
    expect(chosen).not.toContain("medications");
    expect(chosen).not.toContain("doctorReport");
  });

  it("switches on the immunization log for a record somebody else runs", () => {
    expect(
      confirmedModules({
        ...emptyOnboardingNeeds(),
        recordTarget: "someone-else",
      }).chosen,
    ).toContain("vaccinations");
  });
});
