/**
 * v1.18.0 — module enable/disable gate resolver.
 *
 * Exercises the PURE resolver (`resolveModuleEnabled`) + the registry
 * helpers, so the disabled-allowlist + delegation logic is asserted
 * without a DB. The async `isModuleEnabled` / `requireModuleEnabled`
 * thin wrappers are covered by the route test.
 */
import { describe, it, expect } from "vitest";

import {
  resolveModuleEnabled,
  normalisePrefs,
  MODULE_DISABLED_ERROR_CODE,
  type ModuleGateInputs,
} from "../gate";
import {
  resolveOperatorAvailability,
  type OperatorModuleAvailability,
} from "../operator-availability";
import {
  isCoreDomain,
  isCodeDisabledModule,
  isModuleKey,
  isOptInModule,
  moduleDelegatesTo,
  MODULE_KEYS,
  CORE_DOMAIN_KEYS,
} from "../registry";

function inputs(over: Partial<ModuleGateInputs> = {}): ModuleGateInputs {
  return {
    gender: null,
    disableCoach: false,
    modulePreferences: {},
    cycleTrackingEnabled: null,
    ...over,
  };
}

/** Operator availability map; default-available, overlay disables. */
function operator(
  disabled: Partial<Record<string, boolean>> = {},
): OperatorModuleAvailability {
  return resolveOperatorAvailability(disabled);
}

/** All-available operator layer for the user-layer-focused cases. */
const ALL_AVAILABLE = operator();

describe("resolveModuleEnabled — disabled allowlist (default-on)", () => {
  it("enables a module when no preference is recorded", () => {
    expect(resolveModuleEnabled("mood", inputs(), true, ALL_AVAILABLE)).toBe(
      true,
    );
    expect(resolveModuleEnabled("sleep", inputs(), true, ALL_AVAILABLE)).toBe(
      true,
    );
    expect(resolveModuleEnabled("labs", inputs(), true, ALL_AVAILABLE)).toBe(
      true,
    );
  });

  it("enables a module when the key is present and true", () => {
    expect(
      resolveModuleEnabled(
        "mood",
        inputs({ modulePreferences: { mood: true } }),
        true,
        ALL_AVAILABLE,
      ),
    ).toBe(true);
  });

  it("disables a module ONLY on an explicit false", () => {
    expect(
      resolveModuleEnabled(
        "glucose",
        inputs({ modulePreferences: { glucose: false } }),
        true,
        ALL_AVAILABLE,
      ),
    ).toBe(false);
  });

  it("isolates per-module: disabling one leaves siblings on", () => {
    const i = inputs({ modulePreferences: { workouts: false } });
    expect(resolveModuleEnabled("workouts", i, true, ALL_AVAILABLE)).toBe(
      false,
    );
    expect(resolveModuleEnabled("recovery", i, true, ALL_AVAILABLE)).toBe(true);
    expect(resolveModuleEnabled("labs", i, true, ALL_AVAILABLE)).toBe(true);
  });
});

describe("resolveModuleEnabled — illness module (default-on, opt-out)", () => {
  it("is ON when no preference is recorded (default-on like its siblings)", () => {
    expect(resolveModuleEnabled("illness", inputs(), true, ALL_AVAILABLE)).toBe(
      true,
    );
  });

  it("stays ON on an explicit true", () => {
    expect(
      resolveModuleEnabled(
        "illness",
        inputs({ modulePreferences: { illness: true } }),
        true,
        ALL_AVAILABLE,
      ),
    ).toBe(true);
  });

  it("is OFF only on an explicit false (opt-out)", () => {
    expect(
      resolveModuleEnabled(
        "illness",
        inputs({ modulePreferences: { illness: false } }),
        true,
        ALL_AVAILABLE,
      ),
    ).toBe(false);
  });

  it("operator-off short-circuits even when the user enabled it", () => {
    expect(
      resolveModuleEnabled(
        "illness",
        inputs({ modulePreferences: { illness: true } }),
        true,
        operator({ illness: false }),
      ),
    ).toBe(false);
  });

  it("matches its sibling default-on modules", () => {
    const i = inputs({ modulePreferences: {} });
    expect(resolveModuleEnabled("illness", i, true, ALL_AVAILABLE)).toBe(true);
    expect(resolveModuleEnabled("mood", i, true, ALL_AVAILABLE)).toBe(true);
    expect(resolveModuleEnabled("labs", i, true, ALL_AVAILABLE)).toBe(true);
  });
});

