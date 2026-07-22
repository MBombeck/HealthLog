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
    schedules: [],
    lastTakenAt: null,
    todayEventCount: 0,
    ...overrides,
  };
}

const currentWindow = {
  windowStart: "08:00",
  windowEnd: "11:00",
  daysOfWeek: null,
};

describe("pickDefaultMedicationId", () => {
  it("prefers a current-window medication over the first array item", () => {
    const now = new Date("2026-05-12T08:00:00.000Z");

    expect(
      pickDefaultMedicationId(
        [
          medication("first", { name: "Alpha" }),
          medication("due", {
            name: "Zulu",
            schedules: [currentWindow],
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
        schedules: [currentWindow],
        nextDueAt: "2026-05-13T07:00:00.000Z",
        nextDueOverdue: false,
      }),
      medication("r", { name: "Ramipril" }),
    ];

    expect(pickDefaultMedicationId(options, now)).toBe("r");
    expect(pickDefaultMedicationId([...options].reverse(), now)).toBe("r");
  });
});

describe("resolveMedicationSelectionId", () => {
  it("preserves an explicit user selection when due data changes on re-render", () => {
    const now = new Date("2026-05-12T08:00:00.000Z");
    const initial = [
      medication("manual", { name: "Alpha" }),
      medication("due", {
        name: "Zulu",
        schedules: [currentWindow],
        nextDueAt: "2026-05-12T07:00:00.000Z",
        nextDueOverdue: false,
      }),
    ];

    expect(resolveMedicationSelectionId(initial, null, now)).toBe("due");

    const rerendered = [
      medication("other-due", {
        name: "Beta",
        schedules: [currentWindow],
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
