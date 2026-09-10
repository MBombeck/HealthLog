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
  defaultOnboardingSteps,
  emptyOnboardingNeeds,
  isOnboardingSettled,
  ONBOARDING_STEP_IDS,
  parseOnboardingFirstResult,
  parseOnboardingNeeds,
  parseOnboardingSteps,
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

describe("isOnboardingSettled", () => {
  const settled: OnboardingStateDto = {
    steps: ONBOARDING_STEP_IDS.map((id) => ({ id, status: "done" as const })),
    needs: emptyOnboardingNeeds(),
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
});