describe("resolveModuleEnabled — cycle delegation", () => {
  it("ignores the module blob and reads the cycle gate (gender-derived)", () => {
    // Even a crafted `{ cycle: false }` blob cannot override the real
    // FEMALE-derived enablement — the gate delegates to isCycleEnabled.
    const i = inputs({
      gender: "FEMALE",
      cycleTrackingEnabled: null,
      modulePreferences: { cycle: false },
    });
    expect(resolveModuleEnabled("cycle", i, true, ALL_AVAILABLE)).toBe(true);
  });

  it("respects the cycle toggle when set", () => {
    expect(
      resolveModuleEnabled(
        "cycle",
        inputs({ gender: "MALE", cycleTrackingEnabled: true }),
        true,
        ALL_AVAILABLE,
      ),
    ).toBe(true);
    expect(
      resolveModuleEnabled(
        "cycle",
        inputs({ gender: "FEMALE", cycleTrackingEnabled: false }),
        true,
        ALL_AVAILABLE,
      ),
    ).toBe(false);
  });

  it("a MALE account with a null toggle is cycle-disabled", () => {
    expect(
      resolveModuleEnabled(
        "cycle",
        inputs({ gender: "MALE" }),
        true,
        ALL_AVAILABLE,
      ),
    ).toBe(false);
  });
});

describe("resolveModuleEnabled — coach delegation (two-layer)", () => {
  it("is enabled only when the operator master flag AND !disableCoach", () => {
    expect(
      resolveModuleEnabled(
        "coach",
        inputs({ disableCoach: false }),
        true,
        ALL_AVAILABLE,
      ),
    ).toBe(true);
  });

  it("is disabled when the per-user opt-out is set", () => {
    expect(
      resolveModuleEnabled(
        "coach",
        inputs({ disableCoach: true }),
        true,
        ALL_AVAILABLE,
      ),
    ).toBe(false);
  });

  it("is disabled when the operator master flag is off", () => {
    expect(
      resolveModuleEnabled(
        "coach",
        inputs({ disableCoach: false }),
        false,
        ALL_AVAILABLE,
      ),
    ).toBe(false);
  });

  it("ignores the module blob for coach", () => {
    // A crafted `{ coach: true }` cannot re-enable against a disabled
    // operator flag or a user opt-out.
    const i = inputs({
      disableCoach: true,
      modulePreferences: { coach: true },
    });
    expect(resolveModuleEnabled("coach", i, true, ALL_AVAILABLE)).toBe(false);
  });
});

describe("insights — narrative layer, not a delegated module", () => {
  it("resolves from the disabled allowlist like the other secondary domains", () => {
    expect(
      resolveModuleEnabled("insights", inputs(), true, ALL_AVAILABLE),
    ).toBe(true);
    expect(
      resolveModuleEnabled(
        "insights",
        inputs({ modulePreferences: { insights: false } }),
        true,
        ALL_AVAILABLE,
      ),
    ).toBe(false);
  });

  it("is not delegated (no double source of truth marker)", () => {
    expect(moduleDelegatesTo("insights")).toBeUndefined();
  });
});

