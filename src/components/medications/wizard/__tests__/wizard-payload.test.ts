import { describe, expect, it } from "vitest";

import {
  addSchedule,
  buildCreateBody,
  commitActiveDraft,
  emptyWizardPayload,
  firstInvalidIndex,
  hydrateWizardPayload,
  landingStepForEdit,
  type MedicationPayload,
  progressIndices,
  removeSchedule,
  rowFromTreatment,
  setActiveSchedule,
  summariseCadence,
  summariseScheduleDraft,
  validateStep,
  type WizardPayload,
  WIZARD_TREATMENT_MAPPING,
  type WizardTreatmentRow,
} from "@/components/medications/wizard/wizard-payload";
import { encodeCadence } from "@/components/medications/scheduling/cadence-picker";
import {
  type CadenceKind,
  DEFAULT_SUB_CONTROLS,
} from "@/components/medications/scheduling/types";

/**
 * v1.5.4 — wizard payload pure-helper tests.
 *
 * Project convention is SSR-only Vitest (no `@testing-library/react`).
 * The interactive dialog is covered by Playwright; the pure helpers
 * here carry the unit-test contract:
 *
 *   - `validateStep` — per-step gate boolean.
 *   - `progressIndices` — path table for the visible counter.
 *   - `buildCreateBody` — POST/PUT request body encoder, incl. the
 *     Step 2 → (treatmentClass, category) mapping.
 *   - `summariseCadence` — Step 8 plain-language summary.
 *   - `hydrateWizardPayload` — edit-path hydration, esp. the legacy
 *     `(daysOfWeek, intervalWeeks)` bridge.
 */

function makeStubT() {
  return (key: string, params?: Record<string, string | number>): string => {
    if (!params) return key;
    return `${key}(${JSON.stringify(params)})`;
  };
}

function withCadence(
  kind: CadenceKind,
  sub: Partial<typeof DEFAULT_SUB_CONTROLS> = {},
): WizardPayload {
  const subControls = { ...DEFAULT_SUB_CONTROLS, ...sub };
  return {
    ...emptyWizardPayload(),
    mode: kind === "oneShot" ? "oneShot" : "recurring",
    treatmentRow: "other",
    name: "Foo",
    doseAmount: "5",
    doseUnit: "mg",
    cadence: encodeCadence(kind, subControls),
    subControls,
  };
}

