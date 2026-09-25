/**
 * The anti-drift sweep: for every leaf that has data, aggregating with it and
 * without it must produce different payloads.
 *
 * This is the test that would have caught all eight dead switches on the day
 * they were added, and it is parametrised over the catalogue, so a leaf added
 * later is covered the day it is added rather than the day someone remembers.
 * It covers the PDF, the FHIR bundle, the share view and the MCP surface
 * transitively, because all four read this function's output.
 *
 * Two further properties sit beside it:
 *
 *   - fail-closed: a measurement type the catalogue does not know is excluded,
 *     not passed through. The old filter did the opposite, which made "we
 *     forgot to map it" indistinguishable from "the user asked for it".
 *   - zero read: a leaf that was not chosen is never queried. The payload has
 *     to reflect "this was never fetched", not "this was fetched and dropped".
 *
 * Mutation checks:
 *   - `resolveReportGate`: make `admits` return `true` unconditionally → the
 *     sweep goes red listing every leaf, and the empty-selection assertions go
 *     red too.
 *   - `filterMeasurementKeys`: pass an unmapped type through instead of
 *     skipping it → "excludes a measurement type the catalogue does not know"
 *     goes red.
 *   - `collect.ts`: drop the `gate.admits("MOOD")` condition on the mood query
 *     → "never queries moodEntry for MOOD when it was not chosen" goes red.
 *   - `collect.ts`: return `bmi` unconditionally → the sweep goes red naming
 *     BODY_MASS_INDEX.
 *   - `collect.ts`: drop the `identityOn` guard on `patient` → the sweep goes
 *     red naming PATIENT_IDENTITY.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { calls, rows, prismaMock } = vi.hoisted(() => {
  const calls: string[] = [];
  const rows: Record<string, unknown[]> = {};
  const model = (name: string) => ({
    findMany: (args?: { where?: { type?: { notIn?: string[] } } }) => {
      calls.push(name);
      if (name === "measurement") {
        const blocked = new Set(args?.where?.type?.notIn ?? []);
        return Promise.resolve(
          (rows.measurement ?? []).filter(
            (r) => !blocked.has((r as { type: string }).type),
          ),
        );
      }
      return Promise.resolve(rows[name] ?? []);
    },
    findUnique: () => {
      calls.push(name);
      return Promise.resolve(rows[`${name}Unique`]?.[0] ?? null);
    },
  });
  return {
    calls,
    rows,
    prismaMock: new Proxy(
      {},
      {
        get: (_t, prop: string) =>
          prop === "$queryRaw" ? () => Promise.resolve([]) : model(prop),
      },
    ),
  };
});

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/cycle/export-data", () => ({
  buildCycleExportSummary: vi.fn(async () => ({
    lastPeriodStart: "2026-02-01",
    recentCycles: [
      { startDate: "2026-02-01", lengthDays: 28, periodLengthDays: 5 },
    ],
    observedCycleCount: 1,
    averageCycleLengthDays: 28,
    cycleLengthVariabilityDays: null,
    averagePeriodLengthDays: 5,
    currentPhase: "FOLLICULAR",
  })),
}));

import { collectDoctorReportData } from "../collect";
import { filterMeasurementKeys, resolveReportGate } from "../selection-gate";
import { MODULE_KEYS } from "@/lib/modules/gate";
import {
  ALL_LEAF_IDS,
  MEASUREMENT_LEAF_IDS,
  type ReportLeafId,
} from "@/lib/report-selection/catalogue";
import { selectionFromLeaves } from "@/lib/report-selection/selection";
import type { DoctorReportData } from "@/lib/doctor-report-types";

const RANGE = {
  start: new Date("2026-01-01T00:00:00.000Z"),
  end: new Date("2026-03-01T00:00:00.000Z"),
  days: 60,
};

function moduleMap() {
  const out: Record<string, boolean> = {};
  for (const key of MODULE_KEYS) out[key] = true;
  return out as never;
}

/**
 * One row for every measurement type plus one row behind every structured
 * leaf, so no leaf's difference can be hidden by an empty account. The
 * positive control below asserts the all-on payload is genuinely populated,
 * which is what stops the sweep passing vacuously.
 */
