/**
 * v1.39 (C2) — the step machine behind the setup screens.
 *
 * Pure, so every question the screens ask — which screen is next, where a
 * returning person resumes, whether a URL may be visited, what the counter
 * says — is answered here without a browser. The server publishes the ledger
 * and the answers; this file turns them into a route.
 */
import { describe, expect, it } from "vitest";

import {
  defaultOnboardingSteps,
  emptyOnboardingNeeds,
  type OnboardingNeeds,
  type OnboardingStateDto,
  type OnboardingStepId,
  type OnboardingStepStatus,
} from "../needs";
import {
  BROWSER_CONNECTABLE_SOURCES,
  canVisitScreen,
  chooseFirstResultTask,
  firstResultApplies,
  nextScreen,
  previousScreen,
  questionScreens,
  resumeScreen,
  screenOrder,
  stepCounter,
  unitsQuestionApplies,
} from "../wizard-steps";

function state(
  statuses: Partial<Record<OnboardingStepId, OnboardingStepStatus>> = {},
  needs: Partial<OnboardingNeeds> = {},
  extra: Partial<Pick<OnboardingStateDto, "completedAt" | "firstResult">> = {},
): OnboardingStateDto {
  return {
    steps: defaultOnboardingSteps().map((step) => ({
      ...step,
      status: statuses[step.id] ?? step.status,
    })),
    needs: { ...emptyOnboardingNeeds(), ...needs },
    completedAt: extra.completedAt ?? null,
    firstResult: extra.firstResult ?? null,
  };
}

/** Every question answered, no units question in play. */
const QUESTIONS_DONE = {
  who: "done",
  areas: "done",
  medication: "done",
  sources: "done",
  visit: "done",
} as const;

describe("unitsQuestionApplies", () => {
  it("is off while no area needs a unit", () => {
    expect(unitsQuestionApplies(state({}, { areas: ["mood", "sleep"] }))).toBe(
      false,
    );
  });

  it("is on for glucose or weight while the account holds no preference", () => {
    expect(unitsQuestionApplies(state({}, { areas: ["glucose"] }))).toBe(true);
    expect(unitsQuestionApplies(state({}, { areas: ["weight-body"] }))).toBe(
      true,
    );
  });

  it("is off when the server resolved units from the account's own columns", () => {
    // `units: done` with no recorded answer is exactly what
    // `resolveOnboardingSteps` publishes for an account that holds both.
    expect(
      unitsQuestionApplies(state({ units: "done" }, { areas: ["glucose"] })),
    ).toBe(false);
  });

  it("stays in the order once the flow itself recorded the answer", () => {
    expect(
      unitsQuestionApplies(
        state(
          { units: "done" },
          {
            areas: ["glucose"],
            units: { glucoseUnit: "mmol/L", unitPreference: null },
          },
        ),
      ),
    ).toBe(true);
  });

  it("stays in the order after a deliberate skip, so it can be revisited", () => {
    expect(
      unitsQuestionApplies(state({ units: "skipped" }, { areas: ["glucose"] })),
    ).toBe(true);
  });
});

describe("questionScreens", () => {
  it("is the five questions, plus units only when it applies", () => {
    expect(questionScreens(state())).toEqual([
      "who",
      "areas",
      "medication",
      "sources",
      "visit",
    ]);
    expect(questionScreens(state({}, { areas: ["glucose"] }))).toEqual([
      "who",
      "areas",
      "medication",
      "sources",
      "visit",
      "units",
    ]);
  });
});

