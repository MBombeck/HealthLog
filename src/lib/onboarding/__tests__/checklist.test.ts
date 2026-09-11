import { describe, expect, it } from "vitest";

import type { EncounterDTO, EncounterListDTO } from "@/lib/encounters/dto";

import {
  buildChecklist,
  checklistOrderFromNeeds,
  checklistProgress,
  CHECKLIST_BASE_ITEM_IDS,
  CHECKLIST_ITEM_IDS,
  isProfileComplete,
  isStillInSetup,
  shouldShowChecklist,
  trendHintFor,
  upcomingVisitCountFrom,
  visibleChecklist,
  type ChecklistItemId,
} from "../checklist";
import {
  defaultOnboardingSteps,
  emptyOnboardingNeeds,
  type OnboardingNeeds,
  type OnboardingStateDto,
} from "../needs";

/** A setup state the flow really produced: Q1 answered, confirm reached. */
function onboardingState(
  overrides: Partial<OnboardingStateDto> = {},
  needs: Partial<OnboardingNeeds> = {},
): OnboardingStateDto {
  return {
    steps: defaultOnboardingSteps().map((step) => ({
      ...step,
      status: "done" as const,
    })),
    needs: { ...emptyOnboardingNeeds(), recordTarget: "me", ...needs },
    completedAt: "2026-09-10T08:00:00.000Z",
    firstResult: null,
    ...overrides,
  };
}

const completeProfile = {
  heightCm: 175,
  dateOfBirth: "1990-01-01",
  gender: "MALE",
};

function inputs(
  overrides: Partial<Parameters<typeof buildChecklist>[0]> = {},
): Parameters<typeof buildChecklist>[0] {
  return {
    profile: completeProfile,
    measurementCount: 0,
    medicationCount: 0,
    dataSourceConnected: false,
    notificationsConfigured: false,
    insightsConfigured: false,
    dismissedIds: new Set<ChecklistItemId>(),
    upcomingVisitCount: 0,
    managedProfileCount: 0,
    onboarding: null,
    ...overrides,
  };
}

describe("isProfileComplete", () => {
  it("requires height, dob and gender all set", () => {
    expect(isProfileComplete(completeProfile)).toBe(true);
    expect(isProfileComplete({ ...completeProfile, heightCm: null })).toBe(
      false,
    );
    expect(isProfileComplete({ ...completeProfile, dateOfBirth: null })).toBe(
      false,
    );
    expect(isProfileComplete({ ...completeProfile, gender: "" })).toBe(false);
    expect(isProfileComplete({ ...completeProfile, heightCm: 0 })).toBe(false);
  });
});

describe("buildChecklist", () => {
  it("emits the six canonical items in stable order", () => {
    const items = buildChecklist(inputs());
    expect(items.map((i) => i.id)).toEqual([
      "profile",
      "measurement",
      "medication",
      "dataSource",
      "notifications",
      "insights",
    ]);
  });

  it("flags insights done once any provider can serve the user", () => {
    const off = buildChecklist(inputs({ insightsConfigured: false }));
    expect(off.find((i) => i.id === "insights")?.done).toBe(false);
    // `insightsConfigured` is derived from aiAvailable, which is true for a
    // personal key, a local model, an OAuth sign-in, OR the operator's
    // shared key — any one flips the row done.
    const on = buildChecklist(inputs({ insightsConfigured: true }));
    expect(on.find((i) => i.id === "insights")?.done).toBe(true);
  });

  it("marks profile done when all three fields set", () => {
    const items = buildChecklist(inputs());
    expect(items.find((i) => i.id === "profile")?.done).toBe(true);
  });

  it("flags measurement done at first reading", () => {
    const items = buildChecklist(inputs({ measurementCount: 1 }));
    expect(items.find((i) => i.id === "measurement")?.done).toBe(true);
  });

  it("flags medication and dataSource independently", () => {
    const items = buildChecklist(
      inputs({ medicationCount: 2, dataSourceConnected: true }),
    );
    expect(items.find((i) => i.id === "medication")?.done).toBe(true);
    expect(items.find((i) => i.id === "dataSource")?.done).toBe(true);
  });

  it("dataSource is satisfied by any connected source", () => {
    // The predicate is source-agnostic — a single boolean stands in for
    // Withings, WHOOP, Oura, Polar, Nightscout, Fitbit or Apple Health.
    const off = buildChecklist(inputs({ dataSourceConnected: false }));
    expect(off.find((i) => i.id === "dataSource")?.done).toBe(false);
    const on = buildChecklist(inputs({ dataSourceConnected: true }));
    expect(on.find((i) => i.id === "dataSource")?.done).toBe(true);
  });

  it("propagates per-item dismissal", () => {
    const items = buildChecklist(
      inputs({ dismissedIds: new Set<ChecklistItemId>(["medication"]) }),
    );
    expect(items.find((i) => i.id === "medication")?.dismissed).toBe(true);
    expect(items.find((i) => i.id === "profile")?.dismissed).toBe(false);
  });

  it("attaches deep-link hrefs", () => {
    const items = buildChecklist(inputs());
    const hrefs = Object.fromEntries(items.map((i) => [i.id, i.href]));
    expect(hrefs.profile).toBe("/settings/account");
    expect(hrefs.measurement).toBe("/measurements");
    expect(hrefs.medication).toBe("/medications");
    expect(hrefs.dataSource).toBe("/settings/integrations");
    expect(hrefs.notifications).toBe("/settings/notifications");
    expect(hrefs.insights).toBe("/settings/ai");
  });
});

