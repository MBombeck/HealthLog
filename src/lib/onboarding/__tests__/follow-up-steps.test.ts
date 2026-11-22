/**
 * 1.49 — the conditional steps of the setup flow: "Region & units" for a
 * medication schedule, and the two follow-ups after confirm (`reminders`,
 * `ai`).
 *
 * The contract these pin: a follow-up appears only for the record it
 * concerns, never makes the flow longer for anybody else, and never reopens a
 * setup that was finished before it existed. The last case is a real 1.48
 * ledger, stored as 1.48 wrote it (nine ids, no follow-ups), read through the
 * same store function every route uses.
 */
import { describe, expect, it } from "vitest";

import {
  emptyOnboardingNeeds,
  isOnboardingSettled,
  onboardingOffersFromAi,
  type OnboardingNeeds,
  type OnboardingOffers,
  type OnboardingStateDto,
} from "../needs";
import { toOnboardingStateDto } from "../needs-store";
import {
  canVisitScreen,
  nextScreen,
  previousScreen,
  resumeScreen,
  screenOrder,
  unitsQuestionApplies,
} from "../wizard-steps";

const NO_UNITS = { glucoseUnit: null, unitPreference: null } as const;
const AT = new Date("2026-11-01T09:00:00.000Z");

/** A record mid-flow on this release: every id stored, confirm done. */
function confirmedFlow(
  needs: Partial<OnboardingNeeds>,
  offers: OnboardingOffers = { ai: false },
): OnboardingStateDto {
  const stored = [
    "who",
    "areas",
    "medication",
    "sources",
    "visit",
    "units",
    "confirm",
  ].map((id) => ({ id, status: "done" }));
  return toOnboardingStateDto(
    {
      needsJson: { ...emptyOnboardingNeeds(), recordTarget: "me", ...needs },
      stepsJson: [
        ...stored,
        { id: "reminders", status: "pending" },
        { id: "ai", status: "pending" },
        { id: "first-result", status: "pending" },
        { id: "done", status: "pending" },
      ],
      firstResultJson: null,
      modulesDerivedAt: AT,
      completedAt: AT,
    },
    NO_UNITS,
    offers,
  );
}

describe("the reminders follow-up", () => {
  it("follows a medication schedule or an area with reminders of its own", () => {
    for (const needs of [
      { medication: "yes" },
      { medication: "sometimes" },
      { areas: ["mood"] },
      { areas: ["cycle"] },
    ] as const) {
      const state = confirmedFlow(needs as Partial<OnboardingNeeds>);
      expect(screenOrder(state), JSON.stringify(needs)).toContain("reminders");
      expect(resumeScreen(state)).toBe("reminders");
    }
  });

  it("is not in the flow of anybody it does not concern", () => {
    for (const needs of [
      { medication: "no", areas: ["blood-pressure"] },
      { medication: null, areas: [] },
      { recordTarget: "someone-else", medication: "yes" },
    ] as const) {
      const state = confirmedFlow(needs as Partial<OnboardingNeeds>);
      expect(screenOrder(state), JSON.stringify(needs)).not.toContain(
        "reminders",
      );
      // Resolved as passed, so nothing waits on a screen that is not shown.
      expect(state.steps.find((s) => s.id === "reminders")?.status).toBe(
        "skipped",
      );
      expect(canVisitScreen(state, "reminders")).toBe(false);
    }
  });
});