describe("chooseFirstResultTask", () => {
  it("prefers a connection the browser can complete, in the person's own order", () => {
    expect(
      chooseFirstResultTask({
        ...emptyOnboardingNeeds(),
        sources: ["manual", "apple-health", "oura", "withings"],
        medication: "yes",
        areas: ["blood-pressure"],
      }),
    ).toEqual({ task: "connect-source", target: "oura" });
  });

  it("never offers a source the browser cannot connect", () => {
    for (const source of ["manual", "apple-health", "file"] as const) {
      expect(BROWSER_CONNECTABLE_SOURCES).not.toContain(source);
      expect(
        chooseFirstResultTask({ ...emptyOnboardingNeeds(), sources: [source] }),
      ).toBeNull();
    }
  });

  it("offers the first medication only for a daily schedule", () => {
    expect(
      chooseFirstResultTask({
        ...emptyOnboardingNeeds(),
        medication: "yes",
        areas: ["mood"],
      }),
    ).toEqual({ task: "add-medication", target: null });
    expect(
      chooseFirstResultTask({
        ...emptyOnboardingNeeds(),
        medication: "sometimes",
        areas: ["mood"],
      }),
    ).toEqual({ task: "log-reading", target: "mood" });
  });

  it("falls back to one reading for the first area, and to nothing", () => {
    expect(
      chooseFirstResultTask({
        ...emptyOnboardingNeeds(),
        areas: ["weight-body", "glucose"],
      }),
    ).toEqual({ task: "log-reading", target: "weight-body" });
    expect(chooseFirstResultTask(emptyOnboardingNeeds())).toBeNull();
  });
});

describe("firstResultApplies", () => {
  it("is off when there is no task to offer", () => {
    expect(firstResultApplies(state(QUESTIONS_DONE))).toBe(false);
  });

  it("is off for a record somebody else will run", () => {
    // The three tasks write the CALLER's record, and the routes refuse under
    // a switch — so for "someone I look after" the profile is created on the
    // confirm screen and the flow ends there.
    expect(
      firstResultApplies(
        state(QUESTIONS_DONE, {
          recordTarget: "someone-else",
          areas: ["blood-pressure"],
        }),
      ),
    ).toBe(false);
    expect(
      firstResultApplies(
        state(QUESTIONS_DONE, {
          recordTarget: "both",
          areas: ["blood-pressure"],
        }),
      ),
    ).toBe(true);
  });
});

describe("screenOrder", () => {
  it("runs welcome, the questions, confirm, the first result, done", () => {
    expect(
      screenOrder(
        state(
          {},
          { recordTarget: "me", areas: ["glucose"], medication: "yes" },
        ),
      ),
    ).toEqual([
      "welcome",
      "who",
      "areas",
      "medication",
      "sources",
      "visit",
      "units",
      "confirm",
      "first-result",
      "done",
    ]);
  });

  it("drops the first-result screen when nothing can be offered", () => {
    expect(screenOrder(state({}, { recordTarget: "me" }))).toEqual([
      "welcome",
      "who",
      "areas",
      "medication",
      "sources",
      "visit",
      "confirm",
      "done",
    ]);
  });
});

describe("resumeScreen", () => {
  it("starts a record that never entered the flow on the welcome screen", () => {
    expect(resumeScreen(state())).toBe("welcome");
  });

  it("resumes at the first question still pending", () => {
    expect(resumeScreen(state({ who: "done" }, { recordTarget: "me" }))).toBe(
      "areas",
    );
    expect(
      resumeScreen(
        state(
          { who: "done", areas: "skipped", medication: "done" },
          { recordTarget: "me", medication: "no" },
        ),
      ),
    ).toBe("sources");
  });

  it("puts a restarted flow back on the first question even though the answers remain", () => {
    // `POST /api/onboarding/restart` resets the ledger and keeps the answers
    // as prefill: every step pending, Q1 answered.
    expect(
      resumeScreen(
        state(
          {},
          { recordTarget: "me", areas: ["glucose"], medication: "yes" },
        ),
      ),
    ).toBe("who");
  });

  it("goes to confirm once every question is settled", () => {
    expect(resumeScreen(state(QUESTIONS_DONE, { recordTarget: "me" }))).toBe(
      "confirm",
    );
  });

  it("skips a units question the account already answers", () => {
    expect(
      resumeScreen(
        state(
          { ...QUESTIONS_DONE, units: "done" },
          { recordTarget: "me", areas: ["glucose"] },
        ),
      ),
    ).toBe("confirm");
  });

  it("stops on the units question while it is still owed", () => {
    expect(
      resumeScreen(
        state(QUESTIONS_DONE, { recordTarget: "me", areas: ["glucose"] }),
      ),
    ).toBe("units");
  });

  it("offers the first result after confirm, then done", () => {
    const confirmed = state(
      { ...QUESTIONS_DONE, confirm: "done" },
      { recordTarget: "me", medication: "yes" },
      { completedAt: "2026-09-10T08:00:00.000Z" },
    );
    expect(resumeScreen(confirmed)).toBe("first-result");
    expect(
      resumeScreen({
        ...confirmed,
        steps: confirmed.steps.map((s) =>
          s.id === "first-result" ? { ...s, status: "skipped" as const } : s,
        ),
      }),
    ).toBe("done");
  });

  it("goes straight to done after confirm when no task applies", () => {
    expect(
      resumeScreen(
        state(
          { ...QUESTIONS_DONE, confirm: "done" },
          { recordTarget: "me" },
          { completedAt: "2026-09-10T08:00:00.000Z" },
        ),
      ),
    ).toBe("done");
  });
});

