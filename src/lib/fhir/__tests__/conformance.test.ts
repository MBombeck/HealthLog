/**
 * FHIR R4 conformance of the document Bundle and the emitters behind it.
 *
 * Every assertion here stands for a statement the export makes to a clinician's
 * system: that the document has an identity, that a reference it prints
 * resolves, that a gender it names is the one the person recorded, that a
 * period aggregate is not passed off as an instant reading, and that a coded
 * UCUM symbol is one a receiver can parse.
 */
import { describe, expect, it } from "vitest";

import type { DoctorReportData } from "@/lib/doctor-report-data";
import { computeGlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import { buildFhirDocumentBundle } from "@/lib/fhir/build-bundle";
import { administrativeGender } from "@/lib/fhir/resources";
import { isUcumCode, ucumQuantity } from "@/lib/fhir/ucum";
import { allSignals } from "@/lib/signals/registry";
import type {
  FhirBundle,
  FhirCoverage,
  FhirObservation,
  FhirResource,
} from "@/lib/fhir/types";

const FIXED_NOW = new Date("2026-05-03T12:00:00.000Z");

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeData(overrides?: Partial<DoctorReportData>): DoctorReportData {
  return {
    period: {
      days: 90,
      since: "2026-02-02T00:00:00.000Z",
      start: "2026-02-02T00:00:00.000Z",
      end: "2026-05-03T12:00:00.000Z",
    },
    patient: {
      name: "Sample Patient",
      dateOfBirth: "1985-06-15T00:00:00.000Z",
      gender: "MALE",
      heightCm: 182,
      insurerName: "Example Insurer",
      insurerIkNumber: "101234567",
    },
    practiceName: null,
    measurements: {
      WEIGHT: [{ value: 79.5, measuredAt: "2026-04-30T08:00:00.000Z" }],
      BLOOD_PRESSURE_SYS: [
        { value: 120, measuredAt: "2026-04-30T08:00:00.000Z" },
      ],
      BLOOD_PRESSURE_DIA: [
        { value: 78, measuredAt: "2026-04-30T08:00:00.000Z" },
      ],
    },
    stats: {},
    glucoseStats: {
      FASTING: { avg: 92, min: 85, max: 100, count: 4, latest: 90 },
    },
    glucoseRanges: {},
    glucoseClinical: computeGlucoseClinicalMetrics([], {
      now: FIXED_NOW,
    }),
    glucoseUnit: "mg/dL",
    bmi: 24.1,
    compliance: {
      "med-example": {
        name: "Example Drug",
        total: 90,
        taken: 85,
        skipped: 3,
        missed: 2,
      },
    },
    medications: [
      { id: "med-example", name: "Example Drug", dose: "5mg", schedules: [] },
    ],
    medicationAdministrations: [
      {
        medicationName: "Example Drug",
        effectiveAt: "2026-04-30T08:00:00.000Z",
        status: "completed",
        doseText: "5mg",
        dose: { value: 5, unit: "mg" },
        injectionSite: null,
        atcCode: null,
        rxNormCode: null,
        deliveryForm: "ORAL",
      },
    ],
    labResults: [
      {
        analyte: "HDL",
        unit: "mg/dL",
        value: 55,
        valueText: null,
        panel: null,
        takenAt: "2026-04-20T08:00:00.000Z",
        referenceLow: 40,
        referenceHigh: 80,
      },
    ],
    illnessEpisodes: [
      {
        label: "Erkältung",
        type: "INFECTION",
        lifecycle: "ACUTE",
        onsetAt: "2026-04-01T00:00:00.000Z",
        resolvedAt: "2026-04-10T00:00:00.000Z",
        bodySite: "Knee",
        laterality: "LEFT",
      },
    ],
    mood: { avg: 3.8, count: 20 },
    glp1: null,
    ...overrides,
  } as DoctorReportData;
}

function fullBundle(overrides?: Partial<DoctorReportData>): FhirBundle {
  return buildFhirDocumentBundle(
    makeData(overrides),
    { insuranceNumber: "A123456780" },
    FIXED_NOW,
    {},
    {
      allergies: [
        {
          id: "a1",
          substance: "Penicillin",
          category: "MEDICATION",
          type: "ALLERGY",
          status: "ACTIVE",
          severity: "SEVERE",
          reaction: "Rash",
          onsetAt: null,
          note: null,
        },
      ] as never,
      familyHistory: [
        {
          id: "f1",
          relationship: "MOTHER",
          condition: "Hypertension",
          ageAtOnset: 50,
          note: null,
        },
      ] as never,
    },
  );
}

/** Every `{ reference: … }` string anywhere in the serialised bundle. */
function allReferences(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) allReferences(item, out);
    return out;
  }
  if (value === null || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "reference" && typeof child === "string") out.push(child);
    else allReferences(child, out);
  }
  return out;
}