describe("progressIndices", () => {
  it("returns the 8-step recurring path before the user picks a mode", () => {
    expect(progressIndices(null, "daily")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("returns the 5-step one-shot path for oneShot mode", () => {
    expect(progressIndices("oneShot", "oneShot")).toEqual([1, 2, 3, 4, 8]);
  });

  it("returns the 7-step daily path when recurring + daily cadence", () => {
    expect(progressIndices("recurring", "daily")).toEqual([
      1, 2, 3, 4, 5, 7, 8,
    ]);
  });

  it("returns the 8-step recurring path for non-daily cadences", () => {
    for (const kind of [
      "weekdays",
      "everyNWeeks",
      "monthly",
      "rolling",
    ] as const) {
      expect(progressIndices("recurring", kind)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
    }
  });
});

describe("validateStep", () => {
  it("step 1: rejects empty name; accepts populated", () => {
    const base = emptyWizardPayload();
    expect(validateStep(base, 1)).toBe(false);
    expect(validateStep({ ...base, name: "Foo" }, 1)).toBe(true);
    expect(validateStep({ ...base, name: "   " }, 1)).toBe(false);
  });

  it("step 2: requires a treatment row", () => {
    const base = emptyWizardPayload();
    expect(validateStep(base, 2)).toBe(false);
    expect(validateStep({ ...base, treatmentRow: "bloodPressure" }, 2)).toBe(
      true,
    );
  });

  it("step 3: requires populated dose amount", () => {
    const base = emptyWizardPayload();
    expect(validateStep(base, 3)).toBe(false);
    expect(validateStep({ ...base, doseAmount: "5" }, 3)).toBe(true);
  });

  it("step 4: rejects null startsOn", () => {
    const base = emptyWizardPayload();
    expect(validateStep({ ...base, startsOn: null }, 4)).toBe(false);
  });

  it("step 4: rejects endsOn before startsOn", () => {
    const base = emptyWizardPayload();
    const start = new Date(Date.UTC(2026, 5, 1));
    const earlier = new Date(Date.UTC(2026, 4, 1));
    expect(validateStep({ ...base, startsOn: start, endsOn: earlier }, 4)).toBe(
      false,
    );
  });

  it("step 4: accepts null endsOn (chronic)", () => {
    const base = emptyWizardPayload();
    expect(
      validateStep(
        { ...base, startsOn: new Date(Date.UTC(2026, 5, 1)), endsOn: null },
        4,
      ),
    ).toBe(true);
  });

  it("step 5: requires a mode pick", () => {
    const base = emptyWizardPayload();
    expect(validateStep(base, 5)).toBe(false);
    expect(validateStep({ ...base, mode: "recurring" }, 5)).toBe(true);
    expect(validateStep({ ...base, mode: "oneShot" }, 5)).toBe(true);
  });

  it("step 6: weekdays requires >= 1 chip", () => {
    expect(validateStep(withCadence("weekdays", { weekdays: [] }), 6)).toBe(
      false,
    );
    expect(validateStep(withCadence("weekdays", { weekdays: ["MO"] }), 6)).toBe(
      true,
    );
  });

  it("step 6: monthly accepts day-of-month 1..31", () => {
    expect(validateStep(withCadence("monthly", { dayOfMonth: 1 }), 6)).toBe(
      true,
    );
    expect(validateStep(withCadence("monthly", { dayOfMonth: 31 }), 6)).toBe(
      true,
    );
  });

  it("step 6: rolling accepts 1..365 days", () => {
    expect(validateStep(withCadence("rolling", { rollingDays: 1 }), 6)).toBe(
      true,
    );
    expect(validateStep(withCadence("rolling", { rollingDays: 365 }), 6)).toBe(
      true,
    );
  });

  it("step 7: requires >= 1 valid HH:mm time", () => {
    const base = withCadence("daily");
    expect(validateStep({ ...base, timesOfDay: [] }, 7)).toBe(false);
    expect(validateStep({ ...base, timesOfDay: ["nope"] }, 7)).toBe(false);
    expect(validateStep({ ...base, timesOfDay: ["08:00"] }, 7)).toBe(true);
  });

  it("step 8: mirrors step 4 (course-window range)", () => {
    const base = withCadence("daily");
    expect(validateStep({ ...base, startsOn: null }, 8)).toBe(false);
    const start = new Date(Date.UTC(2026, 5, 1));
    expect(validateStep({ ...base, startsOn: start, endsOn: null }, 8)).toBe(
      true,
    );
  });
});

/**
 * v1.8.6 W4b — `firstInvalidIndex` is the multi-step forward lookahead
 * that powers the dot stepper's jump gate (`goToStep`) and its
 * `reachableUntil` ceiling. The dialog's rule:
 *   - backward jumps are always allowed;
 *   - a forward jump to path-index `j` is allowed iff every gate from
 *     the active slot up to (but not including) `j` validates, which is
 *     exactly `firstInvalidIndex(payload, stepList, from) >= j`.
 */
describe("firstInvalidIndex — forward-jump lookahead", () => {
  /** A daily-path payload with every gate satisfied. */
  function completeDaily(): WizardPayload {
    return {
      ...withCadence("daily"),
      startsOn: new Date(Date.UTC(2026, 5, 1)),
      endsOn: null,
      timesOfDay: ["08:00"],
    };
  }

  it("returns stepList.length when every slot from the index validates", () => {
    const payload = completeDaily();
    const list = progressIndices(payload.mode, payload.cadence.kind);
    expect(firstInvalidIndex(payload, list, 0)).toBe(list.length);
  });

  it("stops at the first failing slot — blank name gates the path at 0", () => {
    const payload = { ...completeDaily(), name: "   " };
    const list = progressIndices(payload.mode, payload.cadence.kind);
    // Step 1 (index 0) fails its gate, so no forward jump is allowed.
    expect(firstInvalidIndex(payload, list, 0)).toBe(0);
  });

  it("a missing dose gates the path at Step 3 (path-index 2)", () => {
    const payload = { ...completeDaily(), doseAmount: "" };
    const list = progressIndices(payload.mode, payload.cadence.kind);
    // [1,2,3,...] — Step 3 sits at index 2; it's the first to fail.
    expect(firstInvalidIndex(payload, list, 0)).toBe(2);
  });

  it("blocks a forward jump past an invalid intervening step", () => {
    // Missing times (Step 7) — daily path is [1,2,3,4,5,7,8]; Step 7
    // sits at index 5. A jump from Step 1 (index 0) to the review slot
    // (Step 8, index 6) must be refused because index 5 fails.
    const payload = { ...completeDaily(), timesOfDay: [] };
    const list = progressIndices(payload.mode, payload.cadence.kind);
    const firstInvalid = firstInvalidIndex(payload, list, 0);
    expect(firstInvalid).toBe(5);
    const targetIndex = list.indexOf(8);
    // Gate rule: forward jump allowed iff firstInvalid >= targetIndex.
    expect(firstInvalid >= targetIndex).toBe(false);
  });

  it("allows a forward jump when all intervening gates pass", () => {
    const payload = completeDaily();
    const list = progressIndices(payload.mode, payload.cadence.kind);
    const fromIndex = 0;
    const targetIndex = list.indexOf(8);
    expect(firstInvalidIndex(payload, list, fromIndex) >= targetIndex).toBe(
      true,
    );
  });

  it("a fully-hydrated edit payload makes jump-to-last (review) reachable", () => {
    // Edit hydration populates every field, so on the recurring path
    // every gate validates and the whole path is reachable — including
    // the final review slot, so jump-to-last is one tap.
    const initial: MedicationPayload = {
      id: "med-1",
      name: "Ramipril",
      dose: "5 mg",
      category: "BLOOD_PRESSURE",
      treatmentClass: "GENERIC",
      deliveryForm: "ORAL",
      notificationsEnabled: true,
      startsOn: new Date(Date.UTC(2026, 5, 1)),
      endsOn: null,
      oneShot: false,
      schedules: [
        {
          windowStart: "06:00",
          windowEnd: "22:00",
          timesOfDay: ["08:00"],
          rrule: "FREQ=DAILY",
          rollingIntervalDays: null,
        },
      ],
    };
    const payload = hydrateWizardPayload(initial);
    const list = progressIndices(payload.mode, payload.cadence.kind);
    expect(firstInvalidIndex(payload, list, 0)).toBe(list.length);
    // Whole-path validity → jump-to-last enabled.
    expect(firstInvalidIndex(payload, list, 0) >= list.length).toBe(true);
  });
});

describe("WIZARD_TREATMENT_MAPPING — Step 2 row → request body", () => {
  it("maps Blutdruck → (GENERIC, BLOOD_PRESSURE)", () => {
    expect(WIZARD_TREATMENT_MAPPING.bloodPressure).toEqual({
      treatmentClass: "GENERIC",
      category: "BLOOD_PRESSURE",
    });
  });

  it("maps Diabetes → (GENERIC, DIABETES) — new in v1.5.4", () => {
    expect(WIZARD_TREATMENT_MAPPING.diabetes).toEqual({
      treatmentClass: "GENERIC",
      category: "DIABETES",
    });
  });

  it("maps Antibiotikum → (GENERIC, ANTIBIOTIC) — new in v1.5.4", () => {
    expect(WIZARD_TREATMENT_MAPPING.antibiotic).toEqual({
      treatmentClass: "GENERIC",
      category: "ANTIBIOTIC",
    });
  });

  it("maps GLP-1-Injektion → (GLP1, OTHER) — only row with GLP1", () => {
    expect(WIZARD_TREATMENT_MAPPING.glp1).toEqual({
      treatmentClass: "GLP1",
      category: "OTHER",
    });
  });

  it("every row picks GENERIC except glp1", () => {
    const rows: WizardTreatmentRow[] = [
      "bloodPressure",
      "diabetes",
      "hormone",
      "painRelief",
      "allergy",
      "vitamin",
      "supplement",
      "antibiotic",
      "other",
    ];
    for (const row of rows) {
      expect(WIZARD_TREATMENT_MAPPING[row].treatmentClass).toBe("GENERIC");
    }
  });
});

describe("rowFromTreatment — reverse mapping for edit-hydration", () => {
  it("GLP1 treatment class wins over category", () => {
    expect(rowFromTreatment("GLP1", "OTHER")).toBe("glp1");
    expect(rowFromTreatment("GLP1", "BLOOD_PRESSURE")).toBe("glp1");
  });

  it("DIABETES category maps to the diabetes row", () => {
    expect(rowFromTreatment("GENERIC", "DIABETES")).toBe("diabetes");
  });

  it("ANTIBIOTIC category maps to the antibiotic row", () => {
    expect(rowFromTreatment("GENERIC", "ANTIBIOTIC")).toBe("antibiotic");
  });

  it("unknown category falls back to 'other'", () => {
    expect(rowFromTreatment("GENERIC", "MYSTERY")).toBe("other");
    expect(rowFromTreatment(undefined, undefined)).toBe("other");
  });
});

describe("buildCreateBody", () => {
  it("emits a daily recurring schedule with the rrule slot", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      treatmentRow: "bloodPressure",
      timesOfDay: ["08:00"],
      startsOn: new Date(Date.UTC(2026, 4, 28)),
      endsOn: null,
    };
    const body = buildCreateBody(p);
    expect(body.name).toBe("Foo");
    expect(body.dose).toBe("5 mg");
    expect(body.oneShot).toBe(false);
    expect(body.treatmentClass).toBe("GENERIC");
    expect(body.category).toBe("BLOOD_PRESSURE");
    expect(body.notificationsEnabled).toBe(true);
    expect(body.startsOn).toBe("2026-05-28");
    expect(body.endsOn).toBeUndefined();
    expect(body.schedules).toHaveLength(1);
    expect(body.schedules[0].rrule).toBe("FREQ=DAILY");
    expect(body.schedules[0].timesOfDay).toEqual(["08:00"]);
    expect(body.schedules[0].windowStart).toBe("08:00");
    expect(body.schedules[0].windowEnd).toBe("09:00");
  });

  it("carries unitsPerDose onto the body and round-trips it on edit-hydrate (v1.16.10)", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      treatmentRow: "bloodPressure",
      timesOfDay: ["08:00"],
      startsOn: new Date(Date.UTC(2026, 4, 28)),
      endsOn: null,
      unitsPerDose: "2",
    };
    expect(buildCreateBody(p).unitsPerDose).toBe(2);

    // The default "1" still ships (an edit back to 1 must reach the server).
    expect(buildCreateBody({ ...p, unitsPerDose: "1" }).unitsPerDose).toBe(1);
    // An empty field omits it (server default applies).
    expect(
      buildCreateBody({ ...p, unitsPerDose: "" }).unitsPerDose,
    ).toBeUndefined();

    const hydrated = hydrateWizardPayload({
      id: "m1",
      name: "Foo",
      dose: "5 mg",
      category: "BLOOD_PRESSURE",
      unitsPerDose: 2,
      notificationsEnabled: true,
      startsOn: null,
      endsOn: null,
      oneShot: false,
      schedules: [],
    });
    expect(hydrated.unitsPerDose).toBe("2");
    // Absent on the snapshot → the default 1.
    const hydratedDefault = hydrateWizardPayload({
      id: "m1",
      name: "Foo",
      dose: "5 mg",
      category: "BLOOD_PRESSURE",
      notificationsEnabled: true,
      startsOn: null,
      endsOn: null,
      oneShot: false,
      schedules: [],
    });
    expect(hydratedDefault.unitsPerDose).toBe("1");
  });

  it("carries a per-slot dose + units onto the body and round-trips them on edit-hydrate (#219)", () => {
    // A split plan: this schedule takes half a tablet, overriding the
    // medication-level dose + units. The flat mirror is what Step 7 writes.
    const p: WizardPayload = {
      ...withCadence("daily"),
      treatmentRow: "bloodPressure",
      timesOfDay: ["12:00"],
      startsOn: new Date(Date.UTC(2026, 4, 28)),
      endsOn: null,
      scheduleDose: "0.5 tablet",
      scheduleUnitsPerDose: "0.5",
    };
    const body = buildCreateBody(p);
    // This is the assertion that goes RED when the encode path stops
    // emitting the per-slot fields on save.
    expect(body.schedules[0].dose).toBe("0.5 tablet");
    expect(body.schedules[0].unitsPerDose).toBe(0.5);

    // A blank override omits both, so the schedule inherits the med level.
    const inherit = buildCreateBody({
      ...p,
      scheduleDose: "",
      scheduleUnitsPerDose: "",
    });
    expect(inherit.schedules[0].dose).toBeUndefined();
    expect(inherit.schedules[0].unitsPerDose).toBeUndefined();

    // Edit-hydrate: a persisted schedule carrying the split round-trips back
    // onto the draft (and the flat mirror) so an edit keeps it.
    const hydrated = hydrateWizardPayload({
      id: "m1",
      name: "Foo",
      dose: "1 tablet",
      category: "BLOOD_PRESSURE",
      notificationsEnabled: true,
      startsOn: null,
      endsOn: null,
      oneShot: false,
      schedules: [
        {
          windowStart: "12:00",
          windowEnd: "13:00",
          timesOfDay: ["12:00"],
          rrule: "FREQ=DAILY",
          dose: "0.5 tablet",
          unitsPerDose: 0.5,
        },
      ],
    });
    expect(hydrated.scheduleDose).toBe("0.5 tablet");
    expect(hydrated.scheduleUnitsPerDose).toBe("0.5");
    expect(hydrated.schedules[0].dose).toBe("0.5 tablet");
    expect(hydrated.schedules[0].unitsPerDose).toBe("0.5");
  });

  it("reads a typed units-per-dose value with a comma, a slash or a glyph (#1034)", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      treatmentRow: "bloodPressure",
      timesOfDay: ["08:00"],
      startsOn: new Date(Date.UTC(2026, 4, 28)),
      endsOn: null,
    };
    // parseFloat("1,5") is 1; the body must carry 1.5.
    expect(buildCreateBody({ ...p, unitsPerDose: "1,5" }).unitsPerDose).toBe(
      1.5,
    );
    expect(buildCreateBody({ ...p, unitsPerDose: "1 1/2" }).unitsPerDose).toBe(
      1.5,
    );
    expect(buildCreateBody({ ...p, unitsPerDose: "2¼" }).unitsPerDose).toBe(
      2.25,
    );
    // The per-slot override goes through the same reader.
    expect(
      buildCreateBody({ ...p, scheduleUnitsPerDose: "1,5" }).schedules[0]
        .unitsPerDose,
    ).toBe(1.5);
    // Edit-hydrate keeps a mixed value.
    const hydrated = hydrateWizardPayload({
      id: "m1",
      name: "Foo",
      dose: "5 mg",
      category: "BLOOD_PRESSURE",
      unitsPerDose: 1.5,
      notificationsEnabled: true,
      startsOn: null,
      endsOn: null,
      oneShot: false,
      schedules: [],
    });
    expect(hydrated.unitsPerDose).toBe("1.5");
  });

  it("holds the dose and times steps while a typed units-per-dose value is invalid (#1034)", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      name: "Foo",
      doseAmount: "5",
      treatmentRow: "bloodPressure",
      timesOfDay: ["08:00"],
      startsOn: new Date(Date.UTC(2026, 4, 28)),
      endsOn: null,
    };
    expect(validateStep({ ...p, unitsPerDose: "1,5" }, 3)).toBe(true);
    expect(validateStep({ ...p, unitsPerDose: "abc" }, 3)).toBe(false);
    expect(validateStep({ ...p, unitsPerDose: "0" }, 3)).toBe(false);
    expect(validateStep({ ...p, unitsPerDose: "101" }, 3)).toBe(false);
    expect(validateStep({ ...p, unitsPerDose: "" }, 3)).toBe(false);
    // Step 7: blank means "inherit"; anything typed must be valid.
    expect(validateStep({ ...p, scheduleUnitsPerDose: "" }, 7)).toBe(true);
    expect(validateStep({ ...p, scheduleUnitsPerDose: "1 1/2" }, 7)).toBe(true);
    expect(validateStep({ ...p, scheduleUnitsPerDose: "1,2,3" }, 7)).toBe(
      false,
    );
  });

  it("emits DIABETES category for the diabetes row", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      treatmentRow: "diabetes",
      timesOfDay: ["08:00"],
      startsOn: new Date(Date.UTC(2026, 4, 28)),
    };
    expect(buildCreateBody(p).category).toBe("DIABETES");
    expect(buildCreateBody(p).treatmentClass).toBe("GENERIC");
  });

  it("emits ANTIBIOTIC category for the antibiotic row", () => {
    const p: WizardPayload = {
      ...withCadence("oneShot"),
      treatmentRow: "antibiotic",
      timesOfDay: ["09:00"],
      startsOn: new Date(Date.UTC(2026, 4, 28)),
      endsOn: new Date(Date.UTC(2026, 4, 28)),
    };
    expect(buildCreateBody(p).category).toBe("ANTIBIOTIC");
  });

  it("emits the GLP1 treatmentClass for the glp1 row", () => {
    const p: WizardPayload = {
      ...withCadence("everyNWeeks", {
        intervalWeeks: 1,
        weekdays: ["WE"],
      }),
      treatmentRow: "glp1",
      timesOfDay: ["08:00"],
      startsOn: new Date(Date.UTC(2026, 4, 28)),
    };
    const body = buildCreateBody(p);
    expect(body.treatmentClass).toBe("GLP1");
    expect(body.category).toBe("OTHER");
  });

  it("emits bi-weekly RRULE for everyNWeeks (n=2, Wednesday)", () => {
    const p: WizardPayload = {
      ...withCadence("everyNWeeks", {
        intervalWeeks: 2,
        weekdays: ["WE"],
      }),
      timesOfDay: ["08:00"],
      startsOn: new Date(Date.UTC(2026, 4, 28)),
    };
    const body = buildCreateBody(p);
    expect(body.schedules[0].rrule).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=WE");
    expect(body.schedules[0].rollingIntervalDays).toBeUndefined();
  });

  it("emits monthly RRULE with BYMONTHDAY", () => {
    const p: WizardPayload = {
      ...withCadence("monthly", { dayOfMonth: 15 }),
      timesOfDay: ["08:00"],
      startsOn: new Date(Date.UTC(2026, 4, 28)),
    };
    const body = buildCreateBody(p);
    expect(body.schedules[0].rrule).toBe("FREQ=MONTHLY;BYMONTHDAY=15");
  });

  it("emits rollingIntervalDays instead of rrule for rolling", () => {
    const p: WizardPayload = {
      ...withCadence("rolling", { rollingDays: 7 }),
      timesOfDay: ["08:00"],
      startsOn: new Date(Date.UTC(2026, 4, 28)),
    };
    const body = buildCreateBody(p);
    expect(body.schedules[0].rrule).toBeUndefined();
    expect(body.schedules[0].rollingIntervalDays).toBe(7);
  });

  it("emits oneShot=true with no recurrence and endsOn = startsOn", () => {
    const start = new Date(Date.UTC(2026, 9, 15));
    const p: WizardPayload = {
      ...withCadence("oneShot"),
      timesOfDay: ["09:00"],
      startsOn: start,
      endsOn: start,
    };
    const body = buildCreateBody(p);
    expect(body.oneShot).toBe(true);
    expect(body.startsOn).toBe("2026-10-15");
    expect(body.endsOn).toBe("2026-10-15");
    expect(body.schedules[0].rrule).toBeUndefined();
    expect(body.schedules[0].rollingIntervalDays).toBeUndefined();
  });

  it("threads notificationsEnabled through on create", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      notificationsEnabled: false,
      timesOfDay: ["08:00"],
      startsOn: new Date(Date.UTC(2026, 4, 28)),
    };
    expect(buildCreateBody(p).notificationsEnabled).toBe(false);
    expect(buildCreateBody(p, "create").notificationsEnabled).toBe(false);
  });

  // v1.5.5 D-3 §10 invariant 16 — the wizard never round-trips the
  // notifications default back to the API on edit. The detail-page
  // notifications switch is the single source of truth post-create;
  // omitting the field on edit keeps the wizard from clobbering it
  // when the user opens + saves without changing anything else.
  it("omits notificationsEnabled on edit", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      notificationsEnabled: false,
      timesOfDay: ["08:00"],
      startsOn: new Date(Date.UTC(2026, 4, 28)),
    };
    const body = buildCreateBody(p, "edit");
    expect(body.notificationsEnabled).toBeUndefined();
    expect("notificationsEnabled" in body).toBe(false);
  });
});