describe("upcomingVisitCountFrom (the visits list's wire shape)", () => {
  it("counts the upcoming array of the body `GET /api/encounters` publishes", () => {
    // The route answers `{ upcoming, past }` as data and publishes no meta;
    // the row read `meta.upcoming` once and could never flip to done.
    const body: EncounterListDTO = { upcoming: [], past: [] };
    expect(upcomingVisitCountFrom(body)).toBe(0);
    const two: EncounterListDTO = {
      upcoming: [{ id: "v1" }, { id: "v2" }] as unknown as EncounterDTO[],
      past: [],
    };
    expect(upcomingVisitCountFrom(two)).toBe(2);
  });

  it("reads a missing or malformed body as no visit", () => {
    expect(upcomingVisitCountFrom(null)).toBe(0);
    expect(upcomingVisitCountFrom(undefined)).toBe(0);
    expect(
      upcomingVisitCountFrom({ upcoming: 3 as unknown as unknown[] }),
    ).toBe(0);
  });
});

describe("answers given for somebody else's record (v1.39 C2)", () => {
  it("adds the profile row and reads none of the child's answers as the guardian's", () => {
    const items = buildChecklist(
      inputs({
        onboarding: onboardingState(
          {},
          {
            recordTarget: "someone-else",
            visit: "within-a-month",
            sources: ["oura"],
          },
        ),
      }),
    );
    const ids = items.map((i) => i.id);
    expect(ids).toContain("managedProfile");
    expect(ids).not.toContain("visit");
    expect(items.find((i) => i.id === "managedProfile")).toMatchObject({
      done: false,
      href: "/settings/access",
    });
    expect(ids[1]).toBe("managedProfile");
  });

  it("is done once a managed profile exists, and offered to both as well", () => {
    const both = buildChecklist(
      inputs({
        onboarding: onboardingState({}, { recordTarget: "both" }),
        managedProfileCount: 1,
      }),
    );
    expect(both.find((i) => i.id === "managedProfile")?.done).toBe(true);
    const me = buildChecklist(
      inputs({ onboarding: onboardingState({}, { recordTarget: "me" }) }),
    );
    expect(me.map((i) => i.id)).not.toContain("managedProfile");
  });
});

describe("the visit row (v1.39 C2)", () => {
  it("exists only for an answer that named a visit within a month", () => {
    const asked = buildChecklist(
      inputs({ onboarding: onboardingState({}, { visit: "within-a-month" }) }),
    );
    expect(asked.map((i) => i.id)).toContain("visit");
    expect(asked.find((i) => i.id === "visit")).toMatchObject({
      done: false,
      href: "/checkups",
    });
    const later = buildChecklist(
      inputs({ onboarding: onboardingState({}, { visit: "later" }) }),
    );
    expect(later.map((i) => i.id)).not.toContain("visit");
    expect(buildChecklist(inputs()).map((i) => i.id)).not.toContain("visit");
  });

  it("is done once a visit is on the calendar", () => {
    const items = buildChecklist(
      inputs({
        onboarding: onboardingState({}, { visit: "within-a-month" }),
        upcomingVisitCount: 1,
      }),
    );
    expect(items.find((i) => i.id === "visit")?.done).toBe(true);
  });

  it("is promoted by the answers like the other needs-shaped rows", () => {
    expect(
      checklistOrderFromNeeds({
        ...emptyOnboardingNeeds(),
        visit: "within-a-month",
      }),
    ).toEqual([
      "profile",
      "visit",
      "measurement",
      "medication",
      "dataSource",
      "notifications",
      "insights",
      "managedProfile",
    ]);
  });
});

