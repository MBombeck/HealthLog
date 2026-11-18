/**
 * The capability resolver, exhaustively.
 *
 * Three tables. Each reason is produced on its own for every capability it can
 * apply to. Every ordered pair of reasons applied together reports the outer
 * one, which is the precedence contract clients are promised. And the cases
 * where the layers interact (provider order, document picks, consent kinds,
 * the "either module" capability) are pinned one by one.
 *
 * Mutation check: swapping two entries of `AI_UNAVAILABLE_REASONS` turns the
 * pair table red, naming the pair; dropping a layer from `resolveAiCapability`
 * turns its single-reason row red.
 */
import { describe, expect, it } from "vitest";

import {
  resolveAiBlock,
  resolveAiCapabilities,
  resolveAiCapability,
  resolveAiProviderState,
  type AiCapabilityInputs,
  type ProviderEntryPresence,
} from "../resolve";
import {
  AI_CAPABILITIES,
  AI_CAPABILITY_KEYS,
  AI_OPT_OUT_MODULES,
  AI_OPERATOR_SWITCHES,
  AI_UNAVAILABLE_REASONS,
  type AiCapabilityKey,
  type AiUnavailableReason,
} from "../types";
import { MODULE_KEYS, type ModuleKey } from "@/lib/modules/registry";
import type { ModuleAccessState } from "@/lib/sharing/module-disclosure";

function allEnabled(): Record<ModuleKey, ModuleAccessState> {
  const out = {} as Record<ModuleKey, ModuleAccessState>;
  for (const key of MODULE_KEYS) out[key] = "enabled";
  return out;
}

/** Everything on, a local vision model, no receipts: every capability is available. */
function baseline(): AiCapabilityInputs {
  return {
    switches: {
      enabled: true,
      coach: true,
      briefing: true,
      insightStatus: true,
      documentAi: true,
    },
    moduleAccess: allEnabled(),
    providerWorkAdmitted: true,
    provider: {
      entries: [{ providerType: "local", vision: true }],
      localOcrEnabled: false,
      managedBy: "local",
    },
    activeConsentKinds: new Set(),
    recordKind: "self",
    usageLevel: "full",
  };
}

type Perturb = (inputs: AiCapabilityInputs, key: AiCapabilityKey) => boolean;

/**
 * One way to produce each reason (bar `check_failed`, which is null inputs).
 * Returns false when the reason cannot apply to the capability, for example a
 * module reason on a capability no module owns.
 */
const PERTURB: Record<Exclude<AiUnavailableReason, "check_failed">, Perturb> = {
  operator_disabled: (inputs, key) => {
    inputs.switches = {
      ...inputs.switches,
      [AI_CAPABILITIES[key].operatorSwitch]: false,
    };
    return true;
  },
  not_permitted_for_record: (inputs) => {
    inputs.providerWorkAdmitted = false;
    return true;
  },
  module_disabled: (inputs, key) => {
    const { keys } = AI_CAPABILITIES[key].modules;
    if (keys.length === 0) return false;
    const access = { ...inputs.moduleAccess };
    for (const moduleKey of keys) access[moduleKey] = "not_granted";
    inputs.moduleAccess = access;
    return true;
  },
  user_disabled: (inputs, key) => {
    const { mode, keys } = AI_CAPABILITIES[key].modules;
    const optOuts = keys.filter((moduleKey) =>
      AI_OPT_OUT_MODULES.has(moduleKey),
    );
    if (optOuts.length === 0) return false;
    // An "any" capability needs every path closed.
    if (mode === "any" && optOuts.length !== keys.length) return false;
    const access = { ...inputs.moduleAccess };
    for (const moduleKey of optOuts) {
      if (access[moduleKey] === "enabled") access[moduleKey] = "disabled";
    }
    inputs.moduleAccess = access;
    return true;
  },
  usage_level: (inputs, key) => {
    if (AI_CAPABILITIES[key].minUsageLevel === undefined) return false;
    inputs.usageLevel = "frugal";
    return true;
  },
  no_provider: (inputs) => {
    inputs.provider = { ...inputs.provider, entries: [], managedBy: null };
    return true;
  },
  consent_required: (inputs) => {
    inputs.provider = {
      ...inputs.provider,
      entries: [{ providerType: "admin-openai", vision: true }],
      managedBy: "server",
    };
    inputs.activeConsentKinds = new Set();
    return true;
  },
};

const PERTURBABLE = AI_UNAVAILABLE_REASONS.filter(
  (reason): reason is Exclude<AiUnavailableReason, "check_failed"> =>
    reason !== "check_failed",
);