/** Every `text` string anywhere in the serialised bundle. */
function allTexts(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) allTexts(item, out);
    return out;
  }
  if (value === null || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "text" && typeof child === "string") out.push(child);
    else allTexts(child, out);
  }
  return out;
}

function resourcesOf(bundle: FhirBundle): FhirResource[] {
  return bundle.entry.map((e) => e.resource);
}

// ── Condition.bodySite — the contained BodyStructure resolves in place ───

describe("Condition.bodySite", () => {
  it("points its extension at a BodyStructure contained in the same Condition, whose patient resolves", () => {
    const bundle = fullBundle();
    const patientUrl = bundle.entry.find(
      (e) => e.resource.resourceType === "Patient",
    )?.fullUrl;
    const condition = resourcesOf(bundle).find(
      (r) => r.resourceType === "Condition",
    );
    if (condition?.resourceType !== "Condition")
      throw new Error("no Condition");
    const ext = condition.bodySite?.[0]?.extension?.[0];
    expect(ext?.url).toBe("http://hl7.org/fhir/StructureDefinition/bodySite");
    const target = ext?.valueReference.reference;
    const structure = condition.contained?.find((c) => `#${c.id}` === target);
    expect(structure?.resourceType).toBe("BodyStructure");
    expect(structure?.patient.reference).toBe(patientUrl);
    // An active SNOMED CT laterality qualifier value.
    expect(
      ["7771000", "24028007", "51440002"].includes(
        structure?.locationQualifier?.[0]?.coding?.[0]?.code ?? "",
      ),
    ).toBe(true);
  });
});

// ── Test 14 — document identity, entry identity, reference resolution ─────

