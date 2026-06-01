import { describe, expect, it } from "vitest";

import {
  addSchedule,
  buildCreateBody,
  commitActiveDraft,
  emptyWizardPayload,
  hydrateWizardPayload,
  landingStepForEdit,
  type MedicationPayload,
  progressIndices,
  removeSchedule,
  rowFromTreatment,
  setActiveSchedule,
  summariseCadence,
  validateStep,
  type WizardPayload,
  WIZARD_TREATMENT_MAPPING,
  type WizardTreatmentRow,
} from "@/components/medications/wizard/wizard-payload";
import { encodeCadence } from "@/components/medications/scheduling/CadencePicker";
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
  return (
    key: string,
    params?: Record<string, string | number>,
  ): string => {
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
    expect(
      validateStep({ ...base, treatmentRow: "bloodPressure" }, 2),
    ).toBe(true);
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
    expect(
      validateStep({ ...base, startsOn: start, endsOn: earlier }, 4),
    ).toBe(false);
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
    expect(
      validateStep(withCadence("weekdays", { weekdays: [] }), 6),
    ).toBe(false);
    expect(
      validateStep(withCadence("weekdays", { weekdays: ["MO"] }), 6),
    ).toBe(true);
  });

  it("step 6: monthly accepts day-of-month 1..31", () => {
    expect(
      validateStep(withCadence("monthly", { dayOfMonth: 1 }), 6),
    ).toBe(true);
    expect(
      validateStep(withCadence("monthly", { dayOfMonth: 31 }), 6),
    ).toBe(true);
  });

  it("step 6: rolling accepts 1..365 days", () => {
    expect(
      validateStep(withCadence("rolling", { rollingDays: 1 }), 6),
    ).toBe(true);
    expect(
      validateStep(withCadence("rolling", { rollingDays: 365 }), 6),
    ).toBe(true);
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
    expect(
      validateStep({ ...base, startsOn: start, endsOn: null }, 8),
    ).toBe(true);
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
    const out = hydrateWizardPayload(
      makeInitial({ category: "DIABETES" }),
    );
    expect(out.treatmentRow).toBe("diabetes");
  });

  it("hydrates an ANTIBIOTIC medication as the antibiotic row", () => {
    const out = hydrateWizardPayload(
      makeInitial({ category: "ANTIBIOTIC" }),
    );
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