describe("baseline", () => {
  it("makes every capability available", () => {
    const resolved = resolveAiCapabilities(baseline());
    for (const key of AI_CAPABILITY_KEYS) {
      expect(resolved[key], key).toEqual({
        available: true,
        reason: null,
        onDeviceAllowed: true,
      });
    }
  });

  it("publishes every capability key and nothing else", () => {
    expect(Object.keys(resolveAiCapabilities(baseline())).sort()).toEqual(
      [...AI_CAPABILITY_KEYS].sort(),
    );
  });
});

describe("each reason on its own", () => {
  it("fails closed to check_failed when the inputs could not be loaded", () => {
    const resolved = resolveAiCapabilities(null);
    for (const key of AI_CAPABILITY_KEYS) {
      expect(resolved[key]).toEqual({
        available: false,
        reason: "check_failed",
        onDeviceAllowed: false,
      });
    }
  });

  for (const reason of PERTURBABLE) {
    for (const key of AI_CAPABILITY_KEYS) {
      const inputs = baseline();
      if (!PERTURB[reason](inputs, key)) continue;
      it(`${key}: ${reason}`, () => {
        expect(resolveAiCapability(key, inputs).reason).toBe(reason);
      });
    }
  }

  it("covers every reason for at least one capability", () => {
    for (const reason of PERTURBABLE) {
      const applies = AI_CAPABILITY_KEYS.some((key) =>
        PERTURB[reason](baseline(), key),
      );
      expect(applies, reason).toBe(true);
    }
  });
});

describe("every pair of reasons reports the outer one", () => {
  let checked = 0;
  for (let i = 0; i < PERTURBABLE.length; i++) {
    for (let j = i + 1; j < PERTURBABLE.length; j++) {
      const outer = PERTURBABLE[i]!;
      const inner = PERTURBABLE[j]!;
      for (const key of AI_CAPABILITY_KEYS) {
        const inputs = baseline();
        // Inner first: the provider perturbations overwrite the same field,
        // and the outer one has to be the one that sticks.
        if (!PERTURB[inner](inputs, key)) continue;
        if (!PERTURB[outer](inputs, key)) continue;
        checked++;
        it(`${key}: ${outer} over ${inner}`, () => {
          expect(resolveAiCapability(key, inputs).reason).toBe(outer);
        });
      }
    }
  }

  it("ran a non-trivial pair table", () => {
    expect(checked).toBeGreaterThan(100);
  });
});

describe("the operator layer", () => {
  it("master off forces every capability off, whatever else is wrong", () => {
    const inputs = baseline();
    inputs.switches = { ...inputs.switches, enabled: false };
    inputs.providerWorkAdmitted = false;
    inputs.provider = { ...inputs.provider, entries: [] };
    const resolved = resolveAiCapabilities(inputs);
    for (const key of AI_CAPABILITY_KEYS) {
      expect(resolved[key].reason, key).toBe("operator_disabled");
    }
  });

  it("a sub-switch closes exactly the capabilities it covers", () => {
    for (const toggle of AI_OPERATOR_SWITCHES) {
      const inputs = baseline();
      inputs.switches = { ...inputs.switches, [toggle]: false };
      const resolved = resolveAiCapabilities(inputs);
      for (const key of AI_CAPABILITY_KEYS) {
        const covered = AI_CAPABILITIES[key].operatorSwitch === toggle;
        expect(resolved[key].available, `${toggle} → ${key}`).toBe(!covered);
      }
    }
  });

  it("reads operator module availability as an operator decision", () => {
    const inputs = baseline();
    inputs.moduleAccess = { ...inputs.moduleAccess, insights: "unavailable" };
    expect(resolveAiCapability("briefing", inputs).reason).toBe(
      "operator_disabled",
    );
  });
});

