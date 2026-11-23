import { describe, expect, it } from "vitest";

import {
  pickDefaultMedicationId,
  resolveMedicationSelectionId,
  type DefaultMedicationOption,
} from "@/lib/medications/default-medication";

function medication(
  id: string,
  overrides: Partial<DefaultMedicationOption> = {},
): DefaultMedicationOption {
  return {
    id,
    name: `Medication ${id}`,
    active: true,
    intakeActionable: true,
    ...overrides,
  };
}

describe("pickDefaultMedicationId", () => {
  it("prefers a medication whose dose is due today over the first array item", () => {
    const now = new Date("2026-05-12T08:00:00.000Z");

    expect(
      pickDefaultMedicationId(
        [
          medication("first", { name: "Alpha" }),
          medication("due", {
            name: "Zulu",
            nextDueAt: "2026-05-12T07:00:00.000Z",
            nextDueOverdue: false,
          }),
        ],
        now,
      ),
    ).toBe("due");
  });

  it("keeps the alphabetical fallback stable when next due is in the future", () => {
    const now = new Date("2026-05-12T08:00:00.000Z");
    const options = [
      medication("z", {
        name: "Zolpidem",
        nextDueAt: "2026-05-13T07:00:00.000Z",
        nextDueOverdue: false,
      }),
      medication("r", { name: "Ramipril" }),
    ];

    expect(pickDefaultMedicationId(options, now)).toBe("r");
    expect(pickDefaultMedicationId([...options].reverse(), now)).toBe("r");
  });

  it("prefers an overdue dose, then the earliest dose of today", () => {
    const now = new Date("2026-05-12T10:00:00.000Z");
    const options = [
      medication("later", {
        name: "Alpha",
        nextDueAt: "2026-05-12T18:00:00.000Z",
      }),
      medication("sooner", {
        name: "Beta",
        nextDueAt: "2026-05-12T12:00:00.000Z",
      }),
    ];
    expect(pickDefaultMedicationId(options, now, "UTC")).toBe("sooner");
    expect(
      pickDefaultMedicationId(
        [
          ...options,
          medication("overdue", {
            name: "Zulu",
            nextDueAt: "2026-05-12T07:00:00.000Z",
            nextDueOverdue: true,
          }),
        ],
        now,
        "UTC",
      ),
    ).toBe("overdue");
  });

  it("never preselects an ended course, even when it is the only active one", () => {
    // Still active (not archived) but the course ended: the server answers
    // `intakeActionable: false`, the list keeps it for back-filling, and the
    // default lands on the medication that offers a dose today.
    const options = [
      medication("ended", {
        name: "Amoxicillin",
        active: true,
        intakeActionable: false,
      }),
      medication("current", { name: "Ramipril" }),
    ];
    expect(pickDefaultMedicationId(options)).toBe("current");
    expect(
      pickDefaultMedicationId([
        medication("ended", { active: true, intakeActionable: false }),
      ]),
    ).toBeNull();
  });
});

describe("resolveMedicationSelectionId", () => {
  it("preserves an explicit user selection when due data changes on re-render", () => {
    const now = new Date("2026-05-12T08:00:00.000Z");
    const initial = [
      medication("manual", { name: "Alpha" }),
      medication("due", {
        name: "Zulu",
        nextDueAt: "2026-05-12T07:00:00.000Z",
        nextDueOverdue: false,
      }),
    ];

    expect(resolveMedicationSelectionId(initial, null, now)).toBe("due");

    const rerendered = [
      medication("other-due", {
        name: "Beta",
        nextDueAt: "2026-05-12T07:00:00.000Z",
        nextDueOverdue: true,
      }),
      ...initial,
    ];
    expect(resolveMedicationSelectionId(rerendered, "manual", now)).toBe(
      "manual",
    );
  });
});