describe("document Bundle — identity and resolvability", () => {
  it("carries a Bundle.identifier with a system and a UUIDv4 value", () => {
    const bundle = fullBundle();
    expect(bundle.identifier.system).toBe(
      "https://healthlog.dev/fhir/bundle-id",
    );
    expect(bundle.identifier.value).toMatch(UUID_V4);
  });

  it("mints a fresh document identifier per build", () => {
    expect(fullBundle().identifier.value).not.toBe(
      fullBundle().identifier.value,
    );
  });

  it("gives every entry a distinct urn:uuid fullUrl over a UUIDv4", () => {
    const bundle = fullBundle();
    expect(bundle.entry.length).toBeGreaterThan(5);
    for (const entry of bundle.entry) {
      expect(entry.fullUrl.startsWith("urn:uuid:")).toBe(true);
      expect(entry.fullUrl.slice("urn:uuid:".length)).toMatch(UUID_V4);
    }
    const urls = new Set(bundle.entry.map((e) => e.fullUrl));
    expect(urls.size).toBe(bundle.entry.length);
  });

  it("keeps the human-readable resource ids", () => {
    const ids = resourcesOf(fullBundle()).map((r) => r.id);
    expect(ids).toContain("patient-1");
    expect(ids).toContain("composition-1");
    expect(ids).toContain("obs-1");
  });

  it("resolves every reference in the bundle against an entry fullUrl", () => {
    const bundle = fullBundle();
    const urls = new Set(bundle.entry.map((e) => e.fullUrl));
    const containedIds = new Set(
      resourcesOf(bundle).flatMap((r) =>
        "contained" in r && Array.isArray(r.contained)
          ? r.contained.map((c) => `#${c.id}`)
          : [],
      ),
    );
    const references = allReferences(bundle);
    expect(references.length).toBeGreaterThan(5);
    for (const reference of references) {
      const resolvable = reference.startsWith("#")
        ? containedIds.has(reference)
        : urls.has(reference);
      expect(resolvable, `unresolvable reference: ${reference}`).toBe(true);
    }
  });

  it("carries the Device the Composition names as its author", () => {
    const bundle = fullBundle();
    const composition = bundle.entry[0].resource;
    if (composition.resourceType !== "Composition") {
      throw new Error("expected a leading Composition");
    }
    const authorRef = composition.author[0].reference;
    const author = bundle.entry.find((e) => e.fullUrl === authorRef)?.resource;
    expect(author?.resourceType).toBe("Device");
    if (author?.resourceType !== "Device") throw new Error("not a Device");
    expect(author.manufacturer).toBe("HealthLog");
    expect(author.deviceName?.[0].name).toBe("HealthLog");
    expect(author.version?.[0].value.length).toBeGreaterThan(0);
  });

  it("emits no Coverage without a payor", () => {
    for (const bundle of [
      fullBundle(),
      fullBundle({
        patient: {
          name: "u",
          dateOfBirth: null,
          gender: null,
          heightCm: null,
        },
      }),
    ]) {
      for (const resource of resourcesOf(bundle)) {
        if (resource.resourceType !== "Coverage") continue;
        const coverage = resource as FhirCoverage;
        expect(coverage.payor.length).toBeGreaterThan(0);
      }
    }
  });

  it("emits no empty-string text anywhere in the serialised bundle", () => {
    const bundle = fullBundle({
      // A qualitative lab row with neither a number nor a result term.
      labResults: [
        {
          analyte: "Borrelia IgG",
          unit: "",
          value: null,
          valueText: "   ",
          panel: null,
          takenAt: "2026-04-20T08:00:00.000Z",
          referenceLow: null,
          referenceHigh: null,
        },
      ] as never,
    });
    for (const text of allTexts(bundle)) {
      expect(text.trim().length, "empty text in the bundle").toBeGreaterThan(0);
    }
    // …and the value-less row produced no Observation at all.
    const analytes = resourcesOf(bundle)
      .filter((r): r is FhirObservation => r.resourceType === "Observation")
      .map((o) => o.code.text);
    expect(analytes).not.toContain("Borrelia IgG");
  });

  it("reaches Coverage, the Encounters and the DiagnosticReport from the Composition", () => {
    const bundle = fullBundle();
    const composition = bundle.entry[0].resource;
    if (composition.resourceType !== "Composition") {
      throw new Error("expected a leading Composition");
    }
    const reachable = new Set(
      (composition.section ?? []).flatMap((s) =>
        (s.entry ?? []).map((e) => e.reference),
      ),
    );
    const reachableTypes = new Set(
      bundle.entry
        .filter((e) => reachable.has(e.fullUrl))
        .map((e) => e.resource.resourceType),
    );
    expect(reachableTypes.has("Coverage")).toBe(true);
    expect(reachableTypes.has("Encounter")).toBe(true);
    expect(reachableTypes.has("DiagnosticReport")).toBe(true);
    // …and the subject is NOT restated as a section entry.
    expect(reachableTypes.has("Patient")).toBe(false);
  });
});

// ── Test 15 — administrative gender ──────────────────────────────────────