describe("nextScreen / previousScreen", () => {
  const s = state({}, { recordTarget: "me", areas: ["weight-body"] });

  it("walks the order in both directions", () => {
    expect(nextScreen(s, "welcome")).toBe("who");
    expect(nextScreen(s, "visit")).toBe("units");
    expect(nextScreen(s, "units")).toBe("confirm");
    expect(nextScreen(s, "confirm")).toBe("first-result");
    expect(nextScreen(s, "done")).toBeNull();
    expect(previousScreen(s, "who")).toBe("welcome");
    expect(previousScreen(s, "welcome")).toBeNull();
    expect(previousScreen(s, "confirm")).toBe("units");
  });

  it("steps over the units question when it does not apply", () => {
    const noUnits = state({}, { recordTarget: "me", areas: ["mood"] });
    expect(nextScreen(noUnits, "visit")).toBe("confirm");
    expect(previousScreen(noUnits, "confirm")).toBe("visit");
  });

  it("answers null for a screen that is not in this flow's order", () => {
    const noUnits = state({}, { recordTarget: "me", areas: ["mood"] });
    expect(nextScreen(noUnits, "units")).toBeNull();
  });
});

describe("canVisitScreen", () => {
  const midway = state(
    { who: "done", areas: "done" },
    { recordTarget: "me", areas: ["glucose"] },
  );

  it("allows every screen up to the resume point and refuses the ones ahead", () => {
    expect(canVisitScreen(midway, "welcome")).toBe(true);
    expect(canVisitScreen(midway, "who")).toBe(true);
    expect(canVisitScreen(midway, "medication")).toBe(true);
    expect(canVisitScreen(midway, "sources")).toBe(false);
    expect(canVisitScreen(midway, "confirm")).toBe(false);
    expect(canVisitScreen(midway, "done")).toBe(false);
  });

  it("always admits the first question, which is where the welcome screen goes", () => {
    expect(canVisitScreen(state(), "who")).toBe(true);
    expect(canVisitScreen(state(), "areas")).toBe(false);
  });

  it("refuses a screen the order does not contain", () => {
    const noUnits = state(QUESTIONS_DONE, {
      recordTarget: "me",
      areas: ["mood"],
    });
    expect(canVisitScreen(noUnits, "units")).toBe(false);
    expect(canVisitScreen(noUnits, "first-result")).toBe(false);
  });
});

describe("stepCounter", () => {
  it("counts the questions only, at the size this flow actually has", () => {
    expect(stepCounter(state(), "who")).toEqual({ current: 1, total: 5 });
    expect(stepCounter(state({}, { areas: ["glucose"] }), "units")).toEqual({
      current: 6,
      total: 6,
    });
  });

  it("has nothing to say on the screens that are not questions", () => {
    expect(stepCounter(state(), "welcome")).toBeNull();
    expect(stepCounter(state(), "confirm")).toBeNull();
    expect(stepCounter(state(), "done")).toBeNull();
  });
});
