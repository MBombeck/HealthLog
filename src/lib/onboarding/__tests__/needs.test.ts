/**
 * v1.39 (C1) — the stored onboarding state: reading it back, and applying one
 * answered step to it.
 *
 * The two claims worth pinning here are the ones the route promises on the
 * wire. `PATCH /api/onboarding/answers` says it is idempotent, and the reason
 * it can say so is that the whole computation is this pure function — so the
 * property is checkable without a database. The readers say they are
 * fail-soft, and the reason that matters is that they sit on the account
 * payload that rides every app boot: a column written by a release that named
 * an area this one retired must not 500 the shell.
 */
import { describe, expect, it } from "vitest";

import { applyOnboardingAnswer } from "../needs-apply";
import {
  accountHoldsBothUnits,
  defaultOnboardingSteps,
  everyOnboardingQuestionSettled,
  hasEnteredOnboardingFlow,
  ONBOARDING_QUESTION_STEP_IDS,
  emptyOnboardingNeeds,
  isOnboardingSettled,
  ONBOARDING_STEP_IDS,
  parseOnboardingFirstResult,
  parseOnboardingNeeds,
  parseOnboardingSteps,
  readHeldUnitPreferences,
  resolveOnboardingSteps,
  type OnboardingStateDto,
} from "../needs";

function blank() {
  return {
    needs: emptyOnboardingNeeds(),
    steps: defaultOnboardingSteps(),
    firstResult: null,
  };
}

const AT = new Date("2026-09-10T08:00:00.000Z");

describe("parseOnboardingSteps", () => {
  it("returns the full ordered nine whatever the column holds", () => {
    expect(parseOnboardingSteps(null).map((s) => s.id)).toEqual([
      ...ONBOARDING_STEP_IDS,
    ]);
    expect(
      parseOnboardingSteps(null).every((s) => s.status === "pending"),
    ).toBe(true);
  });

  it("keeps a stored status and ignores an id or status it does not know", () => {
    const parsed = parseOnboardingSteps([
      { id: "areas", status: "done" },
      { id: "visit", status: "skipped" },
      { id: "no-such-step", status: "done" },
      { id: "who", status: "half-done" },
    ]);
    expect(parsed.find((s) => s.id === "areas")?.status).toBe("done");
    expect(parsed.find((s) => s.id === "visit")?.status).toBe("skipped");
    expect(parsed.find((s) => s.id === "who")?.status).toBe("pending");
    expect(parsed.map((s) => s.id)).toEqual([...ONBOARDING_STEP_IDS]);
  });
});

describe("parseOnboardingNeeds", () => {
  it("reads nothing out of a corrupt column rather than throwing", () => {
    expect(parseOnboardingNeeds("not an object")).toEqual(
      emptyOnboardingNeeds(),
    );
    expect(parseOnboardingNeeds({ areas: "sleep" }).areas).toEqual([]);
  });

  it("drops unknown answers and de-duplicates the lists", () => {
    const parsed = parseOnboardingNeeds({
      recordTarget: "nobody",
      areas: ["sleep", "sleep", "astrology"],
      medication: "yes",
      sources: ["withings", "carrier-pigeon"],
      visit: "later",
      units: { glucoseUnit: "mmol/L", unitPreference: "furlongs" },
    });
    expect(parsed.recordTarget).toBeNull();
    expect(parsed.areas).toEqual(["sleep"]);
    expect(parsed.medication).toBe("yes");
    expect(parsed.sources).toEqual(["withings"]);
    expect(parsed.visit).toBe("later");
    expect(parsed.units).toEqual({
      glucoseUnit: "mmol/L",
      unitPreference: null,
    });
  });
});

describe("parseOnboardingFirstResult", () => {
  it("is null without a known task", () => {
    expect(parseOnboardingFirstResult(null)).toBeNull();
    expect(parseOnboardingFirstResult({ task: "invent-a-cure" })).toBeNull();
  });

  it("reads the task, its target and its stamp", () => {
    expect(
      parseOnboardingFirstResult({
        task: "connect-source",
        target: "withings",
        completedAt: "2026-09-10T08:00:00.000Z",
      }),
    ).toEqual({
      task: "connect-source",
      target: "withings",
      completedAt: "2026-09-10T08:00:00.000Z",
    });
  });
});

