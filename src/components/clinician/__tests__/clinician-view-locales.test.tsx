/**
 * The clinician view renders in all six shipped locales with no raw i18n key
 * reaching the reader.
 *
 * Most of this page's labels are resolved from a runtime value rather than
 * written as a literal: an illness type, a lifecycle, a visit kind, a vaccine
 * slug, a blood-type constant, a cycle phase, a GLP-1 side-effect tag. None of
 * those are visible to `i18n-call-site-coverage`, which only reads literal
 * `t("ns.key")` calls, and the enum-derived guard can only cover a key space
 * whose members it can enumerate from a source. So a key that does not exist
 * renders as its own dot notation — `encounters.kind.ROUTINE`, verbatim, on a
 * page a doctor is reading — and every other guard stays green.
 *
 * This one renders the whole surface, strips the markup, and fails on anything
 * left in the text that looks like a dotted key path. One fixture with every
 * section populated, six locales, one assertion.
 *
 * Mutation check: replace any `t(resolver(x))` call in the section files with
 * `t(\`ns.${x}\`)` over an enum whose members are not the bundle's leaf names,
 * and all six cases go red naming the leaked key.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ClinicianView } from "../clinician-view";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { computeGlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import { ALL_LEAF_IDS } from "@/lib/report-selection/catalogue";
import { selectionFromLeaves } from "@/lib/report-selection/selection";
import { locales } from "@/lib/i18n/config";
import type { DoctorReportData } from "@/lib/doctor-report-data";

/**
 * One record with every section carrying something, so a single render walks
 * every branch that resolves a label from a value.
 */