describe("summariseCadence", () => {
  const t = makeStubT();

  it("uses 'daily' for the daily cadence", () => {
    const out = summariseCadence(withCadence("daily"), t);
    expect(out).toContain("medications.wizard.summary.cadence.daily");
  });

  it("uses 'biweekly' for everyNWeeks with n=2", () => {
    const out = summariseCadence(
      withCadence("everyNWeeks", { intervalWeeks: 2 }),
      t,
    );
    expect(out).toContain("medications.wizard.summary.cadence.biweekly");
  });

  it("uses 'rolling' and threads the day count", () => {
    const p = withCadence("rolling", { rollingDays: 14 });
    const out = summariseCadence(p, t);
    expect(out).toMatch(/cadence\.rolling[^|]*"n":14/);
  });

  it("uses 'oneShot' and omits the times / endsOn phrases", () => {
    const start = new Date(Date.UTC(2026, 9, 15));
    const p: WizardPayload = {
      ...withCadence("oneShot"),
      startsOn: start,
      endsOn: start,
    };
    const out = summariseCadence(p, t);
    expect(out).toContain("medications.wizard.summary.cadence.oneShot");
    expect(out).not.toContain("summary.endsOn");
    expect(out).not.toContain("summary.times");
  });

  it("surfaces 'noEndDate' when recurring + endsOn null", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      startsOn: new Date(Date.UTC(2026, 4, 28)),
      endsOn: null,
    };
    expect(summariseCadence(p, t)).toContain(
      "medications.wizard.summary.noEndDate",
    );
  });

  it("appends a weekdays-detail phrase for the weekday cadence", () => {
    const p = withCadence("weekdays", { weekdays: ["MO", "WE", "FR"] });
    const out = summariseCadence(p, t);
    expect(out).toContain("medications.wizard.summary.weekdaysDetail");
  });

  it("appends day-of-month detail for the monthly cadence", () => {
    const p = withCadence("monthly", { dayOfMonth: 15 });
    const out = summariseCadence(p, t);
    expect(out).toContain("medications.wizard.summary.dayOfMonthDetail");
    expect(out).toMatch(/dayOfMonthDetail[^|]*"day":15/);
  });
});