describe("applyOnboardingAnswer", () => {
  it("marks the step done and records the answer", () => {
    const next = applyOnboardingAnswer(
      blank(),
      { step: "areas", areas: ["sleep", "labs"] },
      AT,
    );
    expect(next.needs.areas).toEqual(["sleep", "labs"]);
    expect(next.steps.find((s) => s.id === "areas")?.status).toBe("done");
    expect(next.steps.find((s) => s.id === "who")?.status).toBe("pending");
  });

  it("is idempotent — the same body twice is the same state", () => {
    const once = applyOnboardingAnswer(
      blank(),
      { step: "medication", medication: "yes" },
      AT,
    );
    const twice = applyOnboardingAnswer(
      once,
      { step: "medication", medication: "yes" },
      new Date("2026-09-11T09:00:00.000Z"),
    );
    expect(twice).toEqual(once);
  });

  it("keeps the first-result stamp across a replay rather than re-taking it", () => {
    const first = applyOnboardingAnswer(
      blank(),
      {
        step: "first-result",
        firstResult: { task: "log-reading", target: "sleep", completed: true },
      },
      AT,
    );
    expect(first.firstResult?.completedAt).toBe(AT.toISOString());

    const replay = applyOnboardingAnswer(
      first,
      {
        step: "first-result",
        firstResult: { task: "log-reading", target: "sleep", completed: true },
      },
      new Date("2026-09-12T10:00:00.000Z"),
    );
    expect(replay.firstResult?.completedAt).toBe(AT.toISOString());
  });

  it("re-offers a DIFFERENT task without inheriting the old stamp", () => {
    const first = applyOnboardingAnswer(
      blank(),
      {
        step: "first-result",
        firstResult: { task: "log-reading", completed: true },
      },
      AT,
    );
    const second = applyOnboardingAnswer(
      first,
      {
        step: "first-result",
        firstResult: { task: "add-medication" },
      },
      AT,
    );
    expect(second.firstResult).toEqual({
      task: "add-medication",
      target: null,
      completedAt: null,
    });
  });

  it("records a skip without erasing an answer already given", () => {
    const answered = applyOnboardingAnswer(
      blank(),
      { step: "visit", visit: "within-a-month" },
      AT,
    );
    const skipped = applyOnboardingAnswer(
      answered,
      { step: "visit", status: "skipped" },
      AT,
    );
    expect(skipped.steps.find((s) => s.id === "visit")?.status).toBe("skipped");
    expect(skipped.needs.visit).toBe("within-a-month");
  });

  it("sets one unit without clearing the other", () => {
    const both = applyOnboardingAnswer(
      blank(),
      {
        step: "units",
        units: { glucoseUnit: "mmol/L", unitPreference: "metric" },
      },
      AT,
    );
    const one = applyOnboardingAnswer(
      both,
      { step: "units", units: { unitPreference: "imperial" } },
      AT,
    );
    expect(one.needs.units).toEqual({
      glucoseUnit: "mmol/L",
      unitPreference: "imperial",
    });
  });
});

describe("applyOnboardingAnswer and the two list answers", () => {
  it("stores the list de-duplicated, so the column holds what the reader returns", () => {
    const next = applyOnboardingAnswer(
      blank(),
      {
        step: "areas",
        areas: ["sleep", "sleep", "labs"],
      },
      AT,
    );
    expect(next.needs.areas).toEqual(["sleep", "labs"]);

    const sources = applyOnboardingAnswer(
      blank(),
      { step: "sources", sources: ["oura", "oura", "manual"] },
      AT,
    );
    expect(sources.needs.sources).toEqual(["oura", "manual"]);
  });
});

