/**
 * 1.50 — the person setup's step machine: the segments pinned on "who", the
 * screens inside them, where a person resumes, and which URLs may be shown.
 *
 * The stepper's count is the contract that matters most: it is fixed for
 * the flow (a screen inside a segment only advances the fill), so these pin
 * that the plan, once pinned, does not move when the answers or the server's
 * offers do.
 */
import { describe, expect, it } from "vitest";

import {
  emptyOnboardingNeeds,
  isOnboardingSettled,
  onboardingOffersFromAi,
  type OnboardingNeeds,
  type OnboardingStateDto,
  type OnboardingStepStatus,
} from "../needs";
import { toOnboardingStateDto } from "../needs-store";
import {
  canVisitScreen,
  computePlan,
  ledgerStepOf,
  nextScreen,
  parsePinnedPlan,
  previousScreen,
  questionsToPassBeforeConfirm,
  resumeScreen,
  screenOrder,
  stepperPosition,
  type FlowState,
  type PersonSegmentId,
} from "../wizard-steps";

const NO_UNITS = { glucoseUnit: null, unitPreference: null } as const;
const AT = new Date("2026-11-01T09:00:00.000Z");

function flow(
  needs: Partial<OnboardingNeeds>,
  statuses: Record<string, OnboardingStepStatus> = {},
  options: { ai?: boolean; plan?: PersonSegmentId[] | null } = {},
): FlowState {
  const state = toOnboardingStateDto(
    {
      needsJson: { ...emptyOnboardingNeeds(), ...needs },
      stepsJson: Object.entries(statuses).map(([id, status]) => ({
        id,
        status,
      })),
      firstResultJson: null,
      modulesDerivedAt: null,
      completedAt: null,
    },
    NO_UNITS,
    { ai: options.ai ?? false },
  );
  return { ...state, plan: options.plan ?? null };
}

describe("computePlan", () => {
  it("gives a person's own record four segments, three without the Coach", () => {
    expect(computePlan("me", true)).toEqual([
      "you",
      "sources",
      "reminders",
      "ai",
    ]);
    expect(computePlan("me", false)).toEqual(["you", "sources", "reminders"]);
    expect(computePlan(null, false)).toEqual(["you", "sources", "reminders"]);
  });

  it("gives someone looked after the profile and nothing that connects", () => {
    expect(computePlan("someone-else", true)).toEqual(["you", "profile"]);
  });

  it("ends 'both' on the profile", () => {
    expect(computePlan("both", true)).toEqual([
      "you",
      "sources",
      "reminders",
      "ai",
      "profile",
    ]);
  });
});

describe("parsePinnedPlan", () => {
  it("reads a stored plan and refuses anything malformed", () => {
    expect(parsePinnedPlan(["you", "sources"])).toEqual(["you", "sources"]);
    expect(parsePinnedPlan(["sources", "you"])).toBeNull();
    expect(parsePinnedPlan(["you", "you"])).toBeNull();
    expect(parsePinnedPlan(["you", "nope"])).toBeNull();
    expect(parsePinnedPlan(null)).toBeNull();
    expect(parsePinnedPlan([])).toBeNull();
  });
});

describe("the pinned plan holds the stepper still", () => {
  it("keeps the count when the server stops offering the Coach", () => {
    const pinned = flow(
      { recordTarget: "me" },
      { who: "done" },
      { ai: false, plan: ["you", "sources", "reminders", "ai"] },
    );
    expect(stepperPosition(pinned, "areas").segments).toHaveLength(4);
  });

  it("fills a segment a third per screen and never adds one", () => {
    const state = flow({ recordTarget: "me" }, {}, { ai: true });
    expect(stepperPosition(state, "who")).toMatchObject({
      current: 0,
      fraction: 1 / 3,
    });
    expect(stepperPosition(state, "units")).toMatchObject({
      current: 0,
      fraction: 1,
    });
    expect(stepperPosition(state, "reminders")).toMatchObject({
      current: 2,
      fraction: 1,
    });
  });
});

describe("screenOrder", () => {
  it("walks the plan's screens in order", () => {
    expect(screenOrder(flow({ recordTarget: "me" }, {}, { ai: true }))).toEqual(
      ["who", "areas", "units", "sources", "reminders", "ai"],
    );
    expect(screenOrder(flow({ recordTarget: "someone-else" }))).toEqual([
      "who",
      "areas",
      "units",
      "profile",
    ]);
  });

  it("drops an unanswered AI screen the server no longer offers", () => {
    const state = flow(
      { recordTarget: "me" },
      {},
      { ai: false, plan: ["you", "sources", "reminders", "ai"] },
    );
    expect(screenOrder(state)).not.toContain("ai");
  });

  it("keeps an answered AI screen, so Back still reaches it", () => {
    const state = flow(
      { recordTarget: "me" },
      { ai: "done" },
      { ai: false, plan: ["you", "sources", "reminders", "ai"] },
    );
    expect(screenOrder(state)).toContain("ai");
  });
});

