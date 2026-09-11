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

describe("confirmedModules — what leaves the navigation", () => {
  const noMedication = {
    ...emptyOnboardingNeeds(),
    recordTarget: "me" as const,
    areas: ["sleep" as const],
    medication: "no" as const,
    visit: "no" as const,
  };

  it("names a module the answers do not ask for and the record shows today", () => {
    const { wouldSwitchOff } = confirmedModules(noMedication, {
      medications: true,
      doctorReport: true,
    });
    expect(wouldSwitchOff).toContain("medications");
    expect(wouldSwitchOff).toContain("doctorReport");
  });

  it("never names a module the answers switch on", () => {
    const { chosen, wouldSwitchOff } = confirmedModules(
      { ...noMedication, medication: "yes" },
      { medications: true },
    );
    expect(chosen).toContain("medications");
    expect(wouldSwitchOff).not.toContain("medications");
  });

  it("never names a module the record does not show today", () => {
    const { wouldSwitchOff } = confirmedModules(noMedication, {
      medications: false,
    });
    expect(wouldSwitchOff).not.toContain("medications");
    // Nothing is known about a module the payload does not carry, so the
    // screen says nothing about it.
    expect(confirmedModules(noMedication, {}).wouldSwitchOff).toEqual([]);
  });

  it("never names an always-on module, whatever the answers say", () => {
    const current = Object.fromEntries(
      ONBOARDING_ALWAYS_ON_MODULES.map((key) => [key, true]),
    );
    const { wouldSwitchOff } = confirmedModules(noMedication, current);
    for (const key of ONBOARDING_ALWAYS_ON_MODULES) {
      expect(wouldSwitchOff).not.toContain(key);
    }
  });

  it("is in registry order, like the list beside it", () => {
    const current = Object.fromEntries(
      OWNED_MODULE_KEYS.map((key) => [key, true]),
    );
    const { wouldSwitchOff } = confirmedModules(noMedication, current);
    expect(wouldSwitchOff).toEqual(
      OWNED_MODULE_KEYS.filter((key) => wouldSwitchOff.includes(key)),
    );
    expect(wouldSwitchOff.length).toBeGreaterThan(0);
  });
});