describe("isOnboardingSettled", () => {
  const settled: OnboardingStateDto = {
    steps: ONBOARDING_STEP_IDS.map((id) => ({ id, status: "done" as const })),
    // Q1 answered: the mark of a record that actually entered the flow.
    needs: { ...emptyOnboardingNeeds(), recordTarget: "me" },
    completedAt: "2026-09-10T08:00:00.000Z",
    firstResult: {
      task: "log-reading",
      target: null,
      completedAt: "2026-09-10T08:01:00.000Z",
    },
  };

  it("settles a record that never entered the flow", () => {
    expect(isOnboardingSettled(null)).toBe(true);
  });

  it("settles a finished flow", () => {
    expect(isOnboardingSettled(settled)).toBe(true);
  });

  it("does not settle while a step is pending", () => {
    expect(
      isOnboardingSettled({
        ...settled,
        steps: settled.steps.map((s) =>
          s.id === "sources" ? { ...s, status: "pending" as const } : s,
        ),
      }),
    ).toBe(false);
  });

  it("does not settle without the flow's own completion stamp", () => {
    expect(isOnboardingSettled({ ...settled, completedAt: null })).toBe(false);
  });

  it("does not settle while the offered task has produced nothing", () => {
    expect(
      isOnboardingSettled({
        ...settled,
        firstResult: { task: "log-reading", target: null, completedAt: null },
      }),
    ).toBe(false);
  });

  it("settles when the offered task was deliberately passed", () => {
    // The task was offered — `firstResult` names it, with no completion — and
    // the person passed. Asking only "did it produce anything" answers no
    // forever, which pins the checklist open with no way out but dismissing
    // rows one by one.
    expect(
      isOnboardingSettled({
        ...settled,
        steps: settled.steps.map((s) =>
          s.id === "first-result" ? { ...s, status: "skipped" as const } : s,
        ),
        firstResult: { task: "log-reading", target: null, completedAt: null },
      }),
    ).toBe(true);
  });

  it("settles a record that never entered the flow, however it is published", () => {
    // The payload carries the field for EVERY record. Without this arm, an
    // account that predates the flow reads as permanently unfinished.
    expect(
      isOnboardingSettled({
        steps: defaultOnboardingSteps(),
        needs: emptyOnboardingNeeds(),
        completedAt: null,
        firstResult: null,
      }),
    ).toBe(true);
  });
});

