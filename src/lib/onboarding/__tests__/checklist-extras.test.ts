/**
 * 1.49 — the checklist's optional "More" group: which rows apply where, the
 * surface gate, the dismissal, and that none of them joins the progress.
 */
import { describe, expect, it } from "vitest";

import { isSurfaceVisible } from "@/lib/modules/surface";

import { buildChecklist, checklistProgress } from "../checklist";
import {
  CHECKLIST_EXTRA_IDS,
  checklistExtraApplies,
  checklistExtraDismissId,
  visibleChecklistExtras,
  type ChecklistExtrasDto,
} from "../checklist-extras";

function presence(
  applies: (id: string) => boolean = () => true,
): ChecklistExtrasDto {
  return Object.fromEntries(
    CHECKLIST_EXTRA_IDS.map((id) => [
      id,
      { applies: applies(id), done: false },
    ]),
  ) as ChecklistExtrasDto;
}

describe("the optional checklist rows", () => {
  it("keeps the guardian's rows in a managed profile and drops the person-only ones", () => {
    const managed = CHECKLIST_EXTRA_IDS.filter((id) =>
      checklistExtraApplies(id, "managed"),
    );
    expect(managed).toEqual(["emergencyCard", "careFeed", "reportSchedule"]);
    expect(
      CHECKLIST_EXTRA_IDS.every((id) => checklistExtraApplies(id, "self")),
    ).toBe(true);
  });

  it("hides the report schedule while the doctor report module is off", () => {
    const rows = visibleChecklistExtras(presence(), {
      dismissed: new Set(),
      surfaceVisible: (id) => isSurfaceVisible(id, { doctorReport: false }),
    });
    expect(rows.map((r) => r.id)).not.toContain("reportSchedule");
    expect(rows.map((r) => r.id)).toContain("emergencyCard");
  });

  it("drops a dismissed row and a row that does not apply", () => {
    const rows = visibleChecklistExtras(
      presence((id) => id !== "iosApp"),
      {
        dismissed: new Set([checklistExtraDismissId("sharing")]),
        surfaceVisible: () => true,
      },
    );
    expect(rows.map((r) => r.id)).toEqual([
      "emergencyCard",
      "careFeed",
      "imports",
      "reportSchedule",
    ]);
  });

  it("opens the iPhone app docs in a new tab and every other row in the app", () => {
    const rows = visibleChecklistExtras(presence(), {
      dismissed: new Set(),
      surfaceVisible: () => true,
    });
    for (const row of rows) {
      expect(row.external, row.id).toBe(row.id === "iosApp");
    }
  });

  it("never counts in the checklist's progress", () => {
    // A dismissed extra id rides the same list and changes nothing here.
    const base = {
      profile: { heightCm: null, dateOfBirth: null, gender: null },
      measurementCount: 0,
      medicationCount: 0,
      dataSourceConnected: false,
      notificationsConfigured: false,
      insightsConfigured: false,
      aiConfigurable: false,
      upcomingVisitCount: 0,
      managedProfileCount: 0,
      onboarding: null,
    };
    const without = checklistProgress(
      buildChecklist({ ...base, dismissedIds: new Set() }),
    );
    const withExtra = checklistProgress(
      buildChecklist({
        ...base,
        dismissedIds: new Set([checklistExtraDismissId("emergencyCard")]),
      }),
    );
    expect(withExtra).toEqual(without);
  });
});
