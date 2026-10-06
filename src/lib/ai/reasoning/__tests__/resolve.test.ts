import { describe, expect, it } from "vitest";

import {
  BACKGROUND_REASONING_JOBS,
  REASONING_LEVELS,
  REASONING_MAX_EFFORTS,
} from "../levels";
import {
  coachReasoningCeiling,
  completionReasoning,
  parseReasoningMaxEffort,
  reasoningSupportForChainEntry,
  resolveReasoning,
  type ReasoningSurface,
} from "../resolve";
import type { ReasoningSupport } from "../support";

const ON = { enabled: true, maxEffort: "high" } as const;
const FULL: ReasoningSupport = {
  effort: true,
  summaries: true,
  liveSummaries: true,
  stateRoundTrip: true,
  offIsReal: true,
};
const NO_REASONING: ReasoningSupport = { ...FULL, effort: false };
const SURFACES: ReasoningSurface[] = ["coach", ...BACKGROUND_REASONING_JOBS];
const rank = (l: string) => (REASONING_LEVELS as readonly string[]).indexOf(l);

describe("resolveReasoning — the Coach", () => {
  it("runs the person's level when nothing caps it", () => {
    for (const pref of REASONING_LEVELS) {
      expect(
        resolveReasoning({
          surface: "coach",
          userPref: pref,
          admin: ON,
          costOwner: "user",
          support: FULL,
        }),
      ).toEqual({ effort: pref, summaries: pref !== "off", source: "user" });
    }
  });

  it("defaults a person who never chose to medium", () => {
    const r = resolveReasoning({
      surface: "coach",
      admin: ON,
      costOwner: "user",
    });
    expect(r).toEqual({ effort: "medium", summaries: true, source: "user" });
  });

  it("clamps the person's level to the operator's cap", () => {
    const r = resolveReasoning({
      surface: "coach",
      userPref: "high",
      admin: { enabled: true, maxEffort: "low" },
      costOwner: "user",
      support: FULL,
    });
    expect(r).toEqual({ effort: "low", summaries: true, source: "admin_cap" });
  });

  it("holds an operator-funded turn to medium", () => {
    const r = resolveReasoning({
      surface: "coach",
      userPref: "high",
      admin: ON,
      costOwner: "operator",
      support: FULL,
    });
    expect(r).toEqual({
      effort: "medium",
      summaries: true,
      source: "cost_cap",
    });
  });

  it("names the operator's cap when it is the lower of the two", () => {
    const r = resolveReasoning({
      surface: "coach",
      userPref: "high",
      admin: { enabled: true, maxEffort: "low" },
      costOwner: "operator",
    });
    expect(r.source).toBe("admin_cap");
    expect(r.effort).toBe("low");
  });

  it("asks for no summaries where the provider gives none", () => {
    const r = resolveReasoning({
      surface: "coach",
      userPref: "medium",
      admin: ON,
      costOwner: "user",
      support: { ...FULL, summaries: false },
    });
    expect(r.summaries).toBe(false);
  });

  it("is off for a provider that cannot reason", () => {
    const r = resolveReasoning({
      surface: "coach",
      userPref: "high",
      admin: ON,
      costOwner: "user",
      support: NO_REASONING,
    });
    expect(r).toEqual({
      effort: "off",
      summaries: false,
      source: "unsupported",
    });
  });
});

describe("resolveReasoning — background jobs", () => {
  it("never reads the Coach preference", () => {
    const r = resolveReasoning({
      surface: "daily_briefing",
      userPref: "off",
      admin: ON,
      costOwner: "user",
    });
    expect(r).toEqual({ effort: "medium", summaries: false, source: "job" });
  });

  it("takes the operator level when the operator pays", () => {
    expect(
      resolveReasoning({
        surface: "daily_briefing",
        admin: ON,
        costOwner: "operator",
      }).effort,
    ).toBe("low");
    expect(
      resolveReasoning({
        surface: "period_narrative_month",
        admin: ON,
        costOwner: "user",
      }).effort,
    ).toBe("medium");
    expect(
      resolveReasoning({
        surface: "period_narrative_week",
        admin: ON,
        costOwner: "user",
      }).effort,
    ).toBe("low");
  });

  it("never asks a job for summaries", () => {
    for (const job of BACKGROUND_REASONING_JOBS) {
      expect(
        resolveReasoning({
          surface: job,
          admin: ON,
          costOwner: "user",
          support: FULL,
        }).summaries,
      ).toBe(false);
    }
  });
});