const FULL_RECORD = {
  period: {
    days: 30,
    since: "2026-01-01T00:00:00.000Z",
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-01-31T00:00:00.000Z",
  },
  patient: {
    username: "shared-account",
    dateOfBirth: "1980-01-01T00:00:00.000Z",
    gender: "FEMALE",
    heightCm: 170,
    fullName: "A. Patient",
  },
  practiceName: null,
  measurements: {},
  stats: { WEIGHT: { avg: 80, min: 78, max: 82, count: 3, latest: 79 } },
  glucoseStats: {
    FASTING: { avg: 96, min: 88, max: 104, count: 5, latest: 94 },
  },
  glucoseRanges: {},
  glucoseClinical: computeGlucoseClinicalMetrics([], {
    now: new Date("2026-01-31T00:00:00.000Z"),
  }),
  glucoseUnit: "mg/dL",
  bmi: 24.5,
  compliance: { Metformin: { total: 60, taken: 57, skipped: 1, missed: 2 } },
  medications: [{ name: "Ramipril", dose: "5 mg", schedules: [] }],
  medicationAdministrations: [
    {
      medicationName: "Ramipril",
      effectiveAt: "2026-01-30T07:10:00.000Z",
      status: "completed",
      doseText: "5 mg",
      dose: null,
      injectionSite: null,
      atcCode: null,
      rxNormCode: null,
      deliveryForm: "ORAL",
    },
  ],
  glp1: {
    medications: [
      {
        name: "Semaglutide",
        currentDose: {
          value: 1,
          unit: "mg",
          since: "2026-01-05T00:00:00.000Z",
        },
        doseHistory: [
          {
            value: 0.5,
            unit: "mg",
            effectiveFrom: "2025-12-01T00:00:00.000Z",
            note: null,
          },
        ],
        lastInjection: { date: "2026-01-28T00:00:00.000Z", site: "ABDOMEN" },
        compliance: { taken: 4, total: 4 },
      },
    ],
    weightDeltaKg: -3,
    weightStartKg: 83,
    weightEndKg: 80,
    sideEffects: [{ tag: "nausea", count: 2 }],
  },
  mood: {
    avg: 3.4,
    min: 2,
    max: 5,
    count: 22,
    distribution: { 1: 0, 2: 3, 3: 9, 4: 7, 5: 3 },
  },
  cycle: {
    lastPeriodStart: "2026-01-09",
    recentCycles: [
      { startDate: "2026-01-09", lengthDays: 29, periodLengthDays: 5 },
    ],
    observedCycleCount: 1,
    averageCycleLengthDays: 29,
    cycleLengthVariabilityDays: 1.5,
    averagePeriodLengthDays: 5,
    currentPhase: "LUTEAL",
  },
  labResults: [
    {
      panel: "Blood count",
      analyte: "Ferritin",
      value: 42,
      valueText: null,
      unit: "ng/mL",
      referenceLow: 30,
      referenceHigh: 400,
      catalogReferenceLow: 30,
      catalogReferenceHigh: 400,
      sourceReferenceText: null,
      referenceOrigin: "catalog",
      referenceDivergesFromCatalog: false,
      takenAt: "2026-01-20T09:00:00.000Z",
      count: 1,
    },
  ],
  illnessEpisodes: [
    {
      label: "Sinusitis",
      type: "INFECTION",
      lifecycle: "ACUTE",
      onsetAt: "2026-01-08T00:00:00.000Z",
      resolvedAt: null,
    },
  ],
  visits: [
    {
      occurredAt: "2026-01-14T08:30:00.000Z",
      kind: "SPECIALIST",
      status: "DONE",
      practitionerName: "Cardiology outpatients",
      practitionerSpecialty: "Cardiology",
      reason: "Palpitations",
      outcome: "Follow up in three months",
      conditionLabels: ["Sinusitis"],
    },
  ],
  immunizations: [
    {
      occurredAt: "2025-11-03T00:00:00.000Z",
      antigenSlug: "tetanus",
      vaccineName: null,
      lotNumber: "LOT-7781",
      site: null,
      practitionerName: null,
      series: [{ antigen: "tetanus", position: 3, total: 4, booster: false }],
    },
  ],
  allergies: [
    {
      substance: "Penicillin",
      category: "MEDICATION",
      type: "ALLERGY",
      severity: "SEVERE",
      status: "ACTIVE",
      reaction: "Hives",
      reactionUnreadable: false,
    },
  ],
  familyHistory: [
    { relationship: "MOTHER", condition: "Type 2 diabetes", ageAtOnset: 54 },
  ],
  anamnesis: {
    conditions: "Hypothyroidism",
    conditionsUnreadable: false,
    smokingStatus: "FORMER",
    alcoholPattern: "OCCASIONAL",
    shiftSchedule: "ROTATING",
    unreadableFacts: [],
  },
  emergency: {
    bloodType: "O_NEG",
    organDonor: "YES",
    advanceDirective: "EXISTS",
    contacts: "Next of kin, 555 0100",
    contactsUnreadable: false,
    implants: "Pacemaker",
    implantsUnreadable: false,
    note: "Carries an emergency card",
    noteUnreadable: false,
  },
  wellnessScores: [
    {
      type: "RECOVERY_SCORE",
      latest: 72,
      avg: 68,
      min: 50,
      max: 90,
      count: 20,
      latestAt: "2026-01-30T00:00:00.000Z",
    },
  ],
} as unknown as DoctorReportData;

/**
 * `a.b.c` and deeper, lowercase-initial: the shape an unresolved key falls
 * through as. Two segments would catch ordinary prose ("e.g. this"), so the
 * floor is three — every namespace on this page is at least that deep.
 */
const DOTTED_KEY = /\b[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_]+){2,}\b/g;

describe("<ClinicianView> resolves every label in every locale", () => {
  it("covers all seven shipped locales", () => {
    // A floor: an empty locale list would make the loop below assert nothing.
    expect(locales.length).toBe(7);
  });

  for (const locale of locales) {
    it(`leaks no raw i18n key in ${locale}`, () => {
      const { t } = getServerTranslator(locale);
      const html = renderToStaticMarkup(
        ClinicianView({
          t: (key, vars) => t(key, vars),
          label: "Clinic",
          expiresAt: "2026-03-01T00:00:00.000Z",
          report: FULL_RECORD,
          selection: selectionFromLeaves(ALL_LEAF_IDS),
          locale,
          timeFormat: "AUTO",
          dateFormat: "AUTO",
        }),
      );
      // Strip the tags, so the `data-leaf` enum lists and the class names go
      // with them and only what a reader sees is left.
      const text = html.replace(/<[^>]*>/g, " ");
      expect(
        text.match(DOTTED_KEY) ?? [],
        `these keys rendered as their own dot notation in ${locale}`,
      ).toEqual([]);
    });
  }
});