describe("the module layer", () => {
  it("reads the record's own switch on an opt-out module as the person's choice", () => {
    const inputs = baseline();
    inputs.moduleAccess = { ...inputs.moduleAccess, coach: "disabled" };
    expect(resolveAiCapability("coach", inputs).reason).toBe("user_disabled");
  });

  it("reads the record's own switch on any other module as module_disabled", () => {
    const inputs = baseline();
    inputs.moduleAccess = { ...inputs.moduleAccess, workouts: "disabled" };
    expect(resolveAiCapability("workoutInsights", inputs).reason).toBe(
      "module_disabled",
    );
    expect(resolveAiCapability("statusText", inputs).available).toBe(true);
  });

  it("closes workout notes when either of its two modules is off", () => {
    const inputs = baseline();
    inputs.moduleAccess = { ...inputs.moduleAccess, insights: "disabled" };
    expect(resolveAiCapability("workoutInsights", inputs).reason).toBe(
      "user_disabled",
    );
  });

  it("keeps the about-me questions while either consumer is on", () => {
    const inputs = baseline();
    inputs.moduleAccess = { ...inputs.moduleAccess, coach: "disabled" };
    expect(resolveAiCapability("aboutMeQuestions", inputs).available).toBe(
      true,
    );
    inputs.moduleAccess = {
      ...inputs.moduleAccess,
      coach: "enabled",
      insights: "disabled",
    };
    expect(resolveAiCapability("aboutMeQuestions", inputs).available).toBe(
      true,
    );
  });

  it("reports the reason nearest to available when both consumers are off", () => {
    const inputs = baseline();
    inputs.moduleAccess = {
      ...inputs.moduleAccess,
      coach: "not_granted",
      insights: "disabled",
    };
    expect(resolveAiCapability("aboutMeQuestions", inputs).reason).toBe(
      "user_disabled",
    );
  });

  it("gives medication extraction no owning module", () => {
    const inputs = baseline();
    const access = { ...inputs.moduleAccess };
    for (const key of MODULE_KEYS) access[key] = "disabled";
    inputs.moduleAccess = access;
    expect(resolveAiCapability("medicationExtract", inputs).available).toBe(
      true,
    );
  });
});

describe("provider presence per modality", () => {
  const openaiText: ProviderEntryPresence = {
    providerType: "openai",
    vision: false,
  };

  it("serves text from any entry and a document only from a vision entry", () => {
    const inputs = baseline();
    inputs.provider = { ...inputs.provider, entries: [openaiText] };
    inputs.activeConsentKinds = new Set(["ai_full"]);
    const resolved = resolveAiCapabilities(inputs);
    expect(resolved.statusText.available).toBe(true);
    expect(resolved.medicationExtract.available).toBe(true);
    expect(resolved.documentAi.reason).toBe("no_provider");
    expect(resolved.labsOcr.reason).toBe("no_provider");
  });

  it("lets a text provider read a document once in-browser OCR is on", () => {
    const inputs = baseline();
    inputs.provider = {
      ...inputs.provider,
      entries: [openaiText],
      localOcrEnabled: true,
    };
    inputs.activeConsentKinds = new Set(["ai_extraction"]);
    expect(resolveAiCapability("documentAi", inputs).available).toBe(true);
    expect(resolveAiCapability("labsOcr", inputs).available).toBe(true);
  });
});

describe("the consent layer", () => {
  it("needs no receipt for a person's own key on a self-snapshot capability", () => {
    const inputs = baseline();
    inputs.provider = {
      ...inputs.provider,
      entries: [{ providerType: "anthropic", vision: true }],
    };
    expect(resolveAiCapability("coach", inputs).available).toBe(true);
    expect(resolveAiCapability("briefing", inputs).available).toBe(true);
  });

  it("needs a receipt once the operator's key is anywhere in the chain", () => {
    const inputs = baseline();
    inputs.provider = {
      ...inputs.provider,
      entries: [
        { providerType: "anthropic", vision: true },
        { providerType: "admin-codex", vision: true },
      ],
    };
    expect(resolveAiCapability("coach", inputs).reason).toBe(
      "consent_required",
    );
  });

  it("needs a receipt for an Antigravity chain on a self-snapshot capability", () => {
    const inputs = baseline();
    inputs.provider = {
      ...inputs.provider,
      entries: [{ providerType: "antigravity", vision: false }],
    };
    expect(resolveAiCapability("coach", inputs).reason).toBe(
      "consent_required",
    );
    expect(resolveAiCapability("briefing", inputs).reason).toBe(
      "consent_required",
    );
  });

  it("matches kinds to groups, with ai_full covering all of them", () => {
    const inputs = baseline();
    inputs.provider = {
      ...inputs.provider,
      entries: [{ providerType: "admin-openai", vision: true }],
    };
    const cases: [string, AiCapabilityKey[], AiCapabilityKey[]][] = [
      [
        "ai_coach",
        ["coach", "aboutMeQuestions"],
        ["briefing", "statusText", "documentAi", "labsOcr"],
      ],
      [
        "ai_insights_only",
        ["briefing", "periodNarrative", "statusText", "aboutMeQuestions"],
        ["coach", "documentAi", "medicationExtract"],
      ],
      [
        "ai_extraction",
        ["documentAi", "labsOcr", "medicationExtract"],
        ["coach", "briefing", "statusText", "aboutMeQuestions"],
      ],
      ["ai_full", [...AI_CAPABILITY_KEYS], []],
    ];
    for (const [kind, open, closed] of cases) {
      inputs.activeConsentKinds = new Set([kind]);
      const resolved = resolveAiCapabilities(inputs);
      for (const key of open) {
        expect(resolved[key].available, `${kind} opens ${key}`).toBe(true);
      }
      for (const key of closed) {
        expect(resolved[key].reason, `${kind} leaves ${key}`).toBe(
          "consent_required",
        );
      }
    }
  });

  it("needs a receipt for any external document read, the person's own key included", () => {
    const inputs = baseline();
    inputs.provider = {
      ...inputs.provider,
      entries: [{ providerType: "anthropic", vision: true }],
    };
    expect(resolveAiCapability("documentAi", inputs).reason).toBe(
      "consent_required",
    );
    expect(resolveAiCapability("medicationExtract", inputs).reason).toBe(
      "consent_required",
    );
  });

  it("picks a document provider in document order and labs in chain order", () => {
    const inputs = baseline();
    // The ChatGPT-subscription path first in the chain, a local model behind it.
    inputs.provider = {
      ...inputs.provider,
      entries: [
        { providerType: "codex", vision: true },
        { providerType: "local", vision: true },
      ],
    };
    // Document order puts local first: nothing leaves the machine.
    expect(resolveAiCapability("documentAi", inputs).available).toBe(true);
    // The labs scan keeps the chain's own order and picks the external entry.
    expect(resolveAiCapability("labsOcr", inputs).reason).toBe(
      "consent_required",
    );
  });
});