describe("Patient.gender", () => {
  it("maps the recorded value and omits everything else", () => {
    expect(administrativeGender("MALE")).toBe("male");
    expect(administrativeGender("FEMALE")).toBe("female");
    expect(administrativeGender("OTHER")).toBe("other");
    expect(administrativeGender(null)).toBeNull();
    expect(administrativeGender(undefined)).toBeNull();
    expect(administrativeGender("")).toBeNull();
    expect(administrativeGender("DIVERS")).toBeNull();
  });

  it("never states a gender the person did not record", () => {
    const cases: Array<[string | null, string | undefined]> = [
      ["MALE", "male"],
      ["FEMALE", "female"],
      ["OTHER", "other"],
      [null, undefined],
      ["nonbinary", undefined],
    ];
    for (const [stored, expected] of cases) {
      const bundle = fullBundle({
        patient: {
          name: "u",
          dateOfBirth: null,
          gender: stored,
          heightCm: null,
        },
      });
      const patient = resourcesOf(bundle).find(
        (r) => r.resourceType === "Patient",
      );
      if (patient?.resourceType !== "Patient") throw new Error("no Patient");
      expect(patient.gender, `stored ${String(stored)}`).toBe(expected);
    }
  });

  it("never emits `unknown` — an unrecorded field is absent, not asked-and-unknown", () => {
    for (const stored of [null, "OTHER", "nope"]) {
      expect(administrativeGender(stored)).not.toBe("unknown");
    }
  });
});

// ── Test 16 — period aggregates carry effectivePeriod ────────────────────

describe("Observation.effective[x]", () => {
  const PERIOD_DERIVED = [
    "Body mass index (BMI) [Ratio]",
    "Fasting glucose [Mass/volume] in Serum or Plasma",
    "Mood (average over period)",
    "Medication adherence — Example Drug",
  ];

  it("states a window for a value derived over the window, not an instant", () => {
    const bundle = fullBundle();
    const observations = resourcesOf(bundle).filter(
      (r): r is FhirObservation => r.resourceType === "Observation",
    );
    for (const text of PERIOD_DERIVED) {
      const observation = observations.find((o) => o.code.text === text);
      expect(observation, `missing Observation: ${text}`).toBeDefined();
      expect(observation?.effectivePeriod).toEqual({
        start: "2026-02-02T00:00:00.000Z",
        end: "2026-05-03T12:00:00.000Z",
      });
      expect(observation?.effectiveDateTime).toBeUndefined();
    }
  });

  it("keeps the reading instant for a single reading", () => {
    const bundle = fullBundle();
    const weight = resourcesOf(bundle)
      .filter((r): r is FhirObservation => r.resourceType === "Observation")
      .find((o) => o.code.coding?.[0].code === "29463-7");
    expect(weight?.effectiveDateTime).toBe("2026-04-30T08:00:00.000Z");
    expect(weight?.effectivePeriod).toBeUndefined();
  });

  it("states a window for every cycle figure", () => {
    const bundle = fullBundle({
      cycle: {
        lastPeriodStart: "2026-04-20",
        recentCycles: [],
        observedCycleCount: 3,
        averageCycleLengthDays: 27.5,
        cycleLengthVariabilityDays: 0.5,
        averagePeriodLengthDays: 5,
        currentPhase: "LUTEAL",
      },
    });
    const cycleObservations = resourcesOf(bundle).filter(
      (r): r is FhirObservation =>
        r.resourceType === "Observation" && r.id.startsWith("obs-cycle-"),
    );
    expect(cycleObservations).toHaveLength(4);
    for (const observation of cycleObservations) {
      expect(observation.effectivePeriod?.end).toBe("2026-05-03T12:00:00.000Z");
      expect(observation.effectiveDateTime).toBeUndefined();
    }
  });
});

// ── W1 — the screener totals reach FHIR at all ───────────────────────────