describe("summariseScheduleDraft — shared cadence-line helper", () => {
  const t = makeStubT();

  // The per-schedule summary and the medication-wide summary build their
  // cadence segment from the same extracted helper, so for an equivalent
  // cadence shape the draft summary equals the leading segment of the
  // full summary (which trails the times / course-window phrases).
  it("matches summariseCadence's leading cadence segment", () => {
    const cases: WizardPayload[] = [
      withCadence("daily"),
      withCadence("everyNWeeks", { intervalWeeks: 2, weekdays: ["MO"] }),
      withCadence("rolling", { rollingDays: 14 }),
      withCadence("weekdays", { weekdays: ["MO", "WE", "FR"] }),
      withCadence("monthly", { dayOfMonth: 15 }),
    ];
    for (const base of cases) {
      // `withCadence` only sets the flat mirror fields; commit them onto
      // the active schedule draft so the draft carries the same cadence.
      const p = commitActiveDraft(base);
      const draft = p.schedules[p.activeScheduleIndex];
      const draftLine = summariseScheduleDraft(draft, t);
      const fullSummary = summariseCadence(p, t);
      // The draft line's cadence segment is the leading " · " segment of
      // the full summary (which trails times / course-window phrases).
      const firstSegment = fullSummary.split(" · ")[0];
      expect(draftLine.split(" · ")[0]).toBe(firstSegment);
    }
  });

  it("threads the everyNWeeks interval into the cadence key", () => {
    const p = commitActiveDraft(
      withCadence("everyNWeeks", { intervalWeeks: 3 }),
    );
    const out = summariseScheduleDraft(p.schedules[p.activeScheduleIndex], t);
    expect(out).toMatch(/cadence\.everyNWeeks[^|]*"n":3/);
  });

  it("omits the cadence detail for a one-shot draft", () => {
    const p = commitActiveDraft(withCadence("oneShot"));
    const out = summariseScheduleDraft(p.schedules[p.activeScheduleIndex], t);
    expect(out).not.toContain("weekdaysDetail");
    expect(out).not.toContain("dayOfMonthDetail");
  });
});