describe("visibleChecklist + checklistProgress", () => {
  it("hides per-item dismissed rows from the visible list", () => {
    const items = buildChecklist(
      inputs({ dismissedIds: new Set<ChecklistItemId>(["dataSource"]) }),
    );
    const visible = visibleChecklist(items);
    expect(visible.map((i) => i.id)).not.toContain("dataSource");
  });

  it("counts done items inside the visible subset", () => {
    const items = buildChecklist(
      inputs({
        measurementCount: 3,
        medicationCount: 1,
        // dismiss the ones not done so percent jumps to 100
        dismissedIds: new Set<ChecklistItemId>([
          "dataSource",
          "notifications",
          "insights",
        ]),
      }),
    );
    const progress = checklistProgress(items);
    expect(progress.total).toBe(3);
    expect(progress.done).toBe(3);
    expect(progress.percent).toBe(100);
    expect(progress.allDone).toBe(true);
  });

  it("returns 0% when nothing done", () => {
    const items = buildChecklist({
      profile: { heightCm: null, dateOfBirth: null, gender: null },
      onboarding: null,
      measurementCount: 0,
      medicationCount: 0,
      dataSourceConnected: false,
      notificationsConfigured: false,
      insightsConfigured: false,
      dismissedIds: new Set(),
      upcomingVisitCount: 0,
      managedProfileCount: 0,
    });
    const progress = checklistProgress(items);
    expect(progress.percent).toBe(0);
    expect(progress.allDone).toBe(false);
  });
});

describe("shouldShowChecklist", () => {
  it("hides when user fully dismissed the checklist", () => {
    const items = buildChecklist(inputs());
    expect(
      shouldShowChecklist({
        onboardingCompletedAt: null,
        measurementCount: 0,
        dismissedAll: true,
        items,
      }),
    ).toBe(false);
  });

  it("hides once user has finished onboarding AND has 5+ measurements", () => {
    const items = buildChecklist(inputs({ measurementCount: 10 }));
    expect(
      shouldShowChecklist({
        onboardingCompletedAt: "2026-01-01T00:00:00Z",
        measurementCount: 10,
        dismissedAll: false,
        items,
      }),
    ).toBe(false);
  });

  it("stays visible while onboarding is incomplete", () => {
    const items = buildChecklist(inputs({ measurementCount: 7 }));
    expect(
      shouldShowChecklist({
        onboardingCompletedAt: null,
        measurementCount: 7,
        dismissedAll: false,
        items,
      }),
    ).toBe(true);
  });

  it("stays visible while measurement count under 5 even after onboarding ack", () => {
    const items = buildChecklist(inputs({ measurementCount: 2 }));
    expect(
      shouldShowChecklist({
        onboardingCompletedAt: "2026-01-01T00:00:00Z",
        measurementCount: 2,
        dismissedAll: false,
        items,
      }),
    ).toBe(true);
  });

  it("hides when every visible item is done", () => {
    const items = buildChecklist(
      inputs({
        measurementCount: 3,
        medicationCount: 1,
        dataSourceConnected: true,
        notificationsConfigured: true,
        insightsConfigured: true,
      }),
    );
    expect(
      shouldShowChecklist({
        onboardingCompletedAt: null,
        measurementCount: 3,
        dismissedAll: false,
        items,
      }),
    ).toBe(false);
  });
});

describe("trendHintFor", () => {
  it("hides at 0 readings (chart empty-state owns this)", () => {
    expect(trendHintFor(0)).toEqual({ kind: "hidden" });
  });

  it("shows the right remainder between 1 and 4", () => {
    expect(trendHintFor(1)).toEqual({ kind: "show", remaining: 4 });
    expect(trendHintFor(4)).toEqual({ kind: "show", remaining: 1 });
  });

  it("hides once 5 readings reached", () => {
    expect(trendHintFor(5)).toEqual({ kind: "hidden" });
    expect(trendHintFor(99)).toEqual({ kind: "hidden" });
  });
});