describe("on-device permission", () => {
  it("follows the operator and the person, not the server provider or server consent", () => {
    const expected: Record<AiUnavailableReason, boolean> = {
      check_failed: false,
      operator_disabled: false,
      not_permitted_for_record: false,
      module_disabled: false,
      user_disabled: false,
      usage_level: false,
      no_provider: true,
      consent_required: true,
    };
    for (const reason of PERTURBABLE) {
      const inputs = baseline();
      // `usage_level` only applies to a capability with a minimum level.
      const key = reason === "usage_level" ? "supplementLabel" : "briefing";
      PERTURB[reason](inputs, key);
      expect(resolveAiCapability(key, inputs).onDeviceAllowed, reason).toBe(
        expected[reason],
      );
    }
    expect(resolveAiCapability("briefing", null).onDeviceAllowed).toBe(
      expected.check_failed,
    );
  });
});

describe("the provider block", () => {
  it("reports presence and origin", () => {
    expect(resolveAiProviderState(baseline())).toEqual({
      configured: true,
      managedBy: "local",
      canConfigure: true,
      responseTimeoutMs: 60_000,
    });
  });

  it("publishes the record's response-timeout setting as the effective timeout", () => {
    const inputs = baseline();
    inputs.provider = { ...inputs.provider, responseTimeoutSeconds: 420 };
    expect(resolveAiProviderState(inputs).responseTimeoutMs).toBe(420_000);
    inputs.provider = { ...inputs.provider, responseTimeoutSeconds: null };
    expect(resolveAiProviderState(inputs).responseTimeoutMs).toBe(60_000);
  });

  it("offers setup only on one's own record, and only with the master on", () => {
    for (const recordKind of ["shared", "managed"] as const) {
      const inputs = baseline();
      inputs.recordKind = recordKind;
      expect(resolveAiProviderState(inputs).canConfigure, recordKind).toBe(
        false,
      );
    }
    const inputs = baseline();
    inputs.switches = { ...inputs.switches, enabled: false };
    expect(resolveAiProviderState(inputs).canConfigure).toBe(false);
  });

  it("reports nothing configured when the inputs failed to load", () => {
    expect(resolveAiBlock(null).provider).toEqual({
      configured: false,
      managedBy: null,
      canConfigure: false,
      responseTimeoutMs: 60_000,
    });
  });
});