describe("the operator's switch and cap win everywhere", () => {
  const owners = ["user", "operator"] as const;
  const supports = [null, FULL, NO_REASONING];
  const prefs = [undefined, ...REASONING_LEVELS];

  it("off is off on every surface, for every preference, payer and provider", () => {
    let cases = 0;
    for (const surface of SURFACES)
      for (const userPref of prefs)
        for (const costOwner of owners)
          for (const support of supports)
            for (const maxEffort of REASONING_MAX_EFFORTS) {
              const r = resolveReasoning({
                surface,
                userPref,
                admin: { enabled: false, maxEffort },
                costOwner,
                support,
              });
              expect(r).toEqual({
                effort: "off",
                summaries: false,
                source: "admin_off",
              });
              cases++;
            }
    expect(cases).toBeGreaterThan(500);
  });

  it("no resolution ever exceeds the operator's cap", () => {
    for (const surface of SURFACES)
      for (const userPref of prefs)
        for (const costOwner of owners)
          for (const maxEffort of REASONING_MAX_EFFORTS) {
            const r = resolveReasoning({
              surface,
              userPref,
              admin: { enabled: true, maxEffort },
              costOwner,
              support: FULL,
            });
            expect(rank(r.effort)).toBeLessThanOrEqual(rank(maxEffort));
            if (costOwner === "operator") {
              expect(rank(r.effort)).toBeLessThanOrEqual(rank("medium"));
            }
          }
  });

  it("a job resolved off under the switch sends nothing at all", () => {
    for (const job of BACKGROUND_REASONING_JOBS) {
      const r = resolveReasoning({
        surface: job,
        admin: { enabled: false, maxEffort: "high" },
        costOwner: "user",
      });
      expect(completionReasoning(r, job)).toBeUndefined();
    }
  });
});

describe("completionReasoning", () => {
  it("sends the Coach's off explicitly, so a provider that can switch off does", () => {
    const r = resolveReasoning({
      surface: "coach",
      userPref: "off",
      admin: ON,
      costOwner: "user",
    });
    expect(completionReasoning(r, "coach")).toEqual({
      effort: "off",
      summaries: false,
    });
  });

  it("sends nothing for a provider that cannot reason", () => {
    const r = resolveReasoning({
      surface: "coach",
      userPref: "high",
      admin: ON,
      costOwner: "user",
      support: NO_REASONING,
    });
    expect(completionReasoning(r, "coach")).toBeUndefined();
  });

  it("carries a job's level without summaries", () => {
    const r = resolveReasoning({
      surface: "daily_briefing",
      admin: ON,
      costOwner: "user",
    });
    expect(completionReasoning(r, "daily_briefing")).toEqual({
      effort: "medium",
      summaries: false,
    });
  });
});

describe("coachReasoningCeiling", () => {
  it("is off when switched off, the cap otherwise, medium at most for the operator", () => {
    expect(
      coachReasoningCeiling({ enabled: false, maxEffort: "high" }, "user"),
    ).toBe("off");
    expect(
      coachReasoningCeiling({ enabled: true, maxEffort: "high" }, "user"),
    ).toBe("high");
    expect(
      coachReasoningCeiling({ enabled: true, maxEffort: "high" }, "operator"),
    ).toBe("medium");
    expect(
      coachReasoningCeiling({ enabled: true, maxEffort: "low" }, "operator"),
    ).toBe("low");
  });
});

describe("parseReasoningMaxEffort", () => {
  it("keeps the three caps and reads anything else as no cap", () => {
    expect(parseReasoningMaxEffort("low")).toBe("low");
    expect(parseReasoningMaxEffort("medium")).toBe("medium");
    expect(parseReasoningMaxEffort("off")).toBe("high");
    expect(parseReasoningMaxEffort(null)).toBe("high");
  });
});

describe("reasoningSupportForChainEntry", () => {
  it("reads the client each chain tag builds", () => {
    expect(reasoningSupportForChainEntry("codex", {}).effort).toBe(true);
    expect(reasoningSupportForChainEntry("admin-codex", {}).effort).toBe(true);
    // The OpenAI client's default model does not reason.
    expect(reasoningSupportForChainEntry("openai", {}).effort).toBe(false);
    expect(
      reasoningSupportForChainEntry("openai", { model: "gpt-5" }).offIsReal,
    ).toBe(false);
    expect(
      reasoningSupportForChainEntry("anthropic", { model: "claude-opus-5" })
        .offIsReal,
    ).toBe(false);
    expect(
      reasoningSupportForChainEntry("admin-openai", {
        adminIsAnthropic: true,
        adminModel: "claude-opus-5",
      }).offIsReal,
    ).toBe(false);
    expect(
      reasoningSupportForChainEntry("openai-compatible", {
        compatModel: "x",
        compatBaseUrl: "https://openrouter.ai/api/v1",
      }).stateRoundTrip,
    ).toBe(true);
    expect(reasoningSupportForChainEntry("local", {}).effort).toBe(true);
  });
});