describe("resolveModuleEnabled — operator layer (two-layer AND)", () => {
  it("operator-off ⇒ false even when the user has it on", () => {
    // User layer fully on (no opt-out), operator disables it server-wide.
    expect(
      resolveModuleEnabled(
        "mood",
        inputs({ modulePreferences: { mood: true } }),
        true,
        operator({ mood: false }),
      ),
    ).toBe(false);
  });

  it("operator-on + user-off ⇒ false", () => {
    expect(
      resolveModuleEnabled(
        "glucose",
        inputs({ modulePreferences: { glucose: false } }),
        true,
        operator({ glucose: true }),
      ),
    ).toBe(false);
  });

  it("operator-on + user-on ⇒ true", () => {
    expect(
      resolveModuleEnabled("labs", inputs(), true, operator({ labs: true })),
    ).toBe(true);
  });

  it("the operator's Coach switch short-circuits the coach module regardless of user state", () => {
    // The Coach's operator layer is the Coach switch, carried into the
    // availability map; no per-user state can reopen it.
    expect(
      resolveModuleEnabled(
        "coach",
        inputs({ disableCoach: false }),
        true,
        resolveOperatorAvailability({}, false),
      ),
    ).toBe(false);
  });

  it("ignores a coach key left in the availability blob", () => {
    // Folded into the Coach switch; only the switch decides.
    expect(resolveOperatorAvailability({ coach: false }, true).coach).toBe(
      true,
    );
    expect(resolveOperatorAvailability({ coach: true }, false).coach).toBe(
      false,
    );
  });

  it("operator-off short-circuits cycle even for a FEMALE account", () => {
    expect(
      resolveModuleEnabled(
        "cycle",
        inputs({ gender: "FEMALE", cycleTrackingEnabled: true }),
        true,
        operator({ cycle: false }),
      ),
    ).toBe(false);
  });

  it("isolates per-module: operator disabling one leaves siblings available", () => {
    const op = operator({ workouts: false });
    expect(resolveModuleEnabled("workouts", inputs(), true, op)).toBe(false);
    expect(resolveModuleEnabled("recovery", inputs(), true, op)).toBe(true);
    expect(resolveModuleEnabled("sleep", inputs(), true, op)).toBe(true);
  });
});

describe("resolveModuleEnabled — mcp module (opt-in, default-OFF)", () => {
  it("is OFF when no preference is recorded (inverse of the default-on siblings)", () => {
    expect(resolveModuleEnabled("mcp", inputs(), false, ALL_AVAILABLE)).toBe(
      false,
    );
  });

  it("stays OFF on an explicit false", () => {
    expect(
      resolveModuleEnabled(
        "mcp",
        inputs({ modulePreferences: { mcp: false } }),
        false,
        ALL_AVAILABLE,
      ),
    ).toBe(false);
  });

  it("turns ON only on an explicit true (opt-in)", () => {
    expect(
      resolveModuleEnabled(
        "mcp",
        inputs({ modulePreferences: { mcp: true } }),
        false,
        ALL_AVAILABLE,
      ),
    ).toBe(true);
  });

  it("operator-off short-circuits even when the user opted in", () => {
    expect(
      resolveModuleEnabled(
        "mcp",
        inputs({ modulePreferences: { mcp: true } }),
        false,
        operator({ mcp: false }),
      ),
    ).toBe(false);
  });
});

describe("registry — opt-in marker", () => {
  // v1.29.1 — a fresh install defaults every TRACKING module on so the app is
  // usable without enabling each one. Only two modules stay opt-in (ship dark),
  // because each opens a channel that must be turned on deliberately:
  // `mcp` (the remote external-assistant endpoint — a new attack surface) and
  // `nutrients` (supplement-pattern intake synced from the phone's health
  // store — the device-side HealthKit permission is not visible consent to
  // server/AI-side storage, so ingest refuses while off). Everything else —
  // including `environment`, `inboundDocuments`, and `mentalHealth` — is the
  // default-on disabled-allowlist now; their egress channels (the weather
  // fetch, the document AI-read, the AI Coach exposure) are separately gated
  // and stay off until explicitly configured.
  //
  // v1.42 — `timeline` joins them for a different reason: it opens no channel,
  // but it is a new way of reading the whole record, and the readiness
  // inventory shown when it is switched on is meant to be the first contact.
  const OPT_IN_KEYS = new Set(["mcp", "nutrients", "timeline"]);

  it("marks only the egress-surface modules opt-in (every other is default-on)", () => {
    for (const key of MODULE_KEYS) {
      expect(isOptInModule(key)).toBe(OPT_IN_KEYS.has(key));
    }
  });
});

