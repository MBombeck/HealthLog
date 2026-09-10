/**
 * v1.39 (C1) — the needs → modules mapping, and the merge that protects a
 * decision somebody already made.
 *
 * The mapping is the one piece of the flow with a consequence that outlives
 * the screens: a module switched off here disappears from the navigation until
 * somebody finds it again in Settings. So the properties below are stated as
 * properties over the whole registry rather than as a table of examples — a
 * module key added to `MODULE_KEYS` next year is covered by them on the day it
 * lands, and an area that stops naming anything fails here rather than
 * shipping as a chip with no effect.
 */
import { describe, expect, it } from "vitest";

import {
  deriveOnboardingModuleDefaults,
  isModuleKey,
  mergeDerivedModulePreferences,
  MODULE_REGISTRY,
  ONBOARDING_ALWAYS_ON_MODULES,
  ONBOARDING_AREA_KEYS,
  ONBOARDING_AREA_MODULES,
  OWNED_MODULE_KEYS,
  type OnboardingModuleNeeds,
} from "../registry";

/** A record with nothing in it — the state a first setup describes. */
const NO_DATA: ReadonlySet<string> = new Set();

function needs(
  overrides: Partial<OnboardingModuleNeeds> = {},
): OnboardingModuleNeeds {
  return {
    recordTarget: "me",
    areas: [],
    medication: "no",
    visit: "no",
    ...overrides,
  };
}

describe("the area → module map", () => {
  it("gives every area at least one module", () => {
    expect(ONBOARDING_AREA_KEYS.length).toBe(9);
    for (const area of ONBOARDING_AREA_KEYS) {
      expect(
        ONBOARDING_AREA_MODULES[area]?.length ?? 0,
        `area \`${area}\` names no module, so ticking it changes nothing`,
      ).toBeGreaterThan(0);
    }
  });

  it("names only real module keys", () => {
    for (const area of ONBOARDING_AREA_KEYS) {
      for (const key of ONBOARDING_AREA_MODULES[area]) {
        expect(isModuleKey(key), `\`${key}\` is not a module key`).toBe(true);
      }
    }
  });

  it("never names the Coach, which the flow deliberately does not offer", () => {
    const named = ONBOARDING_AREA_KEYS.flatMap(
      (area) => ONBOARDING_AREA_MODULES[area],
    );
    expect(named).not.toContain("coach");
  });
});

describe("deriveOnboardingModuleDefaults", () => {
  it("answers for every directly-owned module and for none of the delegated ones", () => {
    const derived = deriveOnboardingModuleDefaults(needs());
    expect(Object.keys(derived.preferences).sort()).toEqual(
      [...OWNED_MODULE_KEYS].sort(),
    );
    expect(derived.preferences).not.toHaveProperty("cycle");
    expect(derived.preferences).not.toHaveProperty("coach");
    for (const key of OWNED_MODULE_KEYS) {
      expect(MODULE_REGISTRY[key].delegatesTo).toBeUndefined();
    }
  });

  it("keeps the always-on modules on however the questions are answered", () => {
    const answers: OnboardingModuleNeeds[] = [
      needs(),
      needs({ areas: [...ONBOARDING_AREA_KEYS], medication: "yes" }),
      needs({ recordTarget: "someone-else", visit: "within-a-month" }),
      needs({ recordTarget: "both", medication: "sometimes", visit: "later" }),
    ];
    for (const answer of answers) {
      const { preferences } = deriveOnboardingModuleDefaults(answer);
      for (const key of ONBOARDING_ALWAYS_ON_MODULES) {
        expect(
          preferences[key as keyof typeof preferences],
          `always-on module \`${key}\` was derived off`,
        ).toBe(true);
      }
    }
  });

  it("switches on exactly what the chosen areas name", () => {
    const { preferences, cycleTracking } = deriveOnboardingModuleDefaults(
      needs({ areas: ["glucose", "sleep", "mood"] }),
    );
    expect(preferences.glucose).toBe(true);
    expect(preferences.sleep).toBe(true);
    expect(preferences.recovery).toBe(true);
    expect(preferences.mood).toBe(true);
    expect(preferences.mentalHealth).toBe(true);
    expect(preferences.labs).toBe(false);
    expect(preferences.workouts).toBe(false);
    expect(preferences.illness).toBe(false);
    expect(cycleTracking).toBe(false);
  });

  it("reports the cycle area separately, because the module blob does not own it", () => {
    expect(deriveOnboardingModuleDefaults(needs({ areas: ["cycle"] }))).toEqual(
      expect.objectContaining({ cycleTracking: true }),
    );
    expect(deriveOnboardingModuleDefaults(needs()).cycleTracking).toBe(false);
  });

  it("follows the medication answer", () => {
    for (const answer of ["yes", "sometimes"] as const) {
      expect(
        deriveOnboardingModuleDefaults(needs({ medication: answer }))
          .preferences.medications,
      ).toBe(true);
    }
    expect(
      deriveOnboardingModuleDefaults(needs({ medication: "no" })).preferences
        .medications,
    ).toBe(false);
  });

  it("switches the doctor report on for any visit that is actually coming", () => {
    for (const visit of ["within-a-month", "later"] as const) {
      expect(
        deriveOnboardingModuleDefaults(needs({ visit })).preferences
          .doctorReport,
      ).toBe(true);
    }
    expect(
      deriveOnboardingModuleDefaults(needs({ visit: "no" })).preferences
        .doctorReport,
    ).toBe(false);
  });

  it("switches the immunization log on for a record somebody else runs", () => {
    for (const recordTarget of ["someone-else", "both"] as const) {
      expect(
        deriveOnboardingModuleDefaults(needs({ recordTarget })).preferences
          .vaccinations,
      ).toBe(true);
    }
    expect(
      deriveOnboardingModuleDefaults(needs({ recordTarget: "me" })).preferences
        .vaccinations,
    ).toBe(false);
  });

  it("leaves the opt-in surfaces off unless something asks for them", () => {
    const { preferences } = deriveOnboardingModuleDefaults(
      needs({ areas: [...ONBOARDING_AREA_KEYS] }),
    );
    expect(preferences.mcp).toBe(false);
    expect(preferences.nutrients).toBe(false);
    expect(preferences.environment).toBe(false);
  });
});