function seed() {
  for (const key of Object.keys(rows)) delete rows[key];
  rows.measurement = MEASUREMENT_LEAF_IDS.map((type, i) => ({
    type,
    value: 10 + i,
    measuredAt: new Date("2026-02-01T08:00:00.000Z"),
    source: "MANUAL",
    deviceType: null,
    sleepStage: null,
    glucoseContext: type === "BLOOD_GLUCOSE" ? "FASTING" : null,
  }));
  rows.userUnique = [
    {
      username: "owner",
      dateOfBirth: new Date("1980-05-05T00:00:00.000Z"),
      gender: "OTHER",
      heightCm: 180,
      glucoseUnit: "MG_DL",
      thresholdsJson: null,
      timezone: "Europe/Berlin",
      sourcePriorityJson: null,
      fullName: "Owner Name",
      insurerName: "Sample Insurer",
      insurerIkNumber: "123456789",
    },
  ];
  rows.medication = [
    {
      id: "m1",
      name: "Sample drug",
      dose: "10 mg",
      atcCode: null,
      rxNormCode: null,
      asNeeded: false,
      active: true,
      treatmentClass: "GLP1",
      startsOn: null,
      endsOn: null,
      oneShot: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      schedules: [
        {
          windowStart: "08:00",
          windowEnd: "09:00",
          label: null,
          daysOfWeek: null,
        },
      ],
      scheduleRevisions: [],
      pauseEras: [],
      doseChanges: [
        {
          effectiveFrom: new Date("2026-01-05T00:00:00.000Z"),
          doseValue: 1,
          doseUnit: "mg",
          note: null,
          noteEncrypted: null,
        },
      ],
      intakeEvents: [
        { takenAt: new Date("2026-02-10T08:00:00.000Z"), injectionSite: "ARM" },
      ],
    },
  ];
  rows.medicationIntakeEvent = [
    {
      medicationId: "m1",
      scheduledFor: new Date("2026-02-10T08:00:00.000Z"),
      takenAt: new Date("2026-02-10T08:05:00.000Z"),
      skipped: false,
      autoMissed: false,
      attributionSource: null,
      injectionSite: "ARM",
      medication: {
        id: "m1",
        name: "Sample drug",
        dose: "10 mg",
        atcCode: null,
        rxNormCode: null,
        deliveryForm: null,
        asNeeded: false,
      },
    },
  ];
  rows.moodEntry = [{ score: 4, tags: '["nausea"]' }];
  rows.labResult = [
    {
      panel: "Lipids",
      analyte: "LDL",
      value: 3.1,
      valueText: null,
      unit: "mmol/L",
      referenceLow: null,
      referenceHigh: null,
      takenAt: new Date("2026-02-01T00:00:00.000Z"),
    },
  ];
  rows.illnessEpisode = [
    {
      label: "Sample condition",
      type: "ACUTE",
      lifecycle: "RESOLVED",
      onsetAt: new Date("2026-01-10T00:00:00.000Z"),
      resolvedAt: new Date("2026-01-20T00:00:00.000Z"),
    },
  ];
  rows.encounter = [
    {
      occurredAt: new Date("2026-02-05T09:00:00.000Z"),
      kind: "SPECIALIST",
      status: "DONE",
      reasonEncrypted: null,
      outcomeEncrypted: null,
      practitioner: { name: "Sample practice", specialty: "Cardiology" },
      conditionLinks: [],
    },
  ];
  rows.allergy = [
    {
      substance: "Penicillin",
      category: "MEDICATION",
      type: "ALLERGY",
      severity: "SEVERE",
      status: "ACTIVE",
      reactionEncrypted: null,
    },
  ];
  rows.vaccinationRecord = [
    {
      id: "vacc-1",
      occurredAt: new Date("2019-03-04T00:00:00.000Z"),
      antigenSlug: "tetanus",
      vaccineName: null,
      lotNumber: "AB123",
      seriesDoses: null,
      doseNumber: 3,
      site: "LEFT_ARM",
      practitioner: { name: "Sample practice" },
    },
  ];
  rows.familyHistoryEntry = [
    { relationship: "MOTHER", condition: "Hypertension", ageAtOnset: 50 },
  ];
  rows.userHealthProfileUnique = [
    {
      conditionsEncrypted: new Uint8Array([1]),
      // Emergency profile: a real blood type makes the EMERGENCY leaf change
      // the payload, so the sweep can prove its control is not inert.
      emergencyBloodType: "O_POS",
      organDonorStatus: "YES",
      advanceDirectiveStatus: "EXISTS",
      emergencyContactsEncrypted: null,
      emergencyImplantsEncrypted: null,
      emergencyNoteEncrypted: null,
    },
  ];
  rows.healthProfileFactRevision = [
    {
      kind: "SMOKING_STATUS",
      valueEncrypted: new Uint8Array([1]),
    },
  ];
}

