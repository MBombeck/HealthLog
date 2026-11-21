import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildDoseStatusById,
  groupMedications,
  openByDefault,
  isMedicationDue,
  readStoredOpen,
  writeStoredOpen,
  getGroupKey,
  MedicationGroupHeader,
  type MedicationGroup,
} from "../medication-list-groups";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("groupMedications", () => {
  const t = (key: string) => key;

  it("groups medications by category and omits empty groups", () => {
    const meds = [
      { id: "1", name: "Aspirin", category: "PAIN" },
      { id: "2", name: "Ibuprofen", category: "PAIN" },
      { id: "3", name: "Ramipril", category: "HEART" },
    ];

    const groups = groupMedications(meds, ["HEART", "PAIN"], t);
    expect(groups).toHaveLength(2);
    expect(groups[0].category.key).toBe("HEART");
    expect(groups[0].medications.map((m) => m.name)).toEqual(["Ramipril"]);
    expect(groups[1].category.key).toBe("PAIN");
    expect(groups[1].medications.map((m) => m.name)).toEqual([
      "Aspirin",
      "Ibuprofen",
    ]);
  });

  it("respects categoryOrder and appends unlisted categories", () => {
    const meds = [
      { id: "1", name: "Aspirin", category: "PAIN" },
      { id: "2", name: "Ramipril", category: "HEART" },
      { id: "3", name: "Metformin", category: "DIABETES" },
    ];

    // PAIN is listed first in categoryOrder; HEART and DIABETES should follow
    const groups = groupMedications(meds, ["PAIN"], t);
    expect(groups[0].category.key).toBe("PAIN");
    const remainingKeys = groups.slice(1).map((g) => g.category.key);
    expect(remainingKeys).toContain("HEART");
    expect(remainingKeys).toContain("DIABETES");
  });

  it("preserves medication order within groups", () => {
    const meds = [
      { id: "3", name: "Paracetamol", category: "PAIN" },
      { id: "1", name: "Aspirin", category: "PAIN" },
      { id: "2", name: "Ibuprofen", category: "PAIN" },
    ];

    const groups = groupMedications(meds, [], t);
    expect(groups[0].medications.map((m) => m.name)).toEqual([
      "Paracetamol",
      "Aspirin",
      "Ibuprofen",
    ]);
  });

  it("uses custom category label if provided", () => {
    const meds = [{ id: "1", name: "Custom Med", category: "custom_cat" }];
    const customCategories = [
      { key: "custom_cat", label: "My Custom Category" },
    ];

    const groups = groupMedications(meds, [], t, customCategories);
    expect(groups).toHaveLength(1);
    expect(groups[0].category.key).toBe("custom_cat");
    expect(groups[0].category.label).toBe("My Custom Category");
  });

  it("aligns default category order: built-ins in fixed order, custom categories alphabetically, OTHER last", () => {
    const meds = [
      { id: "1", name: "Other Med", category: "OTHER" },
      {
        id: "2",
        name: "Custom Zebra",
        category: "custom_z",
        categoryLabel: "Zebra Herbs",
      },
      {
        id: "3",
        name: "Custom Alpha",
        category: "custom_a",
        categoryLabel: "Alpha Supplement",
      },
      { id: "4", name: "Blood Pressure Med", category: "BLOOD_PRESSURE" },
      { id: "5", name: "Pain Med", category: "PAIN_RELIEF" },
    ];
    const customCats = [
      { key: "custom_z", label: "Zebra Herbs" },
      { key: "custom_a", label: "Alpha Supplement" },
    ];

    const groups = groupMedications(meds, [], t, customCats);
    const keys = groups.map((g) => g.category.key);
    // BLOOD_PRESSURE is 1st built-in, PAIN_RELIEF is 4th built-in
    // Then custom categories alphabetically by label: "Alpha Supplement" before "Zebra Herbs"
    // Finally OTHER last
    expect(keys).toEqual([
      "BLOOD_PRESSURE",
      "PAIN_RELIEF",
      "custom_a",
      "custom_z",
      "OTHER",
    ]);
  });
});