describe("hydrateWizardPayload", () => {
  function makeInitial(
    overrides: Partial<MedicationPayload> = {},
  ): MedicationPayload {
    return {
      id: "med_1",
      name: "Ramipril",
      dose: "5 mg",
      category: "BLOOD_PRESSURE",
      treatmentClass: "GENERIC",
      notificationsEnabled: true,
      startsOn: new Date(Date.UTC(2026, 0, 1)),
      endsOn: null,
      oneShot: false,
      schedules: [
        {
          windowStart: "08:00",
          windowEnd: "09:00",
          timesOfDay: ["08:00"],
          rrule: "FREQ=DAILY",
          rollingIntervalDays: null,
        },
      ],
      ...overrides,
    };
  }

  it("hydrates Ramipril / daily / BP as the blood-pressure row", () => {
    const out = hydrateWizardPayload(makeInitial());
    expect(out.name).toBe("Ramipril");
    expect(out.doseAmount).toBe("5");
    expect(out.doseUnit).toBe("mg");
    expect(out.treatmentRow).toBe("bloodPressure");
    expect(out.mode).toBe("recurring");
    expect(out.cadence.kind).toBe("daily");
    expect(out.timesOfDay).toEqual(["08:00"]);
  });

  it("hydrates a DIABETES medication as the diabetes row", () => {
    const out = hydrateWizardPayload(makeInitial({ category: "DIABETES" }));
    expect(out.treatmentRow).toBe("diabetes");
  });

  it("hydrates an ANTIBIOTIC medication as the antibiotic row", () => {
    const out = hydrateWizardPayload(makeInitial({ category: "ANTIBIOTIC" }));
    expect(out.treatmentRow).toBe("antibiotic");
  });

  it("hydrates a GLP-1 medication via treatmentClass priority", () => {
    const out = hydrateWizardPayload(
      makeInitial({ treatmentClass: "GLP1", category: "OTHER" }),
    );
    expect(out.treatmentRow).toBe("glp1");
  });

  it("hydrates a one-shot medication", () => {
    const out = hydrateWizardPayload(
      makeInitial({
        oneShot: true,
        endsOn: new Date(Date.UTC(2026, 0, 1)),
        schedules: [
          {
            windowStart: "09:00",
            windowEnd: "10:00",
            timesOfDay: ["09:00"],
            rrule: null,
            rollingIntervalDays: null,
          },
        ],
      }),
    );
    expect(out.mode).toBe("oneShot");
    expect(out.cadence.kind).toBe("oneShot");
  });

  it("hydrates a rolling-cadence schedule", () => {
    const out = hydrateWizardPayload(
      makeInitial({
        schedules: [
          {
            windowStart: "08:00",
            windowEnd: "09:00",
            timesOfDay: ["08:00"],
            rrule: null,
            rollingIntervalDays: 7,
          },
        ],
      }),
    );
    expect(out.cadence.kind).toBe("rolling");
    expect(out.subControls.rollingDays).toBe(7);
  });

  it("hydrates a legacy (daysOfWeek, intervalWeeks) schedule via the bridge", () => {
    const out = hydrateWizardPayload(
      makeInitial({
        schedules: [
          {
            windowStart: "08:00",
            windowEnd: "09:00",
            daysOfWeek: [3],
            intervalWeeks: 2,
            timesOfDay: [],
            rrule: null,
            rollingIntervalDays: null,
          },
        ],
      }),
    );
    expect(out.cadence.kind).toBe("everyNWeeks");
    expect(out.subControls.weekdays).toEqual(["WE"]);
    expect(out.subControls.intervalWeeks).toBe(2);
  });

  it("hydrates an everyNWeeks RRULE schedule with the interval picked up", () => {
    const out = hydrateWizardPayload(
      makeInitial({
        schedules: [
          {
            windowStart: "08:00",
            windowEnd: "09:00",
            timesOfDay: ["08:00"],
            rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
            rollingIntervalDays: null,
          },
        ],
      }),
    );
    expect(out.cadence.kind).toBe("everyNWeeks");
    expect(out.subControls.weekdays).toEqual(["WE"]);
    expect(out.subControls.intervalWeeks).toBe(2);
  });
});

