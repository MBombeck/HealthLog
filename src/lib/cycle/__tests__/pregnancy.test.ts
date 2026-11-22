import { describe, expect, it } from "vitest";

import {
  gestationalAgeOn,
  pregnancyFieldsFrom,
  pregnancySpans as spansOf,
  predictionsPausedOn as pausedOn,
  resolvePregnancyState as resolveFields,
  resolvePregnancyStateDuring,
  type PregnancyProfileFields,
} from "@/lib/cycle/pregnancy";
import { decideImportedPregnancyState } from "@/lib/cycle/pregnancy-import";
import { forecastActive } from "@/lib/cycle/engine-adapter";
import {
  mergePregnancyPatch,
  pregnancyPatchProblem,
} from "@/lib/validations/cycle";

type Partial_ = Partial<PregnancyProfileFields>;
const resolvePregnancyState = (p: Partial_, day: string) =>
  resolveFields(pregnancyFieldsFrom(p), day);
const predictionsPausedOn = (p: Partial_, day: string) =>
  pausedOn(pregnancyFieldsFrom(p), day);
const pregnancySpans = (p: Partial_) => spansOf(pregnancyFieldsFrom(p));

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

describe("the state is bounded by its dates", () => {
  const pregnant = {
    reproductiveState: "PREGNANT" as const,
    pregnancyStartDate: "2026-09-01",
  };

  it("does not hold before the first day of the pregnancy", () => {
    const r = resolvePregnancyState(pregnant, "2025-12-31");
    expect(r.state).toBeNull();
    expect(r.predictionsPaused).toBe(false);
  });

  it("does not hold four weeks past the due date, and says so", () => {
    // Due 2027-06-08 (start + 280); the last day it holds is 2027-07-06.
    expect(resolvePregnancyState(pregnant, "2027-07-06").state).toBe(
      "PREGNANT",
    );
    const lapsed = resolvePregnancyState(pregnant, "2027-07-07");
    expect(lapsed.state).toBeNull();
    expect(lapsed.lapsed).toBe(true);
    expect(lapsed.gestationalAge).toBeNull();
    // A stored pregnancy never resolves to an impossible week.
    const later = resolvePregnancyState(
      { reproductiveState: "PREGNANT", pregnancyStartDate: "2025-01-01" },
      "2026-11-22",
    );
    expect(later.state).toBeNull();
    expect(later.gestationalAge).toBeNull();
  });

  it("counts the lapse from the due date when one is given", () => {
    const r = resolvePregnancyState(
      { ...pregnant, pregnancyDueDate: "2027-05-20" },
      "2027-06-18",
    );
    expect(r.state).toBeNull();
    expect(r.lapsed).toBe(true);
  });

  it("reads a day before the delivery as the pregnancy, not the postpartum", () => {
    const profile = {
      reproductiveState: "POSTPARTUM" as const,
      pregnancyStartDate: "2026-01-01",
      deliveryDate: "2026-10-01",
      postpartumWeeks: 12,
    };
    const before = resolvePregnancyState(profile, "2026-06-30");
    expect(before.state).toBe("PREGNANT");
    expect(before.gestationalAge).toEqual({ weeks: 25, days: 5 });
    expect(resolvePregnancyState(profile, "2025-12-31").state).toBeNull();
    expect(
      resolvePregnancyState(
        { ...profile, pregnancyStartDate: null },
        "2026-06-30",
      ).state,
    ).toBeNull();
  });

  it("draws an ongoing pregnancy to its last plausible day", () => {
    expect(pregnancySpans(pregnant)).toEqual([
      { kind: "pregnancy", start: "2026-09-01", end: "2027-07-06" },
    ]);
  });
});

describe("resolvePregnancyStateDuring", () => {
  const profile = pregnancyFieldsFrom({
    reproductiveState: "POSTPARTUM",
    pregnancyStartDate: "2026-01-01",
    deliveryDate: "2026-10-01",
    postpartumWeeks: 2,
  });

  it("has no state for a range before the pregnancy", () => {
    expect(
      resolvePregnancyStateDuring(profile, "2025-06-01", "2025-12-31").state,
    ).toBeNull();
  });

  it("reads the range's last day when the state held then", () => {
    const r = resolvePregnancyStateDuring(profile, "2026-09-01", "2026-10-05");
    expect(r.state).toBe("POSTPARTUM");
    expect(r.postpartumWeek).toBe(0);
  });

  it("reads the last day it held when the window closed inside the range", () => {
    const r = resolvePregnancyStateDuring(profile, "2026-10-01", "2026-12-31");
    expect(r.state).toBe("POSTPARTUM");
    expect(r.postpartumWeek).toBe(1);
    expect(
      resolvePregnancyStateDuring(profile, "2026-11-01", "2026-12-31").state,
    ).toBeNull();
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