describe("checklistOrderFromNeeds", () => {
  function order(needs: Partial<OnboardingNeeds>) {
    return checklistOrderFromNeeds({ ...emptyOnboardingNeeds(), ...needs });
  }

  it("keeps profile first whatever the answers say", () => {
    for (const needs of [
      {},
      { medication: "yes" as const },
      { sources: ["withings" as const] },
      { areas: ["sleep" as const] },
    ]) {
      expect(order(needs)[0]).toBe("profile");
    }
  });

  it("puts medication second for somebody who takes one on a schedule", () => {
    expect(order({ medication: "yes" })[1]).toBe("medication");
    expect(order({ medication: "sometimes" })[1]).toBe("medication");
    expect(order({ medication: "no" })[1]).not.toBe("medication");
  });

  it("promotes the data source only for a source that is a connection", () => {
    expect(order({ sources: ["withings"] }).indexOf("dataSource")).toBe(1);
    // Typing readings in and uploading a file are not connections, so they
    // say nothing about that row.
    expect(order({ sources: ["manual", "file"] }).indexOf("dataSource")).toBe(
      3,
    );
  });

  it("promotes the reading row once an area was chosen", () => {
    expect(order({ areas: ["blood-pressure"] })[1]).toBe("measurement");
  });

  it("orders medication ahead of the data source when both are answered", () => {
    const ids = order({ medication: "yes", sources: ["oura"] });
    expect(ids.indexOf("medication")).toBeLessThan(ids.indexOf("dataSource"));
  });

  it("never drops or duplicates a row, for any answer combination", () => {
    const combinations: Partial<OnboardingNeeds>[] = [
      {},
      { medication: "yes" },
      { sources: ["manual"] },
      { sources: ["fitbit"] },
      { areas: ["mood", "labs"] },
      { medication: "sometimes", sources: ["nightscout"], areas: ["glucose"] },
    ];
    for (const needs of combinations) {
      const ids = order(needs);
      expect([...ids].sort()).toEqual([...CHECKLIST_ITEM_IDS].sort());
    }
  });
});

describe("buildChecklist, ordered by the setup answers", () => {
  it("keeps the fixed order for a record that never entered the flow", () => {
    expect(buildChecklist(inputs()).map((i) => i.id)).toEqual([
      ...CHECKLIST_BASE_ITEM_IDS,
    ]);
  });

  it("keeps the fixed order while the answers are still being given", () => {
    const items = buildChecklist(
      inputs({
        onboarding: onboardingState(
          { completedAt: null },
          { medication: "yes" },
        ),
      }),
    );
    // Re-ordering the dashboard under somebody mid-question would be movement
    // they did not ask for.
    expect(items.map((i) => i.id)).toEqual([...CHECKLIST_BASE_ITEM_IDS]);
  });

  it("orders the rows from the answers once the flow is confirmed", () => {
    const items = buildChecklist(
      inputs({
        onboarding: onboardingState(
          {},
          { medication: "yes", sources: ["withings"] },
        ),
      }),
    );
    expect(items.map((i) => i.id).slice(0, 3)).toEqual([
      "profile",
      "medication",
      "dataSource",
    ]);
    expect([...items.map((i) => i.id)].sort()).toEqual(
      [...CHECKLIST_BASE_ITEM_IDS].sort(),
    );
  });

  it("carries each row's own state through the reordering", () => {
    const items = buildChecklist(
      inputs({
        medicationCount: 2,
        dismissedIds: new Set<ChecklistItemId>(["insights"]),
        onboarding: onboardingState({}, { medication: "yes" }),
      }),
    );
    expect(items.find((i) => i.id === "medication")?.done).toBe(true);
    expect(items.find((i) => i.id === "insights")?.dismissed).toBe(true);
  });
});