describe("compose-mode — multi-schedule encoder + hydrator", () => {
  it("buildCreateBody emits every schedule for a 2-schedule medication", () => {
    // Active draft is a recurring daily schedule (the wizard flat
    // mirror). A second draft sits in the list as a weekly Wednesday
    // schedule. Both must land in the encoded body.
    const base = withCadence("daily");
    const second = withCadence("weekdays", { weekdays: ["WE"] });
    const payload: WizardPayload = {
      ...base,
      treatmentRow: "diabetes",
      timesOfDay: ["08:00"],
      startsOn: new Date(Date.UTC(2026, 4, 28)),
      schedules: [
        // First draft mirrors the flat fields — buildCreateBody
        // commits the active draft before encoding.
        {
          mode: base.mode,
          cadence: base.cadence,
          subControls: base.subControls,
          timesOfDay: ["08:00"],
        },
        {
          mode: second.mode,
          cadence: second.cadence,
          subControls: second.subControls,
          timesOfDay: ["20:00"],
        },
      ],
      activeScheduleIndex: 0,
    };
    const body = buildCreateBody(payload);
    expect(body.schedules).toHaveLength(2);
    expect(body.schedules[0].rrule).toBe("FREQ=DAILY");
    expect(body.schedules[0].timesOfDay).toEqual(["08:00"]);
    expect(body.schedules[1].rrule).toBe("FREQ=WEEKLY;BYDAY=WE");
    expect(body.schedules[1].timesOfDay).toEqual(["20:00"]);
  });

  it("buildUpdateBody preserves schedule.id on edit", () => {
    // Hydrate from a multi-schedule medication, then encode; every
    // schedule must carry its persisted `id` back through.
    const initial: MedicationPayload = {
      id: "med_compose",
      name: "Insulin",
      dose: "10 IE",
      category: "DIABETES",
      treatmentClass: "GENERIC",
      notificationsEnabled: true,
      startsOn: new Date(Date.UTC(2026, 0, 1)),
      endsOn: null,
      oneShot: false,
      schedules: [
        {
          id: "sch_short",
          windowStart: "08:00",
          windowEnd: "09:00",
          timesOfDay: ["08:00", "12:00", "18:00"],
          rrule: "FREQ=DAILY",
          rollingIntervalDays: null,
        },
        {
          id: "sch_long",
          windowStart: "22:00",
          windowEnd: "23:00",
          timesOfDay: ["22:00"],
          rrule: "FREQ=DAILY",
          rollingIntervalDays: null,
        },
      ],
    };
    const payload = hydrateWizardPayload(initial);
    const body = buildCreateBody(payload);
    expect(body.schedules).toHaveLength(2);
    expect(body.schedules[0].id).toBe("sch_short");
    expect(body.schedules[1].id).toBe("sch_long");
  });

  it("hydrateWizardPayload reads N schedules and lands on Step 8 when N > 1", () => {
    const initial: MedicationPayload = {
      id: "med_compose",
      name: "Insulin",
      dose: "10 IE",
      category: "DIABETES",
      treatmentClass: "GENERIC",
      notificationsEnabled: true,
      startsOn: new Date(Date.UTC(2026, 0, 1)),
      endsOn: null,
      oneShot: false,
      schedules: [
        {
          id: "sch_a",
          windowStart: "08:00",
          windowEnd: "09:00",
          timesOfDay: ["08:00"],
          rrule: "FREQ=DAILY",
          rollingIntervalDays: null,
        },
        {
          id: "sch_b",
          windowStart: "22:00",
          windowEnd: "23:00",
          timesOfDay: ["22:00"],
          rrule: "FREQ=DAILY",
          rollingIntervalDays: null,
        },
      ],
    };
    const payload = hydrateWizardPayload(initial);
    expect(payload.schedules).toHaveLength(2);
    expect(payload.activeScheduleIndex).toBe(0);
    expect(payload.schedules[0].id).toBe("sch_a");
    expect(payload.schedules[1].id).toBe("sch_b");
    expect(landingStepForEdit(payload)).toBe(8);

    // Single-schedule still lands on Step 1.
    const single = hydrateWizardPayload({
      ...initial,
      schedules: [initial.schedules[0]],
    });
    expect(landingStepForEdit(single)).toBe(1);
  });

  it("removeSchedule refuses when schedules.length === 1", () => {
    const payload = emptyWizardPayload();
    expect(payload.schedules).toHaveLength(1);
    const after = removeSchedule(payload, 0);
    // Returns the same payload reference / shape — no mutation.
    expect(after.schedules).toHaveLength(1);
    expect(after.activeScheduleIndex).toBe(0);
  });

  it("addSchedule appends and bumps activeScheduleIndex", () => {
    const payload = emptyWizardPayload();
    const after = addSchedule(payload);
    expect(after.schedules).toHaveLength(2);
    expect(after.activeScheduleIndex).toBe(1);

    // setActiveSchedule routes the flat mirror back to the first
    // draft, and a removeSchedule then drops the second.
    const back = setActiveSchedule(after, 0);
    expect(back.activeScheduleIndex).toBe(0);
    const dropped = removeSchedule(back, 1);
    expect(dropped.schedules).toHaveLength(1);

    // commitActiveDraft writes the flat mirror onto the active slot.
    const edited = commitActiveDraft({
      ...after,
      timesOfDay: ["20:00"],
    });
    expect(edited.schedules[after.activeScheduleIndex].timesOfDay).toEqual([
      "20:00",
    ]);
  });
});