describe("mergeDerivedModulePreferences", () => {
  it("never turns off a module the person switched on by hand", () => {
    const { preferences } = deriveOnboardingModuleDefaults(needs());
    expect(preferences.mcp).toBe(false);
    expect(preferences.labs).toBe(false);

    const merged = mergeDerivedModulePreferences(
      { mcp: true, labs: true },
      preferences,
      NO_DATA,
    );
    expect(merged.mcp).toBe(true);
    expect(merged.labs).toBe(true);
  });

  it("does turn off a module the record only had by default", () => {
    const { preferences } = deriveOnboardingModuleDefaults(needs());
    const merged = mergeDerivedModulePreferences({}, preferences, NO_DATA);
    expect(merged.labs).toBe(false);
    expect(merged.workouts).toBe(false);
  });

  it("switches on what the answers named even where the record had it off", () => {
    const { preferences } = deriveOnboardingModuleDefaults(
      needs({ areas: ["labs"] }),
    );
    const merged = mergeDerivedModulePreferences(
      { labs: false },
      preferences,
      NO_DATA,
    );
    expect(merged.labs).toBe(true);
  });

  it("drops a stored key that is not a module", () => {
    const { preferences } = deriveOnboardingModuleDefaults(needs());
    const merged = mergeDerivedModulePreferences(
      { weight: false, nonsense: true },
      preferences,
      NO_DATA,
    );
    expect(merged).not.toHaveProperty("weight");
    expect(merged).not.toHaveProperty("nonsense");
  });

  it("never switches off a domain the record already holds rows in", () => {
    const { preferences } = deriveOnboardingModuleDefaults(needs());
    expect(preferences.labs).toBe(false);
    expect(preferences.mood).toBe(false);

    // An established record with no stored preference at all: default-on, and
    // nobody ever touched the toggle. A derived `false` would take the nav
    // entry, the dashboard widget and the settings entry away from a domain
    // holding years of rows, so the key is left exactly as it was — and
    // absence means on.
    const merged = mergeDerivedModulePreferences(
      {},
      preferences,
      new Set(["labs", "mood"]),
    );
    expect(merged).not.toHaveProperty("labs");
    expect(merged).not.toHaveProperty("mood");
    expect(merged.workouts).toBe(false);
  });

  it("keeps a stored explicit off where the domain holds rows", () => {
    const { preferences } = deriveOnboardingModuleDefaults(needs());
    // Somebody switched labs off by hand and still has old results. The flow
    // must not switch it back on, and must not restate the decision either.
    const merged = mergeDerivedModulePreferences(
      { labs: false },
      preferences,
      new Set(["labs"]),
    );
    expect(merged.labs).toBe(false);
  });

  it("still switches a domain ON when the answers name it, rows or not", () => {
    const { preferences } = deriveOnboardingModuleDefaults(
      needs({ areas: ["labs"] }),
    );
    const merged = mergeDerivedModulePreferences(
      {},
      preferences,
      new Set(["labs"]),
    );
    expect(merged.labs).toBe(true);
  });

  it("leaves the two delegated keys alone in both directions", () => {
    const { preferences } = deriveOnboardingModuleDefaults(
      needs({ areas: ["cycle"] }),
    );
    const merged = mergeDerivedModulePreferences({}, preferences, NO_DATA);
    expect(merged).not.toHaveProperty("cycle");
    expect(merged).not.toHaveProperty("coach");
  });
});