describe("WHO-5 and SCI totals", () => {
  it("emit a text-only survey Observation rather than being dropped", () => {
    const bundle = fullBundle({
      measurements: {
        WHO5_SCORE: [{ value: 68, measuredAt: "2026-04-28T08:00:00.000Z" }],
        SCI_SCORE: [{ value: 24, measuredAt: "2026-04-28T08:00:00.000Z" }],
      },
    });
    const observations = resourcesOf(bundle).filter(
      (r): r is FhirObservation => r.resourceType === "Observation",
    );
    for (const [display, value] of [
      ["WHO-5 well-being index total score", 68],
      ["Sleep Condition Indicator total score", 24],
    ] as const) {
      const observation = observations.find((o) => o.code.text === display);
      expect(observation, display).toBeDefined();
      // No verified LOINC exists for either total, so no code is invented.
      expect(observation?.code.coding).toBeUndefined();
      expect(observation?.category?.[0].coding?.[0].code).toBe("survey");
      expect(observation?.valueQuantity?.value).toBe(value);
      expect(observation?.valueQuantity?.code).toBe("{score}");
    }
  });
});

// ── Test 19 — UCUM allowlist over every registry facet ───────────────────

describe("UCUM coding", () => {
  it("either validates a registry unit or emits it uncoded", () => {
    const units = allSignals()
      .map((signal) => signal.fhir?.unit)
      .filter((unit): unit is string => typeof unit === "string");
    expect(units.length).toBeGreaterThan(20);
    for (const unit of units) {
      // The contract: the display unit always goes out, and `system` + `code`
      // follow exactly when the string is a UCUM expression. No unchecked
      // string ever reaches `Quantity.code`.
      const quantity = ucumQuantity(1, unit);
      expect(quantity.unit, unit).toBe(unit);
      if (isUcumCode(unit)) {
        expect(quantity.system, unit).toBe("http://unitsofmeasure.org");
        expect(quantity.code, unit).toBe(unit);
      } else {
        expect(quantity.system, unit).toBeUndefined();
        expect(quantity.code, unit).toBeUndefined();
      }
    }
    // The known non-UCUM display label in the registry stays uncoded.
    expect(units).toContain("dB[A]");
    expect(isUcumCode("dB[A]")).toBe(false);
    // …while the ordinary ones validate.
    for (const unit of ["kg", "%", "{score}", "Cel", "/min", "kg/m2"]) {
      expect(isUcumCode(unit), unit).toBe(true);
    }
  });

  it("stamps system and code together, or neither", () => {
    const bundle = fullBundle();
    const quantities = resourcesOf(bundle)
      .filter((r): r is FhirObservation => r.resourceType === "Observation")
      .flatMap((o) => [
        o.valueQuantity,
        ...(o.component ?? []).map((c) => c.valueQuantity),
        ...(o.referenceRange ?? []).flatMap((r) => [r.low, r.high]),
      ])
      .filter((q) => q !== undefined);
    expect(quantities.length).toBeGreaterThan(5);
    for (const quantity of quantities) {
      if (quantity!.code !== undefined) {
        expect(quantity!.system).toBe("http://unitsofmeasure.org");
      }
      expect(quantity!.unit).toBeDefined();
    }
  });

  it("carries the bounds in the same coding as the value beside them", () => {
    const bundle = fullBundle();
    const hdl = resourcesOf(bundle)
      .filter((r): r is FhirObservation => r.resourceType === "Observation")
      .find((o) => o.code.text === "HDL");
    expect(hdl?.valueQuantity?.code).toBe("mg/dL");
    expect(hdl?.referenceRange?.[0].low).toEqual(
      hdl?.valueQuantity && {
        value: 40,
        unit: "mg/dL",
        system: "http://unitsofmeasure.org",
        code: "mg/dL",
      },
    );
    expect(hdl?.referenceRange?.[0].high?.system).toBe(
      "http://unitsofmeasure.org",
    );
  });
});