function same(a: DoctorReportData, b: DoctorReportData): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

beforeEach(() => {
  calls.length = 0;
  seed();
});

describe("per-leaf gating sweep", () => {
  it("changes the payload for every leaf", async () => {
    const all = selectionFromLeaves(ALL_LEAF_IDS);
    const allPayload = await collectDoctorReportData("u1", RANGE, all, {
      moduleMap: moduleMap(),
    });

    // Positive control: the fixture really does populate the payload, so a
    // "no difference" result below means the gate is inert, not that the
    // account is empty.
    expect(Object.keys(allPayload.stats).length).toBeGreaterThan(70);
    expect(allPayload.labResults).not.toBeNull();
    expect(allPayload.allergies).not.toBeNull();
    expect(allPayload.familyHistory).not.toBeNull();
    expect(allPayload.illnessEpisodes).not.toBeNull();
    expect(allPayload.visits).not.toBeNull();
    expect(allPayload.surgicalHistory).not.toBeNull();
    expect(allPayload.mood).not.toBeNull();
    expect(allPayload.cycle).not.toBeNull();
    expect(allPayload.anamnesis).not.toBeNull();
    expect(allPayload.emergency).not.toBeNull();
    expect(allPayload.glp1).not.toBeNull();
    expect(allPayload.medications.length).toBeGreaterThan(0);
    expect(allPayload.medicationAdministrations?.length ?? 0).toBeGreaterThan(
      0,
    );
    expect(Object.keys(allPayload.compliance).length).toBeGreaterThan(0);
    expect(allPayload.patient.username).toBe("owner");
    expect(allPayload.patient.insurerName).toBe("Sample Insurer");
    expect(allPayload.bmi).not.toBeNull();
    expect(Object.keys(allPayload.glucoseStats).length).toBeGreaterThan(0);

    const inert: ReportLeafId[] = [];
    for (const leaf of ALL_LEAF_IDS) {
      const without = selectionFromLeaves(
        ALL_LEAF_IDS.filter((l) => l !== leaf),
      );
      const payload = await collectDoctorReportData("u1", RANGE, without, {
        moduleMap: moduleMap(),
      });
      if (same(allPayload, payload)) inert.push(leaf);
    }

    expect(
      inert,
      "withholding these leaves changed nothing that leaves the aggregator, " +
        "so a control for them would lie",
    ).toEqual([]);
  }, 30_000);
});