describe("the AI follow-up", () => {
  it("is offered only when the server offers the Coach", () => {
    const off = confirmedFlow({ areas: ["sleep"] }, { ai: false });
    expect(screenOrder(off)).not.toContain("ai");
    expect(off.steps.find((s) => s.id === "ai")?.status).toBe("skipped");

    const on = confirmedFlow({ areas: ["sleep"] }, { ai: true });
    expect(screenOrder(on)).toContain("ai");
    expect(resumeScreen(on)).toBe("ai");
  });

  it('keeps an answered step in the order after "No" switched the offer off', () => {
    // "No" turns the Coach off, and the server then answers offers.ai false.
    const answered = confirmedFlow({ medication: "yes" }, { ai: false });
    const state = {
      ...answered,
      steps: answered.steps.map((s) =>
        s.id === "ai" || s.id === "reminders"
          ? { ...s, status: "done" as const }
          : s,
      ),
    };
    const order = screenOrder(state);
    expect(order).toContain("ai");
    expect(nextScreen(state, "ai")).toBe("first-result");
    expect(previousScreen(state, "first-result")).toBe("ai");
    expect(canVisitScreen(state, "ai")).toBe(true);
  });

  it("comes after the reminders and before the first result", () => {
    const state = confirmedFlow(
      { medication: "yes", areas: ["glucose"] },
      { ai: true },
    );
    const order = screenOrder(state);
    expect(order.indexOf("confirm")).toBeLessThan(order.indexOf("reminders"));
    expect(order.indexOf("reminders")).toBeLessThan(order.indexOf("ai"));
    expect(order.indexOf("ai")).toBeLessThan(order.indexOf("first-result"));
  });

  it("reads the offer off the resolved Coach capability", () => {
    const block = (
      available: boolean,
      reason: string | null,
      canConfigure: boolean,
    ) => ({
      capabilities: { coach: { available, reason } },
      provider: { canConfigure },
    });
    expect(onboardingOffersFromAi(block(true, null, true)).ai).toBe(true);
    expect(
      onboardingOffersFromAi(block(false, "consent_required", false)).ai,
    ).toBe(true);
    expect(onboardingOffersFromAi(block(false, "no_provider", true)).ai).toBe(
      true,
    );
    expect(onboardingOffersFromAi(block(false, "no_provider", false)).ai).toBe(
      false,
    );
    expect(
      onboardingOffersFromAi(block(false, "operator_disabled", true)).ai,
    ).toBe(false);
    expect(onboardingOffersFromAi(block(false, "user_disabled", true)).ai).toBe(
      false,
    );
  });
});

describe("Region & units", () => {
  it("is asked for a medication schedule even with no unit-bearing area", () => {
    const needs = { ...emptyOnboardingNeeds(), medication: "yes" as const };
    const steps = confirmedFlow({ medication: "yes" }).steps.map((s) =>
      s.id === "units" ? { ...s, status: "pending" as const } : s,
    );
    expect(unitsQuestionApplies({ steps, needs })).toBe(true);
  });

  it("stays out of a flow with neither a unit area nor medication", () => {
    const needs = { ...emptyOnboardingNeeds(), areas: ["sleep" as const] };
    const steps = confirmedFlow({ areas: ["sleep"] }).steps;
    expect(unitsQuestionApplies({ steps, needs })).toBe(false);
  });
});

describe("a ledger a 1.48 server wrote", () => {
  // Exactly what 1.48 stored for a finished flow: nine ids, no follow-ups.
  const legacySteps = [
    { id: "who", status: "done" },
    { id: "areas", status: "done" },
    { id: "medication", status: "done" },
    { id: "sources", status: "skipped" },
    { id: "visit", status: "skipped" },
    { id: "units", status: "skipped" },
    { id: "confirm", status: "done" },
    { id: "first-result", status: "skipped" },
    { id: "done", status: "done" },
  ];
  const legacyRow = {
    needsJson: {
      recordTarget: "me",
      areas: ["mood", "glucose"],
      medication: "yes",
      sources: [],
      visit: null,
      units: { glucoseUnit: null, unitPreference: null },
    },
    stepsJson: legacySteps,
    firstResultJson: null,
    modulesDerivedAt: AT,
    completedAt: AT,
  };

  it("stays settled, with every follow-up read as passed", () => {
    const state = toOnboardingStateDto(legacyRow, NO_UNITS, { ai: true });
    expect(state.steps.find((s) => s.id === "reminders")?.status).toBe(
      "skipped",
    );
    expect(state.steps.find((s) => s.id === "ai")?.status).toBe("skipped");
    expect(isOnboardingSettled(state)).toBe(true);
  });

  it("is never sent back into the flow", () => {
    const state = toOnboardingStateDto(legacyRow, NO_UNITS, { ai: true });
    // The front door shows "set up again" for a settled flow that resumes on
    // done; it redirects only when the resume point is another screen.
    expect(resumeScreen(state)).toBe("done");
  });

  it("does reopen for a record whose flow was never confirmed", () => {
    // Mid-flow on 1.48 (no stamp): the follow-ups are owed like any step.
    const state = toOnboardingStateDto(
      {
        ...legacyRow,
        completedAt: null,
        stepsJson: legacySteps.map((s) =>
          ["confirm", "first-result", "done"].includes(s.id)
            ? { ...s, status: "pending" }
            : s,
        ),
      },
      NO_UNITS,
      { ai: false },
    );
    expect(state.steps.find((s) => s.id === "reminders")?.status).toBe(
      "pending",
    );
    expect(resumeScreen(state)).toBe("confirm");
  });
});
