import { describe, expect, it } from "vitest";

import {
  gestationalAgeOn,
  pregnancySpans,
  predictionsPausedOn,
  resolvePregnancyState,
} from "@/lib/cycle/pregnancy";
import { decideImportedPregnancyState } from "@/lib/cycle/pregnancy-import";
import { forecastActive } from "@/lib/cycle/engine-adapter";
import {
  mergePregnancyPatch,
  pregnancyPatchProblem,
} from "@/lib/validations/cycle";

describe("resolvePregnancyState", () => {
  it("counts completed weeks and days from the first day", () => {
    const r = resolvePregnancyState(
      { reproductiveState: "PREGNANT", pregnancyStartDate: "2026-06-01" },
      "2026-11-21",
    );
    expect(r.state).toBe("PREGNANT");
    expect(r.gestationalAge).toEqual({ weeks: 24, days: 5 });
    expect(r.predictionsPaused).toBe(true);
  });

  it("counts from the due date less 280 days when no first day is given", () => {
    const r = resolvePregnancyState(
      { reproductiveState: "PREGNANT", pregnancyDueDate: "2027-03-08" },
      "2026-11-21",
    );
    // 2027-03-08 − 280 d = 2026-06-01, the case above.
    expect(r.effectiveStartDate).toBe("2026-06-01");
    expect(r.gestationalAge).toEqual({ weeks: 24, days: 5 });
  });

  it("holds a pregnancy without any date, with no week", () => {
    const r = resolvePregnancyState(
      { reproductiveState: "PREGNANT" },
      "2026-11-21",
    );
    expect(r.state).toBe("PREGNANT");
    expect(r.gestationalAge).toBeNull();
    expect(r.predictionsPaused).toBe(true);
  });

  it("ends the postpartum state after its weeks and resumes the forecast", () => {
    const profile = {
      reproductiveState: "POSTPARTUM" as const,
      deliveryDate: "2026-10-01",
      postpartumWeeks: 4,
    };
    const inside = resolvePregnancyState(profile, "2026-10-28");
    expect(inside.state).toBe("POSTPARTUM");
    expect(inside.postpartumWeek).toBe(3);
    expect(inside.postpartumEndsOn).toBe("2026-10-29");
    const after = resolvePregnancyState(profile, "2026-10-29");
    expect(after.state).toBeNull();
    expect(after.predictionsPaused).toBe(false);
  });

  it("is the ordinary cycle with no state", () => {
    expect(predictionsPausedOn({}, "2026-11-21")).toBe(false);
  });
});

describe("forecastActive", () => {
  const base = { predictionEnabled: true, rawChartMode: false };
  it("is off while a pregnancy holds", () => {
    expect(forecastActive(base, "2026-11-21")).toBe(true);
    expect(
      forecastActive({ ...base, reproductiveState: "PREGNANT" }, "2026-11-21"),
    ).toBe(false);
  });
});

describe("gestationalAgeOn", () => {
  it("is null before the start", () => {
    expect(gestationalAgeOn("2026-06-01", "2026-05-31")).toBeNull();
  });
});

describe("pregnancySpans", () => {
  it("draws the pregnancy to the delivery and the postpartum window", () => {
    expect(
      pregnancySpans({
        reproductiveState: "POSTPARTUM",
        pregnancyStartDate: "2026-01-01",
        deliveryDate: "2026-10-01",
        postpartumWeeks: 2,
      }),
    ).toEqual([
      { kind: "pregnancy", start: "2026-01-01", end: "2026-10-01" },
      { kind: "postpartum", start: "2026-10-01", end: "2026-10-14" },
    ]);
  });
});

describe("pregnancy patch", () => {
  const stored = {
    reproductiveState: "PREGNANT" as const,
    pregnancyStartDate: "2026-06-01",
    pregnancyDueDate: "2027-03-08",
    deliveryDate: null,
    postpartumWeeks: 12,
  };
  it("clears every date with the state", () => {
    expect(mergePregnancyPatch(stored, { state: null })).toEqual({
      reproductiveState: null,
      pregnancyStartDate: null,
      pregnancyDueDate: null,
      deliveryDate: null,
      postpartumWeeks: 12,
    });
  });
  it("checks the merged result as a whole", () => {
    const merged = mergePregnancyPatch(stored, {
      state: "PREGNANT",
      dueDate: "2026-05-01",
    });
    expect(pregnancyPatchProblem(merged, "2026-11-21")).toBe(
      "cycle-prefs.pregnancy.due_before_start",
    );
    expect(
      pregnancyPatchProblem(
        mergePregnancyPatch(stored, { state: "POSTPARTUM" }),
        "2026-11-21",
      ),
    ).toBe("cycle-prefs.pregnancy.delivery_required");
    expect(
      pregnancyPatchProblem(
        mergePregnancyPatch(stored, {
          state: "PREGNANT",
          startDate: "2026-12-01",
        }),
        "2026-11-21",
      ),
    ).toBe("cycle-prefs.pregnancy.start_in_future");
  });
});

describe("decideImportedPregnancyState", () => {
  it("takes an ongoing pregnancy sample", () => {
    expect(
      decideImportedPregnancyState(
        [{ start: "2026-06-01", end: "2027-03-08" }],
        [],
        "2026-11-21",
      ),
    ).toEqual({
      state: "PREGNANT",
      startDate: "2026-06-01",
      sampleStart: "2026-06-01",
    });
  });

  it("does not read an ended pregnancy as a birth on its own", () => {
    expect(
      decideImportedPregnancyState(
        [{ start: "2026-01-01", end: "2026-09-01" }],
        [],
        "2026-11-21",
      ),
    ).toBeNull();
  });

  it("reads a birth from a lactation that began right after", () => {
    expect(
      decideImportedPregnancyState(
        [{ start: "2026-01-01", end: "2026-10-01" }],
        [{ start: "2026-10-03", end: null }],
        "2026-11-21",
      ),
    ).toEqual({
      state: "POSTPARTUM",
      deliveryDate: "2026-10-01",
      sampleStart: "2026-10-03",
    });
    expect(
      decideImportedPregnancyState(
        [{ start: "2026-01-01", end: "2026-08-01" }],
        [{ start: "2026-10-03", end: null }],
        "2026-11-21",
      ),
    ).toBeNull();
  });
});