describe("isMedicationDue & openByDefault in flagged mode", () => {
  const now = new Date("2026-07-24T12:00:00.000Z");

  it("recognises truly due dose status (on_time_window, overdue, missed)", () => {
    expect(
      isMedicationDue(
        { id: "1", active: true },
        {
          doseStatusById: new Map([["1", "on_time_window"]]),
        },
      ),
    ).toBe(true);
    expect(
      isMedicationDue(
        { id: "2", active: true },
        {
          doseStatusById: new Map([["2", "overdue"]]),
        },
      ),
    ).toBe(true);
    expect(
      isMedicationDue(
        { id: "3", active: true },
        {
          doseStatusById: new Map([["3", "missed"]]),
        },
      ),
    ).toBe(true);
  });

  it("treats upcoming dose status as NOT due", () => {
    expect(
      isMedicationDue(
        { id: "1", active: true, nextDueAt: "2026-07-25T08:00:00.000Z" },
        {
          doseStatusById: new Map([["1", "upcoming"]]),
        },
      ),
    ).toBe(false);
  });

  it("covers future scheduled case when dose status is not yet loaded", () => {
    // Scheduled in future (tomorrow), not overdue
    const futureMed = {
      id: "1",
      active: true,
      nextDueAt: "2026-07-25T08:00:00.000Z",
      nextDueOverdue: false,
    };
    expect(isMedicationDue(futureMed, { now })).toBe(false);

    // Overdue flag marks it due even if timestamp looks odd
    const overdueMed = {
      id: "2",
      active: true,
      nextDueAt: "2026-07-25T08:00:00.000Z",
      nextDueOverdue: true,
    };
    expect(isMedicationDue(overdueMed, { now })).toBe(true);

    // Past due timestamp is due
    const pastMed = {
      id: "3",
      active: true,
      nextDueAt: "2026-07-24T10:00:00.000Z",
      nextDueOverdue: false,
    };
    expect(isMedicationDue(pastMed, { now })).toBe(true);
  });

  it("inactive, paused, or asNeeded medications are never due", () => {
    expect(
      isMedicationDue({ id: "1", active: false, nextDueOverdue: true }),
    ).toBe(false);
    expect(
      isMedicationDue({
        id: "2",
        active: true,
        pausedAt: "2026-07-01",
        nextDueOverdue: true,
      }),
    ).toBe(false);
    expect(
      isMedicationDue({
        id: "3",
        active: true,
        asNeeded: true,
        nextDueOverdue: true,
      }),
    ).toBe(false);
  });

  type TestMed = {
    id: string;
    name?: string;
    active?: boolean;
    nextDueAt?: string;
    nextDueOverdue?: boolean;
    pausedAt?: string | null;
    asNeeded?: boolean;
  };

  it("openByDefault('flagged') only opens categories with truly due medications", () => {
    const futureGroup: MedicationGroup<TestMed> = {
      category: { key: "HEART", label: "Heart" },
      medications: [
        {
          id: "m1",
          active: true,
          nextDueAt: "2026-07-25T08:00:00.000Z",
          nextDueOverdue: false,
        },
      ],
    };
    expect(openByDefault(futureGroup, "flagged", { now })).toBe(false);

    const dueGroup: MedicationGroup<TestMed> = {
      category: { key: "PAIN", label: "Pain" },
      medications: [
        {
          id: "m2",
          active: true,
          nextDueAt: "2026-07-24T08:00:00.000Z",
          nextDueOverdue: false,
        },
      ],
    };
    expect(openByDefault(dueGroup, "flagged", { now })).toBe(true);
  });
});