describe("resumeScreen and canVisitScreen", () => {
  it("starts a fresh account on who and refuses anything past it", () => {
    const state = flow({});
    expect(resumeScreen(state)).toBe("who");
    expect(canVisitScreen(state, "who")).toBe(true);
    expect(canVisitScreen(state, "areas")).toBe(false);
  });

  it("resumes on the first screen still owed", () => {
    const state = flow(
      { recordTarget: "me" },
      { who: "done", areas: "done" },
      { ai: true },
    );
    expect(resumeScreen(state)).toBe("units");
    expect(canVisitScreen(state, "who")).toBe(true);
    expect(canVisitScreen(state, "units")).toBe(true);
    expect(canVisitScreen(state, "sources")).toBe(false);
  });

  it("has nothing owed once every screen is answered or passed", () => {
    const state = flow(
      { recordTarget: "me" },
      {
        who: "done",
        areas: "skipped",
        units: "done",
        sources: "skipped",
        reminders: "skipped",
      },
    );
    expect(resumeScreen(state)).toBeNull();
    expect(canVisitScreen(state, "reminders")).toBe(true);
  });

  it("tracks the profile screen on confirm for someone looked after, on done for both", () => {
    expect(ledgerStepOf("profile", "someone-else")).toBe("confirm");
    expect(ledgerStepOf("profile", "both")).toBe("done");
    const both = flow(
      { recordTarget: "both" },
      {
        who: "done",
        areas: "done",
        units: "done",
        sources: "done",
        reminders: "done",
      },
    );
    expect(resumeScreen(both)).toBe("profile");
  });

  it("refuses a screen the flow does not contain", () => {
    const state = flow({ recordTarget: "someone-else" }, { who: "done" });
    expect(canVisitScreen(state, "sources")).toBe(false);
    expect(canVisitScreen(state, "reminders")).toBe(false);
  });
});

describe("next and previous", () => {
  it("steps through the order", () => {
    const state = flow({ recordTarget: "me" }, {}, { ai: true });
    expect(nextScreen(state, "units")).toBe("sources");
    expect(nextScreen(state, "ai")).toBeNull();
    expect(previousScreen(state, "areas")).toBe("who");
    expect(previousScreen(state, "who")).toBeNull();
  });
});

describe("questionsToPassBeforeConfirm", () => {
  it("passes the questions this flow does not ask", () => {
    const state = flow(
      { recordTarget: "me" },
      { who: "done", areas: "done", units: "done", sources: "done" },
    );
    expect(questionsToPassBeforeConfirm(state)).toEqual([
      "medication",
      "visit",
    ]);
  });

  it("passes sources too for someone looked after", () => {
    const state = flow(
      { recordTarget: "someone-else" },
      { who: "done", areas: "done", units: "done" },
    );
    expect(questionsToPassBeforeConfirm(state)).toEqual([
      "medication",
      "sources",
      "visit",
    ]);
  });
});

describe("the Coach offer", () => {
  it("is offered only while a provider can serve the record", () => {
    const offer = (available: boolean, reason: string | null) =>
      onboardingOffersFromAi({
        capabilities: { coach: { available, reason } },
      }).ai;
    expect(offer(true, null)).toBe(true);
    expect(offer(false, "consent_required")).toBe(true);
    expect(offer(false, "no_provider")).toBe(false);
    expect(offer(false, "operator_disabled")).toBe(false);
    expect(offer(false, "user_disabled")).toBe(false);
  });
});

describe("a ledger a 1.48 server wrote", () => {
  const legacyRow = {
    needsJson: {
      recordTarget: "me",
      areas: ["mood", "glucose"],
      medication: "yes",
      sources: [],
      visit: null,
      units: { glucoseUnit: null, unitPreference: null },
    },
    stepsJson: [
      { id: "who", status: "done" },
      { id: "areas", status: "done" },
      { id: "medication", status: "done" },
      { id: "sources", status: "skipped" },
      { id: "visit", status: "skipped" },
      { id: "units", status: "skipped" },
      { id: "confirm", status: "done" },
      { id: "first-result", status: "skipped" },
      { id: "done", status: "done" },
    ],
    firstResultJson: null,
    modulesDerivedAt: AT,
    completedAt: AT,
  };

  it("stays settled, with every follow-up read as passed", () => {
    const state: OnboardingStateDto = toOnboardingStateDto(
      legacyRow,
      NO_UNITS,
      {
        ai: true,
      },
    );
    expect(state.steps.find((s) => s.id === "reminders")?.status).toBe(
      "skipped",
    );
    expect(isOnboardingSettled(state)).toBe(true);
    expect(resumeScreen({ ...state, plan: null })).toBeNull();
  });
});