describe("v1.15.18 per-dose windows — encode + hydrate round-trip", () => {
  it("emits only explicit, live-time windows in the create body", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      timesOfDay: ["08:00", "20:00"],
      doseWindows: [
        // explicit widened band → kept
        { timeOfDay: "08:00", start: "07:00", end: "12:00" },
        // point-equivalent (±1h) → dropped
        { timeOfDay: "20:00", start: "19:00", end: "21:00" },
      ],
    };
    const body = buildCreateBody(p);
    expect(body.schedules[0].doseWindows).toEqual([
      { timeOfDay: "08:00", start: "07:00", end: "12:00" },
    ]);
  });

  it("omits doseWindows when every dose uses the default band", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      timesOfDay: ["08:00"],
      doseWindows: [{ timeOfDay: "08:00", start: "07:00", end: "09:00" }],
    };
    expect(buildCreateBody(p).schedules[0].doseWindows).toBeUndefined();
  });

  it("drops a window whose timeOfDay is no longer a live dose time", () => {
    const p: WizardPayload = {
      ...withCadence("daily"),
      timesOfDay: ["08:00"],
      doseWindows: [{ timeOfDay: "20:00", start: "18:00", end: "23:00" }],
    };
    expect(buildCreateBody(p).schedules[0].doseWindows).toBeUndefined();
  });

  it("hydrates persisted windows back onto the active draft mirror", () => {
    const initial: MedicationPayload = {
      id: "med1",
      name: "Foo",
      dose: "5 mg",
      category: "OTHER",
      treatmentClass: "GENERIC",
      notificationsEnabled: true,
      startsOn: null,
      endsOn: null,
      oneShot: false,
      schedules: [
        {
          id: "sched1",
          windowStart: "08:00",
          windowEnd: "09:00",
          timesOfDay: ["08:00"],
          rrule: "FREQ=DAILY",
          doseWindows: [{ timeOfDay: "08:00", start: "07:00", end: "12:00" }],
        },
      ],
    };
    const payload = hydrateWizardPayload(initial);
    expect(payload.doseWindows).toEqual([
      { timeOfDay: "08:00", start: "07:00", end: "12:00" },
    ]);
    expect(payload.schedules[0].doseWindows).toEqual([
      { timeOfDay: "08:00", start: "07:00", end: "12:00" },
    ]);
  });

  it("survives the edit → re-encode round-trip", () => {
    const initial: MedicationPayload = {
      id: "med1",
      name: "Foo",
      dose: "5 mg",
      category: "OTHER",
      treatmentClass: "GENERIC",
      notificationsEnabled: true,
      startsOn: null,
      endsOn: null,
      oneShot: false,
      schedules: [
        {
          id: "sched1",
          windowStart: "08:00",
          windowEnd: "09:00",
          timesOfDay: ["08:00"],
          rrule: "FREQ=DAILY",
          doseWindows: [{ timeOfDay: "08:00", start: "07:00", end: "12:00" }],
        },
      ],
    };
    const payload = hydrateWizardPayload(initial);
    const body = buildCreateBody(payload, "edit");
    expect(body.schedules[0].doseWindows).toEqual([
      { timeOfDay: "08:00", start: "07:00", end: "12:00" },
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.16.11 (#316) — as-needed (PRN) mode
// ────────────────────────────────────────────────────────────────────

describe("as-needed mode (v1.16.11, #316)", () => {
  function asNeededPayload(): WizardPayload {
    return {
      ...emptyWizardPayload(),
      mode: "asNeeded",
      treatmentRow: "painRelief",
      name: "Ibuprofen",
      doseAmount: "400",
      doseUnit: "mg",
      unitsPerDose: "2",
    };
  }

  it("progressIndices walks the one-shot-shaped path (no cadence detail, no times)", () => {
    expect(progressIndices("asNeeded", "daily")).toEqual([1, 2, 3, 4, 8]);
  });

  it("buildCreateBody emits asNeeded:true with an EMPTY schedules array", () => {
    const body = buildCreateBody(asNeededPayload());
    expect(body.asNeeded).toBe(true);
    expect(body.oneShot).toBe(false);
    expect(body.schedules).toEqual([]);
    // Dose fields stay first-class — they feed inventory consumption.
    expect(body.dose).toBe("400 mg");
    expect(body.unitsPerDose).toBe(2);
    expect(body.category).toBe("PAIN_RELIEF");
  });

  it("a scheduled payload emits asNeeded:false (no accidental flag bleed)", () => {
    const body = buildCreateBody(withCadence("daily"));
    expect(body.asNeeded).toBe(false);
    expect(body.schedules.length).toBeGreaterThan(0);
  });

  it("hydrateWizardPayload round-trips an as-needed snapshot back onto the mode", () => {
    const hydrated = hydrateWizardPayload({
      id: "m1",
      name: "Ibuprofen",
      dose: "400 mg",
      category: "PAIN_RELIEF",
      notificationsEnabled: true,
      startsOn: null,
      endsOn: null,
      oneShot: false,
      asNeeded: true,
      schedules: [],
    });
    expect(hydrated.mode).toBe("asNeeded");
    // Step 5 pre-selects "Bei Bedarf" via the mode; the placeholder
    // draft carries it too so the flat mirror stays coherent.
    expect(hydrated.schedules).toHaveLength(1);
    expect(hydrated.schedules[0].mode).toBe("asNeeded");

    // Full round-trip: hydrate → encode emits the same wire shape.
    const body = buildCreateBody(hydrated, "edit");
    expect(body.asNeeded).toBe(true);
    expect(body.schedules).toEqual([]);
    // Edit bodies never round-trip the reminders default (invariant 16).
    expect(body.notificationsEnabled).toBeUndefined();
  });

  it("summariseCadence reads the asNeeded key with no times phrase", () => {
    const t = makeStubT();
    const line = summariseCadence(asNeededPayload(), t);
    expect(line).toContain("medications.wizard.summary.cadence.asNeeded");
    expect(line).not.toContain("medications.wizard.summary.times");
  });

  it("summariseScheduleDraft reads the asNeeded key with no times phrase", () => {
    const t = makeStubT();
    const line = summariseScheduleDraft(
      { ...emptyWizardPayload().schedules[0], mode: "asNeeded" },
      t,
    );
    expect(line).toContain("medications.wizard.summary.cadence.asNeeded");
    expect(line).not.toContain("medications.wizard.summary.times");
  });

  it("validateStep gates: Step 5 passes once the mode is picked; review mirrors Step 4", () => {
    const p = asNeededPayload();
    expect(validateStep(p, 5)).toBe(true);
    expect(validateStep(p, 8)).toBe(true);
    expect(validateStep({ ...p, mode: null }, 5)).toBe(false);
  });
});