describe("shouldShowChecklist and the setup flow", () => {
  const doneItems = () =>
    buildChecklist(
      inputs({
        measurementCount: 3,
        medicationCount: 1,
        dataSourceConnected: true,
        notificationsConfigured: true,
        insightsConfigured: true,
      }),
    );

  it("no longer disappears at five readings for a record that ran the flow", () => {
    const items = buildChecklist(inputs({ measurementCount: 10 }));
    expect(
      shouldShowChecklist({
        onboardingCompletedAt: "2026-01-01T00:00:00Z",
        measurementCount: 10,
        dismissedAll: false,
        items,
        onboarding: onboardingState(),
      }),
    ).toBe(true);
  });

  it("goes when its rows are done, even for a record that ran the flow", () => {
    expect(
      shouldShowChecklist({
        onboardingCompletedAt: "2026-01-01T00:00:00Z",
        measurementCount: 10,
        dismissedAll: false,
        items: doneItems(),
        onboarding: onboardingState(),
      }),
    ).toBe(false);
  });

  it("goes when the person hides the whole list", () => {
    expect(
      shouldShowChecklist({
        onboardingCompletedAt: null,
        measurementCount: 0,
        dismissedAll: true,
        items: buildChecklist(inputs()),
        onboarding: onboardingState(),
      }),
    ).toBe(false);
  });

  it("stays while the flow is unfinished, even with every row done", () => {
    // The one task the flow offered is not one of the six rows, so "every row
    // done" is not the same statement as "the setup finished".
    expect(
      shouldShowChecklist({
        onboardingCompletedAt: "2026-01-01T00:00:00Z",
        measurementCount: 10,
        dismissedAll: false,
        items: doneItems(),
        onboarding: onboardingState({
          firstResult: {
            task: "log-reading",
            target: null,
            completedAt: null,
          },
        }),
      }),
    ).toBe(true);
  });

  it("does not stay pinned by a first-result task the person passed", () => {
    const state = onboardingState({
      firstResult: { task: "log-reading", target: null, completedAt: null },
    });
    expect(
      shouldShowChecklist({
        onboardingCompletedAt: "2026-01-01T00:00:00Z",
        measurementCount: 10,
        dismissedAll: false,
        items: doneItems(),
        onboarding: {
          ...state,
          steps: state.steps.map((step) =>
            step.id === "first-result"
              ? { ...step, status: "skipped" as const }
              : step,
          ),
        },
      }),
    ).toBe(false);
  });

  it("leaves an account that predates the flow on the rule it already had", () => {
    // The payload publishes the field for every record, so "nine pending
    // steps" must not read as an unfinished setup.
    const untouched: OnboardingStateDto = {
      steps: defaultOnboardingSteps(),
      needs: emptyOnboardingNeeds(),
      completedAt: null,
      firstResult: null,
    };
    expect(
      shouldShowChecklist({
        onboardingCompletedAt: "2026-01-01T00:00:00Z",
        measurementCount: 10,
        dismissedAll: false,
        items: buildChecklist(inputs({ measurementCount: 10 })),
        onboarding: untouched,
      }),
    ).toBe(false);
  });
});

describe("isStillInSetup", () => {
  // The one predicate both the visibility rule and the component's query gate
  // read, so the card can never render with its supporting queries switched
  // off (research I9).
  it("is true for a record that ran the flow, whatever its reading count", () => {
    expect(
      isStillInSetup({
        onboarding: onboardingState(),
        onboardingCompletedAt: "2026-01-01T00:00:00Z",
        measurementCount: 120,
      }),
    ).toBe(true);
  });

  it("is true for a restarted run nobody finished (M-p)", () => {
    const restarted = onboardingState({ completedAt: null });
    expect(
      isStillInSetup({
        onboarding: restarted,
        // `restart` deliberately leaves the account stamp alone.
        onboardingCompletedAt: "2026-01-01T00:00:00Z",
        measurementCount: 120,
      }),
    ).toBe(true);
  });

  it("keeps the pre-flow rule for a record that never entered the flow", () => {
    const untouched: OnboardingStateDto = {
      steps: defaultOnboardingSteps(),
      needs: emptyOnboardingNeeds(),
      completedAt: null,
      firstResult: null,
    };
    expect(
      isStillInSetup({
        onboarding: untouched,
        onboardingCompletedAt: "2026-01-01T00:00:00Z",
        measurementCount: 10,
      }),
    ).toBe(false);
    expect(
      isStillInSetup({
        onboarding: untouched,
        onboardingCompletedAt: "2026-01-01T00:00:00Z",
        measurementCount: 4,
      }),
    ).toBe(true);
    expect(
      isStillInSetup({
        onboarding: null,
        onboardingCompletedAt: null,
        measurementCount: 10,
      }),
    ).toBe(true);
  });

  it("is the rule `shouldShowChecklist` itself applies", () => {
    const args = {
      onboarding: onboardingState(),
      onboardingCompletedAt: "2026-01-01T00:00:00Z",
      measurementCount: 120,
    };
    expect(
      shouldShowChecklist({
        ...args,
        dismissedAll: false,
        items: buildChecklist(inputs({ measurementCount: 120 })),
      }),
    ).toBe(isStillInSetup(args));
  });
});