describe("the derived figures ride their own leaf", () => {
  it("withholds the BMI figure while the weight series stays", async () => {
    // The sweep alone cannot isolate this: BODY_MASS_INDEX also gates its own
    // measurement rows, so the payload differs either way. The figure needs
    // its own assertion, because weight rows stay readable for exactly this
    // computation and it would be easy to leave the result ungated.
    const withBmi = await collectDoctorReportData(
      "u1",
      RANGE,
      selectionFromLeaves(["WEIGHT", "BODY_MASS_INDEX"]),
      { moduleMap: moduleMap() },
    );
    expect(withBmi.bmi).not.toBeNull();

    const withoutBmi = await collectDoctorReportData(
      "u1",
      RANGE,
      selectionFromLeaves(["WEIGHT"]),
      { moduleMap: moduleMap() },
    );
    expect(withoutBmi.bmi).toBeNull();
    expect(withoutBmi.stats.WEIGHT).toBeDefined();
  });

  it("computes the BMI figure without carrying the weight series", async () => {
    // The other half: choosing the figure and not the series still needs the
    // weight rows read, and must not smuggle the series out with them.
    const payload = await collectDoctorReportData(
      "u1",
      RANGE,
      selectionFromLeaves(["BODY_MASS_INDEX"]),
      { moduleMap: moduleMap() },
    );
    expect(payload.bmi).not.toBeNull();
    expect(payload.stats.WEIGHT).toBeUndefined();
    expect(payload.measurements.WEIGHT).toBeUndefined();
  });

  it("withholds the GLP-1 block while its inputs stay readable", async () => {
    const on = await collectDoctorReportData(
      "u1",
      RANGE,
      selectionFromLeaves(["GLP1_THERAPY"]),
      { moduleMap: moduleMap() },
    );
    expect(on.glp1).not.toBeNull();

    const off = await collectDoctorReportData(
      "u1",
      RANGE,
      selectionFromLeaves(["MEDICATION_LIST", "MEDICATION_COMPLIANCE"]),
      { moduleMap: moduleMap() },
    );
    expect(off.glp1).toBeNull();
    expect(off.medications.length).toBeGreaterThan(0);
  });

  it("withholds the glucose panel while the raw series stays", async () => {
    const withPanel = await collectDoctorReportData(
      "u1",
      RANGE,
      selectionFromLeaves(["BLOOD_GLUCOSE", "GLUCOSE_PANEL"]),
      { moduleMap: moduleMap() },
    );
    expect(Object.keys(withPanel.glucoseStats).length).toBeGreaterThan(0);

    const seriesOnly = await collectDoctorReportData(
      "u1",
      RANGE,
      selectionFromLeaves(["BLOOD_GLUCOSE"]),
      { moduleMap: moduleMap() },
    );
    expect(seriesOnly.glucoseStats).toEqual({});
    expect(seriesOnly.glucoseClinical.readingCount).toBe(0);
    expect(seriesOnly.stats.BLOOD_GLUCOSE).toBeDefined();
  });
});

describe("fail-closed exclusion", () => {
  it("excludes a measurement type the catalogue does not know", () => {
    const gate = resolveReportGate(
      selectionFromLeaves(["WEIGHT"]),
      moduleMap(),
    );
    expect(
      filterMeasurementKeys({ WEIGHT: 1, SOMETHING_NEW: 2 }, gate),
    ).toEqual({ WEIGHT: 1 });
  });

  it("admits a mapped, selected type", () => {
    const gate = resolveReportGate(
      selectionFromLeaves(MEASUREMENT_LEAF_IDS),
      moduleMap(),
    );
    expect(filterMeasurementKeys({ WEIGHT: 1, PULSE: 2 }, gate)).toEqual({
      WEIGHT: 1,
      PULSE: 2,
    });
  });

  it("refuses a selected type whose module is off", () => {
    const map = { ...(moduleMap() as unknown as Record<string, boolean>) };
    map.sleep = false;
    const gate = resolveReportGate(
      selectionFromLeaves(["SLEEP_DURATION", "WEIGHT"]),
      map as never,
    );
    expect(
      filterMeasurementKeys({ SLEEP_DURATION: 1, WEIGHT: 2 }, gate),
    ).toEqual({ WEIGHT: 2 });
  });
});

