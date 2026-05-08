import { describe, expect, it } from "vitest";

import {
  buildChecklist,
  checklistProgress,
  isProfileComplete,
  shouldShowChecklist,
  trendHintFor,
  visibleChecklist,
  type ChecklistItemId,
} from "../checklist";

const completeProfile = {
  heightCm: 175,
  dateOfBirth: "1990-01-01",
  gender: "MALE",
};

function inputs(overrides: Partial<Parameters<typeof buildChecklist>[0]> = {}) {
  return {
    profile: completeProfile,
    measurementCount: 0,
    medicationCount: 0,
    withingsConnected: false,
    notificationsConfigured: false,
    dismissedIds: new Set<ChecklistItemId>(),
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
  it("emits the five canonical items in stable order", () => {
    const items = buildChecklist(inputs());
    expect(items.map((i) => i.id)).toEqual([
      "profile",
      "measurement",
      "medication",
      "withings",
      "notifications",
    ]);
  });

  it("marks profile done when all three fields set", () => {
    const items = buildChecklist(inputs());
    expect(items.find((i) => i.id === "profile")?.done).toBe(true);
  });

  it("flags measurement done at first reading", () => {
    const items = buildChecklist(inputs({ measurementCount: 1 }));
    expect(items.find((i) => i.id === "measurement")?.done).toBe(true);
  });

  it("flags medication and withings independently", () => {
    const items = buildChecklist(
      inputs({ medicationCount: 2, withingsConnected: true }),
    );
    expect(items.find((i) => i.id === "medication")?.done).toBe(true);
    expect(items.find((i) => i.id === "withings")?.done).toBe(true);
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
    expect(hrefs.profile).toBe("/settings#profile");
    expect(hrefs.measurement).toBe("/measurements");
    expect(hrefs.medication).toBe("/medications");
    expect(hrefs.withings).toBe("/settings#withings");
    expect(hrefs.notifications).toBe("/settings#notifications");
  });
});

describe("visibleChecklist + checklistProgress", () => {
  it("hides per-item dismissed rows from the visible list", () => {
    const items = buildChecklist(
      inputs({ dismissedIds: new Set<ChecklistItemId>(["withings"]) }),
    );
    const visible = visibleChecklist(items);
    expect(visible.map((i) => i.id)).not.toContain("withings");
  });

  it("counts done items inside the visible subset", () => {
    const items = buildChecklist(
      inputs({
        measurementCount: 3,
        medicationCount: 1,
        // dismiss the only one not done so percent jumps to 100
        dismissedIds: new Set<ChecklistItemId>(["withings", "notifications"]),
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
      measurementCount: 0,
      medicationCount: 0,
      withingsConnected: false,
      notificationsConfigured: false,
      dismissedIds: new Set(),
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
        withingsConnected: true,
        notificationsConfigured: true,
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