describe("hasEnteredOnboardingFlow", () => {
  const blankState: OnboardingStateDto = {
    steps: defaultOnboardingSteps(),
    needs: emptyOnboardingNeeds(),
    completedAt: null,
    firstResult: null,
  };

  it("is false for a record the flow never touched", () => {
    expect(hasEnteredOnboardingFlow(null)).toBe(false);
    expect(hasEnteredOnboardingFlow(blankState)).toBe(false);
  });

  it("is true once the one required question is answered", () => {
    expect(
      hasEnteredOnboardingFlow({
        ...blankState,
        needs: { ...emptyOnboardingNeeds(), recordTarget: "someone-else" },
      }),
    ).toBe(true);
  });

  it("is true for a flow that was completed", () => {
    expect(
      hasEnteredOnboardingFlow({
        ...blankState,
        completedAt: "2026-09-10T08:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("is not fooled by the units step resolving from the account's columns", () => {
    // `resolveOnboardingSteps` marks `units` done for an account that already
    // holds both preferences. That record has still never seen a question.
    expect(
      hasEnteredOnboardingFlow({
        ...blankState,
        steps: resolveOnboardingSteps(defaultOnboardingSteps(), {
          glucoseUnit: "mg/dL",
          unitPreference: "metric",
        }),
      }),
    ).toBe(false);
  });
});

describe("the unit preferences the account already holds", () => {
  it("reads the two raw columns into the wire vocabulary", () => {
    expect(
      readHeldUnitPreferences({
        glucoseUnit: "mmol/L",
        unitPreference: "imperial",
      }),
    ).toEqual({ glucoseUnit: "mmol/L", unitPreference: "imperial" });
  });

  it("answers null for a column that was never chosen", () => {
    const held = readHeldUnitPreferences({
      glucoseUnit: null,
      unitPreference: null,
    });
    expect(held).toEqual({ glucoseUnit: null, unitPreference: null });
    expect(accountHoldsBothUnits(held)).toBe(false);
  });

  it("does not mistake a value it does not know for a chosen one", () => {
    expect(
      readHeldUnitPreferences({
        glucoseUnit: "stones",
        unitPreference: "metrick",
      }),
    ).toEqual({ glucoseUnit: null, unitPreference: null });
  });

  it("needs both preferences before the question answers itself", () => {
    expect(
      accountHoldsBothUnits({ glucoseUnit: "mg/dL", unitPreference: null }),
    ).toBe(false);
    expect(
      accountHoldsBothUnits({ glucoseUnit: null, unitPreference: "metric" }),
    ).toBe(false);
    expect(
      accountHoldsBothUnits({
        glucoseUnit: "mg/dL",
        unitPreference: "metric",
      }),
    ).toBe(true);
  });
});

describe("resolveOnboardingSteps", () => {
  const held = {
    glucoseUnit: "mg/dL",
    unitPreference: "metric",
  } as const;

  it("marks units done when the account already holds both preferences", () => {
    const resolved = resolveOnboardingSteps(defaultOnboardingSteps(), held);
    expect(resolved.find((s) => s.id === "units")?.status).toBe("done");
  });

  it("leaves units pending while either preference is unset", () => {
    for (const partial of [
      { glucoseUnit: "mg/dL", unitPreference: null },
      { glucoseUnit: null, unitPreference: "metric" },
      { glucoseUnit: null, unitPreference: null },
    ] as const) {
      const resolved = resolveOnboardingSteps(
        defaultOnboardingSteps(),
        partial,
      );
      expect(resolved.find((s) => s.id === "units")?.status).toBe("pending");
    }
  });

  it("never overwrites an answer that was actually given", () => {
    const skipped = defaultOnboardingSteps().map((s) =>
      s.id === "units" ? { ...s, status: "skipped" as const } : s,
    );
    expect(
      resolveOnboardingSteps(skipped, held).find((s) => s.id === "units")
        ?.status,
    ).toBe("skipped");
  });

  it("touches no other step", () => {
    const resolved = resolveOnboardingSteps(defaultOnboardingSteps(), held);
    expect(
      resolved.filter((s) => s.id !== "units").map((s) => s.status),
    ).toEqual(
      defaultOnboardingSteps()
        .filter((s) => s.id !== "units")
        .map((s) => s.status),
    );
  });
});

describe("everyOnboardingQuestionSettled", () => {
  function withStatuses(
    status: "pending" | "done" | "skipped",
    overrides: Partial<Record<string, "pending" | "done" | "skipped">> = {},
  ) {
    return defaultOnboardingSteps().map((step) => ({
      ...step,
      status: overrides[step.id] ?? status,
    }));
  }

  it("names the six questions and stops before the confirm screen", () => {
    expect([...ONBOARDING_QUESTION_STEP_IDS]).toEqual([
      "who",
      "areas",
      "medication",
      "sources",
      "visit",
      "units",
    ]);
  });

  it("refuses a flow that only answered the first question", () => {
    expect(
      everyOnboardingQuestionSettled(withStatuses("pending", { who: "done" })),
    ).toBe(false);
  });

  it("refuses a flow with any one question still waiting", () => {
    for (const id of ONBOARDING_QUESTION_STEP_IDS) {
      expect(
        everyOnboardingQuestionSettled(
          withStatuses("done", { [id]: "pending" }),
        ),
        `\`${id}\` still pending should not read as a finished questionnaire`,
      ).toBe(false);
    }
  });

  it("accepts a deliberate pass as an answer", () => {
    expect(
      everyOnboardingQuestionSettled(withStatuses("skipped", { who: "done" })),
    ).toBe(true);
  });

  it("ignores what happens after the confirm screen", () => {
    expect(
      everyOnboardingQuestionSettled(
        withStatuses("done", {
          confirm: "pending",
          "first-result": "pending",
          done: "pending",
        }),
      ),
    ).toBe(true);
  });
});