describe("zero read for unchosen leaves", () => {
  const gated: Array<[ReportLeafId, string]> = [
    ["MOOD", "moodEntry"],
    ["FAMILY_HISTORY", "familyHistoryEntry"],
    ["ALLERGIES", "allergy"],
    ["LAB_RESULTS", "labResult"],
    ["ILLNESS_EPISODES", "illnessEpisode"],
    ["VISITS", "encounter"],
    ["SURGICAL_HISTORY", "encounter"],
    ["IMMUNIZATIONS", "vaccinationRecord"],
    ["ANAMNESIS", "userHealthProfile"],
    ["EMERGENCY", "userHealthProfile"],
    ["ANAMNESIS", "healthProfileFactRevision"],
  ];

  // ANAMNESIS and EMERGENCY both read `userHealthProfile` (and VISITS and
  // SURGICAL_HISTORY both read `encounter`), so withholding one
  // while the other stays selected still queries the table. Both must be off
  // before the read stops — the zero-read guarantee is over the SET of leaves
  // that touch a table, not each one in isolation.
  const TABLE_READERS: Record<string, ReportLeafId[]> = {
    userHealthProfile: ["ANAMNESIS", "EMERGENCY"],
    // The visits in the window and the lifetime surgical history both read
    // the encounter table, under their own leaves.
    encounter: ["VISITS", "SURGICAL_HISTORY"],
  };

  it.each(gated)(
    "never queries %s's table when it was not chosen",
    async (leaf, model) => {
      calls.length = 0;
      const withheld = new Set<ReportLeafId>(TABLE_READERS[model] ?? [leaf]);
      await collectDoctorReportData(
        "u1",
        RANGE,
        selectionFromLeaves(ALL_LEAF_IDS.filter((l) => !withheld.has(l))),
        { moduleMap: moduleMap() },
      );
      expect(calls).not.toContain(model);
    },
  );

  it.each(gated)(
    "does query %s's table when it was chosen",
    async (_leaf, model) => {
      calls.length = 0;
      await collectDoctorReportData(
        "u1",
        RANGE,
        selectionFromLeaves(ALL_LEAF_IDS),
        { moduleMap: moduleMap() },
      );
      expect(calls).toContain(model);
    },
  );

  it("reads no medication row when no medication leaf was chosen", async () => {
    calls.length = 0;
    await collectDoctorReportData(
      "u1",
      RANGE,
      selectionFromLeaves(["WEIGHT"]),
      { moduleMap: moduleMap() },
    );
    expect(calls).not.toContain("medication");
    expect(calls).not.toContain("medicationIntakeEvent");
  });
});

describe("the empty selection serves nothing", () => {
  it("returns an empty payload for an empty selection", async () => {
    const payload = await collectDoctorReportData(
      "u1",
      RANGE,
      selectionFromLeaves([]),
      { moduleMap: moduleMap() },
    );
    expect(payload.patient.username).toBeNull();
    expect(payload.patient.insurerName).toBeNull();
    expect(payload.labResults).toBeNull();
    expect(payload.allergies).toBeNull();
    expect(payload.familyHistory).toBeNull();
    expect(payload.illnessEpisodes).toBeNull();
    expect(payload.visits).toBeNull();
    expect(payload.anamnesis).toBeNull();
    expect(payload.emergency).toBeNull();
    expect(payload.cycle).toBeNull();
    expect(payload.mood).toBeNull();
    expect(payload.glp1).toBeNull();
    expect(payload.bmi).toBeNull();
    expect(payload.wellnessScores).toBeNull();
    expect(payload.medications).toEqual([]);
    expect(payload.medicationAdministrations).toEqual([]);
    expect(payload.compliance).toEqual({});
    expect(payload.measurements).toEqual({});
    expect(payload.stats).toEqual({});
    expect(payload.glucoseStats).toEqual({});
    expect(payload.glucoseRanges).toEqual({});
    expect(payload.glucoseClinical.readingCount).toBe(0);
  });
});