describe("Active vs Inactive group key scoping (prevent collision)", () => {
  it("derives distinct group keys for active vs inactive sections", () => {
    const activeGroup: MedicationGroup<{ id: string; name: string }> = {
      category: { key: "PAIN", label: "Pain" },
      medications: [{ id: "1", name: "Aspirin" }],
      section: "active",
    };
    const inactiveGroup: MedicationGroup<{ id: string; name: string }> = {
      category: { key: "PAIN", label: "Pain" },
      medications: [{ id: "2", name: "Old Ibuprofen" }],
      section: "inactive",
    };

    expect(getGroupKey(activeGroup)).toBe("active:PAIN");
    expect(getGroupKey(inactiveGroup)).toBe("inactive:PAIN");
    expect(getGroupKey(activeGroup)).not.toBe(getGroupKey(inactiveGroup));
  });
});

describe("localStorage persistence for groups open", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        clear: () => store.clear(),
      },
    });
  });

  it("reads empty object when nothing stored", () => {
    expect(readStoredOpen("expanded")).toEqual({});
  });

  it("persists and restores state for matching mode", () => {
    writeStoredOpen("expanded", { HEART: false, PAIN: true });
    expect(readStoredOpen("expanded")).toEqual({ HEART: false, PAIN: true });
  });

  it("ignores stored state when mode differs", () => {
    writeStoredOpen("expanded", { HEART: false });
    expect(readStoredOpen("collapsed")).toEqual({});
  });

  it("survives throwing storage or malformed JSON", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      },
    });
    expect(readStoredOpen("expanded")).toEqual({});
    expect(() => writeStoredOpen("expanded", { HEART: true })).not.toThrow();
  });
});

describe("MedicationGroupHeader accessibility (item 8 regression)", () => {
  it("renders aria-controls when panelId is provided and retains aria-expanded and keyboard access", () => {
    const html = renderToStaticMarkup(
      MedicationGroupHeader({
        category: { key: "PAIN", label: "Pain" },
        count: 3,
        open: true,
        onToggle: vi.fn(),
        panelId: "med-group-active-PAIN",
      }),
    );
    expect(html).toContain('aria-controls="med-group-active-PAIN"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('type="button"');
  });

  it("omits aria-controls when panelId is undefined and retains aria-expanded and keyboard access", () => {
    const html = renderToStaticMarkup(
      MedicationGroupHeader({
        category: { key: "PAIN", label: "Pain" },
        count: 3,
        open: false,
        onToggle: vi.fn(),
      }),
    );
    expect(html).not.toContain("aria-controls");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('type="button"');
  });
});

describe("buildDoseStatusById", () => {
  // The resolved dose at fetch time says upcoming; its due time has passed
  // since, and the card already reads it as due. "Due only" must agree.
  const dose = {
    state: "upcoming",
    dueAt: "2026-11-21T08:00:00.000Z",
    overdueSince: "2026-11-21T09:00:00.000Z",
    missedAfter: "2026-11-21T12:00:00.000Z",
  };
  const rows = [
    {
      medicationId: "m1",
      complianceDisplay: { currentDose: dose },
    },
  ] as unknown as Parameters<typeof buildDoseStatusById>[0];

  it("reads the resolved dose at now, as the card does", () => {
    expect(
      buildDoseStatusById(rows, new Date("2026-11-21T07:59:00.000Z")).get("m1"),
    ).toBe("upcoming");
    expect(
      buildDoseStatusById(rows, new Date("2026-11-21T08:30:00.000Z")).get("m1"),
    ).toBe("on_time_window");
    expect(
      buildDoseStatusById(rows, new Date("2026-11-21T10:00:00.000Z")).get("m1"),
    ).toBe("overdue");
  });

  it("counts a medication without a resolved dose as upcoming", () => {
    expect(
      buildDoseStatusById([
        { medicationId: "m2", complianceDisplay: null },
      ] as unknown as Parameters<typeof buildDoseStatusById>[0]).get("m2"),
    ).toBe("upcoming");
  });
});