describe("the AI usage level (#1217)", () => {
  it("closes only the capabilities that need a higher level", () => {
    const inputs = baseline();
    inputs.usageLevel = "frugal";
    const resolved = resolveAiCapabilities(inputs);
    for (const key of AI_CAPABILITY_KEYS) {
      const needsMore = AI_CAPABILITIES[key].minUsageLevel !== undefined;
      expect(resolved[key].reason, key).toBe(needsMore ? "usage_level" : null);
    }
  });

  it("offers the label photo from standard up", () => {
    for (const [level, available] of [
      ["frugal", false],
      ["standard", true],
      ["full", true],
    ] as const) {
      const inputs = baseline();
      inputs.usageLevel = level;
      expect(
        resolveAiCapability("supplementLabel", inputs).available,
        level,
      ).toBe(available);
    }
  });

  it("ranks after the person's opt-out and before the provider", () => {
    const inputs = baseline();
    inputs.usageLevel = "frugal";
    inputs.provider = { ...inputs.provider, entries: [], managedBy: null };
    expect(resolveAiCapability("supplementLabel", inputs).reason).toBe(
      "usage_level",
    );
    inputs.moduleAccess = { ...inputs.moduleAccess, nutrients: "disabled" };
    expect(resolveAiCapability("supplementLabel", inputs).reason).toBe(
      "module_disabled",
    );
  });
});

describe("the standing consent (v1.43.2)", () => {
  function operatorOnly(baseUrl?: string | null): AiCapabilityInputs {
    const inputs = baseline();
    inputs.provider = {
      entries: [{ providerType: "admin-openai", vision: true }],
      localOcrEnabled: false,
      managedBy: "server",
      operatorKeyBaseUrl: baseUrl,
    };
    return inputs;
  }

  it("asks, naming the service, while the operator's key waits on it alone", () => {
    const consent = resolveAiBlock(operatorOnly()).consent;
    expect(consent).toEqual({
      status: "needed",
      since: null,
      recipients: [{ via: "operator_key", name: "OpenAI" }],
    });
  });

  it("names the service behind the operator's endpoint, not a guess", () => {
    const named = (url: string) =>
      resolveAiBlock(operatorOnly(url)).consent.recipients[0]?.name;
    expect(named("https://api.openai.com/v1")).toBe("OpenAI");
    expect(named("https://api.anthropic.com/v1")).toBe("Anthropic");
    expect(named("https://openrouter.ai/api/v1")).toBe("openrouter.ai");
  });

  it("names the operator's shared ChatGPT account", () => {
    const inputs = baseline();
    inputs.provider = {
      entries: [
        { providerType: "openai", vision: true },
        { providerType: "admin-codex", vision: true },
      ],
      localOcrEnabled: false,
      managedBy: "user",
    };
    expect(resolveAiBlock(inputs).consent).toEqual({
      status: "needed",
      since: null,
      recipients: [{ via: "operator_chatgpt", name: "ChatGPT (OpenAI)" }],
    });
  });

  it("reports a given consent with its date and the service it covers", () => {
    const inputs = operatorOnly();
    inputs.activeConsentKinds = new Set(["ai_full"]);
    inputs.fullConsentSince = new Date("2026-07-01T08:00:00.000Z");
    expect(resolveAiBlock(inputs).consent).toEqual({
      status: "given",
      since: "2026-07-01T08:00:00.000Z",
      recipients: [{ via: "operator_key", name: "OpenAI" }],
    });
  });

  it("asks nothing of a person on their own key or a local model", () => {
    expect(resolveAiBlock(baseline()).consent).toEqual({
      status: "not_needed",
      since: null,
      recipients: [],
    });
    const own = baseline();
    own.provider = {
      entries: [{ providerType: "anthropic", vision: true }],
      localOcrEnabled: false,
      managedBy: "user",
    };
    // A document read on an own key still needs its narrower receipt, asked
    // where the document is read; that is not this question.
    expect(resolveAiBlock(own).consent.status).toBe("not_needed");
  });

  it("asks nothing when agreeing would open nothing", () => {
    // The operator switched AI off: the switch is the outermost reason, so no
    // capability is closed by the missing consent alone.
    const off = operatorOnly();
    off.switches = { ...off.switches, enabled: false };
    expect(resolveAiBlock(off).consent.status).toBe("not_needed");
    // A delegate inside somebody else's record.
    const delegate = operatorOnly();
    delegate.providerWorkAdmitted = false;
    expect(resolveAiBlock(delegate).consent.status).toBe("not_needed");
  });

  it("keeps asking while a narrower receipt leaves the Coach closed", () => {
    const inputs = operatorOnly();
    inputs.activeConsentKinds = new Set(["ai_insights_only"]);
    expect(resolveAiBlock(inputs).consent.status).toBe("needed");
  });

  it("asks nothing when the inputs could not be read", () => {
    expect(resolveAiBlock(null).consent).toEqual({
      status: "not_needed",
      since: null,
      recipients: [],
    });
  });
});