describe("resolveModuleEnabled — inboundDocuments module (document vault)", () => {
  // v1.29.1 — default-on now (a fresh install can store + organise documents
  // out of the box). The AI READ of a document is a separate per-user opt-in
  // (`documentsAutoAiRead`), so default-on carries no silent egress. Normal
  // disabled-allowlist resolution: ON unless an explicit `false`, operator wins.
  it("is no longer flagged as code-disabled in the registry", () => {
    expect(isCodeDisabledModule("inboundDocuments")).toBe(false);
  });

  it("is ON when no preference is recorded (default-on like its siblings)", () => {
    expect(
      resolveModuleEnabled("inboundDocuments", inputs(), false, ALL_AVAILABLE),
    ).toBe(true);
  });

  it("is OFF when the user opted out", () => {
    expect(
      resolveModuleEnabled(
        "inboundDocuments",
        inputs({ modulePreferences: { inboundDocuments: false } }),
        false,
        ALL_AVAILABLE,
      ),
    ).toBe(false);
  });

  it("stays OFF when the operator disabled it, even without a user opt-out", () => {
    expect(
      resolveModuleEnabled(
        "inboundDocuments",
        inputs(),
        false,
        operator({ inboundDocuments: false }),
      ),
    ).toBe(false);
  });
});

describe("resolveOperatorAvailability — disabled allowlist (default-available)", () => {
  it("treats null / non-object / array as all-available", () => {
    for (const raw of [null, undefined, "nope", ["mood"]]) {
      const map = resolveOperatorAvailability(raw);
      for (const key of MODULE_KEYS) {
        expect(map[key]).toBe(true);
      }
    }
  });

  it("disables a module ONLY on an explicit false; junk + true read as available", () => {
    const map = resolveOperatorAvailability({
      mood: false,
      sleep: true,
      glucose: "yes",
      labs: 0,
    });
    expect(map.mood).toBe(false);
    expect(map.sleep).toBe(true);
    expect(map.glucose).toBe(true);
    expect(map.labs).toBe(true);
  });

  it("returns an entry for every toggleable module", () => {
    const map = resolveOperatorAvailability({});
    for (const key of MODULE_KEYS) {
      expect(typeof map[key]).toBe("boolean");
    }
  });
});

describe("normalisePrefs — fail-open coercion", () => {
  it("treats null / non-object / array as empty (all-on)", () => {
    expect(normalisePrefs(null)).toEqual({});
    expect(normalisePrefs(undefined)).toEqual({});
    expect(normalisePrefs("nope")).toEqual({});
    expect(normalisePrefs(["mood"])).toEqual({});
  });

  it("keeps only boolean values, dropping junk entries", () => {
    expect(
      normalisePrefs({ mood: false, sleep: "yes", glucose: 0, labs: true }),
    ).toEqual({ mood: false, labs: true });
  });
});

describe("registry — core domains can never be disabled", () => {
  it("the three core domains are not toggleable module keys", () => {
    for (const core of CORE_DOMAIN_KEYS) {
      expect(isModuleKey(core)).toBe(false);
      expect(isCoreDomain(core)).toBe(true);
    }
  });

  it("a crafted core-domain key is inert (never read as a module)", () => {
    // `weight: false` in the blob can't matter: weight is not a ModuleKey,
    // so the gate never consults it. The resolver only runs for the declared
    // toggleable keys. v1.18.1 (D3) — medications graduated to a toggleable
    // module, so it IS a ModuleKey now (weight / bp / pulse stay core).
    expect(isModuleKey("weight")).toBe(false);
    expect(isModuleKey("medications")).toBe(true);
  });

  it("every toggleable key is a known module and not a core domain", () => {
    for (const key of MODULE_KEYS) {
      expect(isModuleKey(key)).toBe(true);
      expect(isCoreDomain(key)).toBe(false);
    }
  });
});

describe("wire contract", () => {
  it("exports the iOS-classifier errorCode", () => {
    expect(MODULE_DISABLED_ERROR_CODE).toBe("module.disabled");
  });
});
