/**
 * The Observation time series: the `date` and `code` grammar, the scope the
 * saved selection allows, and the R4 shape of each emitted resource.
 */
import { describe, expect, it } from "vitest";

import {
  CALORIES_BURNED_LOINC,
  EXERCISE_ACTIVITY_LOINC,
  EXERCISE_DURATION_LOINC,
  matchesCodeTokens,
  measurementSeriesObservation,
  parseCodeParams,
  parseDateParams,
  resolveSeriesScope,
  seriesCandidateTypes,
  workoutSeriesObservation,
} from "@/lib/fhir/series";
import { MEASUREMENT_LOINC } from "@/lib/fhir/loinc-map";
import { isUcumCode } from "@/lib/fhir/ucum";
import type { FhirObservation } from "@/lib/fhir/types";
import type { ReportLeafId } from "@/lib/report-selection/catalogue";

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("parseDateParams", () => {
  it("is absent without a date parameter, so the snapshot stays the default", () => {
    expect(parseDateParams([])).toBeNull();
  });

  it("reads prefixes and partial dates as half-open UTC ranges", () => {
    const r = parseDateParams(["ge2026-01-01", "lt2026-02-01"]);
    expect(r).not.toHaveProperty("error");
    const range = r as { from: Date | null; to: Date | null };
    expect(iso(range.from)).toBe("2026-01-01T00:00:00.000Z");
    expect(iso(range.to)).toBe("2026-02-01T00:00:00.000Z");
  });

  it("covers a whole month for eq, and the day after for gt and le", () => {
    const month = parseDateParams(["2026-02"]) as { from: Date; to: Date };
    expect(iso(month.from)).toBe("2026-02-01T00:00:00.000Z");
    expect(iso(month.to)).toBe("2026-03-01T00:00:00.000Z");
    const gt = parseDateParams(["gt2026-02-10"]) as { from: Date; to: null };
    expect(iso(gt.from)).toBe("2026-02-11T00:00:00.000Z");
    expect(gt.to).toBeNull();
    const le = parseDateParams(["le2026"]) as { from: null; to: Date };
    expect(iso(le.to)).toBe("2027-01-01T00:00:00.000Z");
  });

  it("honours an offset on a dateTime value", () => {
    const r = parseDateParams(["ge2026-03-01T10:00:00+02:00"]) as {
      from: Date;
    };
    expect(iso(r.from)).toBe("2026-03-01T08:00:00.000Z");
  });

  it("rejects what it cannot read rather than ignoring it", () => {
    expect(parseDateParams(["sa2026-01-01"])).toHaveProperty("error");
    expect(parseDateParams(["2026-02-30"])).toHaveProperty("error");
    expect(parseDateParams(["yesterday"])).toHaveProperty("error");
  });
});

describe("parseCodeParams", () => {
  it("maps LOINC codes to their types, with or without a system", () => {
    const f = parseCodeParams(["http://loinc.org|80404-7", "29463-7"])!;
    expect([...f.types].sort()).toEqual(["HEART_RATE_VARIABILITY", "WEIGHT"]);
    expect(f.workouts).toBe(false);
  });

  it("maps any blood-pressure code to the paired panel stream", () => {
    const f = parseCodeParams(["8480-6"])!;
    expect([...f.types].sort()).toEqual([
      "BLOOD_PRESSURE_DIA",
      "BLOOD_PRESSURE_SYS",
    ]);
  });

  it("narrows glucose to the contexts its code names", () => {
    const fasting = parseCodeParams(["1558-6"])!;
    expect([...fasting.types]).toEqual(["BLOOD_GLUCOSE"]);
    expect([...fasting.glucoseContexts!]).toEqual(["FASTING"]);
    const blood = parseCodeParams(["2339-0"])!;
    expect([...blood.glucoseContexts!].sort()).toEqual([
      "BEDTIME",
      "NONE",
      "RANDOM",
    ]);
  });

  it("selects workouts by the exercise-activity code", () => {
    expect(parseCodeParams([EXERCISE_ACTIVITY_LOINC])!.workouts).toBe(true);
  });

  it("does not match a LOINC code under a foreign system", () => {
    expect(
      parseCodeParams(["http://snomed.info/sct|80404-7"])!.types.size,
    ).toBe(0);
  });
});

describe("resolveSeriesScope", () => {
  const gateOf = (leaves: ReportLeafId[]) => ({
    admits: (leaf: ReportLeafId) => leaves.includes(leaf),
  });

  it("carries only what the saved selection admits, never sleep", () => {
    const s = resolveSeriesScope(
      gateOf(["WEIGHT", "SLEEP_DURATION", "HRV_RMSSD"]),
      null,
    );
    expect(s.types.sort()).toEqual(["HRV_RMSSD", "WEIGHT"]);
    expect(s.workouts).toBe(false);
    expect(seriesCandidateTypes()).not.toContain("SLEEP_DURATION");
  });

  it("pairs blood pressure only when both components are admitted", () => {
    expect(
      resolveSeriesScope(
        gateOf(["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"]),
        null,
      ).pairBloodPressure,
    ).toBe(true);
    expect(
      resolveSeriesScope(gateOf(["BLOOD_PRESSURE_SYS"]), null)
        .pairBloodPressure,
    ).toBe(false);
  });

  it("intersects the code filter with the gate", () => {
    const s = resolveSeriesScope(
      gateOf(["WEIGHT", "WORKOUTS"]),
      parseCodeParams(["80404-7", EXERCISE_ACTIVITY_LOINC]),
    );
    expect(s.types).toEqual([]);
    expect(s.workouts).toBe(true);
  });
});

/** The structural R4 checks the conformance suite applies to every Observation. */
function assertR4Observation(o: FhirObservation) {
  expect(o.resourceType).toBe("Observation");
  expect(o.status).toBe("final");
  expect(o.subject.reference).toBe("Patient/patient-1");
  // effective[x]: exactly one of dateTime / period.
  expect(Boolean(o.effectiveDateTime) !== Boolean(o.effectivePeriod)).toBe(
    true,
  );
  // value[x]: at most one.
  const values = [
    o.valueQuantity,
    o.valueCodeableConcept,
    o.valueString,
    o.valueInteger,
  ].filter((v) => v !== undefined);
  expect(values.length).toBeLessThanOrEqual(1);
  // A coded UCUM unit is a parseable one, and system + code travel together.
  const quantities = [
    o.valueQuantity,
    ...(o.component ?? []).map((c) => c.valueQuantity),
  ].filter(Boolean);
  for (const q of quantities) {
    if (q!.code !== undefined) expect(isUcumCode(q!.code)).toBe(true);
    expect(q!.code === undefined).toBe(q!.system === undefined);
  }
  // vital-signs category promises a LOINC code.
  if (o.category?.some((c) => c.coding?.[0]?.code === "vital-signs")) {
    const loinc = o.code.coding?.some((c) => c.system === "http://loinc.org");
    const textOnly = !o.code.coding && Boolean(o.code.text);
    expect(loinc || textOnly).toBe(true);
  }
  expect(JSON.parse(JSON.stringify(o))).toEqual(o);
}

const AT = new Date("2026-03-04T07:30:00.000Z");

describe("measurementSeriesObservation", () => {
  it("emits one reading per row with its own id and instant", () => {
    const o = measurementSeriesObservation(
      {
        id: "abc",
        type: "WEIGHT",
        value: 79.45,
        valueMin: null,
        valueMax: null,
        measuredAt: AT,
        glucoseContext: null,
      },
      "mg/dL",
      null,
    )!;
    assertR4Observation(o);
    expect(o.id).toBe("m-abc");
    expect(o.effectiveDateTime).toBe(AT.toISOString());
    expect(o.valueQuantity?.value).toBe(79.45);
    expect(o.code.coding?.[0]?.code).toBe(MEASUREMENT_LOINC.WEIGHT.loinc);
  });

  it("codes blood ketones as beta-hydroxybutyrate in blood (#1367)", () => {
    const o = measurementSeriesObservation(
      {
        id: "k1",
        type: "BLOOD_KETONES",
        value: 1.4,
        valueMin: null,
        valueMax: null,
        measuredAt: AT,
        glucoseContext: null,
      },
      "mg/dL",
      null,
    )!;
    assertR4Observation(o);
    expect(o.category?.[0]?.coding?.[0]?.code).toBe("laboratory");
    expect(o.code.coding).toEqual([
      {
        system: "http://loinc.org",
        code: "104816-4",
        display: "Beta hydroxybutyrate [Moles/volume] in Blood",
      },
    ]);
    expect(o.valueQuantity).toMatchObject({ value: 1.4, unit: "mmol/L" });
  });

  it("labels RMSSD as its own text-only statistic, never under SDNN's code", () => {
    const o = measurementSeriesObservation(
      {
        id: "r1",
        type: "HRV_RMSSD",
        value: 38,
        valueMin: null,
        valueMax: null,
        measuredAt: AT,
        glucoseContext: null,
      },
      "mg/dL",
      null,
    )!;
    assertR4Observation(o);
    expect(o.code.text).toBe("Heart rate variability RMSSD");
    expect(o.code.coding).toBeUndefined();
    expect(o.valueQuantity).toMatchObject({ value: 38, unit: "ms" });
  });

  it("reads an hourly heart-rate bucket as a mean over its hour", () => {
    const o = measurementSeriesObservation(
      {
        id: "h1",
        type: "PULSE",
        value: 72,
        valueMin: 60,
        valueMax: 95,
        measuredAt: AT,
        glucoseContext: null,
      },
      "mg/dL",
      null,
    )!;
    assertR4Observation(o);
    expect(o.effectivePeriod).toEqual({
      start: AT.toISOString(),
      end: "2026-03-04T08:30:00.000Z",
    });
    expect(o.note?.[0]?.text).toContain("60 to 95");
  });

  it("pairs a systolic reading with its diastolic partner as the BP panel", () => {
    const o = measurementSeriesObservation(
      {
        id: "s1",
        type: "BLOOD_PRESSURE_SYS",
        value: 131,
        valueMin: null,
        valueMax: null,
        measuredAt: AT,
        glucoseContext: null,
      },
      "mg/dL",
      84,
    )!;
    assertR4Observation(o);
    expect(o.code.coding?.[0]?.code).toBe("85354-9");
    expect(o.component?.map((c) => c.valueQuantity?.value)).toEqual([131, 84]);
  });

  it("emits a lone component under its own code and outside the vital-signs profile", () => {
    const o = measurementSeriesObservation(
      {
        id: "d1",
        type: "BLOOD_PRESSURE_DIA",
        value: 84,
        valueMin: null,
        valueMax: null,
        measuredAt: AT,
        glucoseContext: null,
      },
      "mg/dL",
      null,
    )!;
    assertR4Observation(o);
    expect(o.code.coding?.[0]?.code).toBe("8462-4");
    expect(o.category).toBeUndefined();
  });

  it("codes glucose by context and values it in the owner's unit", () => {
    const o = measurementSeriesObservation(
      {
        id: "g1",
        type: "BLOOD_GLUCOSE",
        value: 99,
        valueMin: null,
        valueMax: null,
        measuredAt: AT,
        glucoseContext: "FASTING",
      },
      "mmol/L",
      null,
    )!;
    assertR4Observation(o);
    expect(o.code.coding?.[0]?.code).toBe("1558-6");
    expect(o.valueQuantity?.unit).toBe("mmol/L");
    expect(o.valueQuantity?.value).toBeCloseTo(5.5, 1);
  });

  it("emits nothing for sleep segments", () => {
    expect(
      measurementSeriesObservation(
        {
          id: "z",
          type: "SLEEP_DURATION",
          value: 90,
          valueMin: null,
          valueMax: null,
          measuredAt: AT,
          glucoseContext: null,
        },
        "mg/dL",
        null,
      ),
    ).toBeNull();
  });
});

describe("workoutSeriesObservation", () => {
  it("emits an activity Observation per the Physical Activity IG pattern", () => {
    const o = workoutSeriesObservation({
      id: "w1",
      sportType: "running",
      startedAt: AT,
      endedAt: new Date("2026-03-04T08:15:30.000Z"),
      durationSec: 2730,
      totalDistanceM: 8012.5,
      totalEnergyKcal: 610,
      avgHeartRate: 151,
    });
    assertR4Observation(o);
    expect(o.id).toBe("w-w1");
    expect(o.category?.[0]?.coding?.[0]?.code).toBe("activity");
    expect(o.code.coding?.[0]?.code).toBe(EXERCISE_ACTIVITY_LOINC);
    expect(o.valueCodeableConcept?.coding?.[0]?.code).toBe("running");
    expect(o.effectivePeriod?.end).toBe("2026-03-04T08:15:30.000Z");
    const byCode = Object.fromEntries(
      (o.component ?? []).map((c) => [
        c.code.coding?.[0]?.code ?? c.code.text,
        c.valueQuantity,
      ]),
    );
    expect(byCode[EXERCISE_DURATION_LOINC]).toMatchObject({
      value: 45.5,
      code: "min",
    });
    expect(byCode[CALORIES_BURNED_LOINC]).toMatchObject({ value: 610 });
    expect(byCode.Distance).toMatchObject({ value: 8012.5, unit: "m" });
  });

  it("leaves out the components a source did not report", () => {
    const o = workoutSeriesObservation({
      id: "w2",
      sportType: "yoga",
      startedAt: AT,
      endedAt: AT,
      durationSec: 600,
      totalDistanceM: null,
      totalEnergyKcal: null,
      avgHeartRate: null,
    });
    expect(o.component).toHaveLength(1);
  });
});

describe("matchesCodeTokens", () => {
  it("matches a bare code on any system and a system|code pair exactly", () => {
    const o = {
      code: { coding: [{ system: "http://loinc.org", code: "29463-7" }] },
    } as FhirObservation;
    expect(matchesCodeTokens(o, ["29463-7"])).toBe(true);
    expect(matchesCodeTokens(o, ["http://loinc.org|29463-7"])).toBe(true);
    expect(matchesCodeTokens(o, ["urn:x|29463-7"])).toBe(false);
    expect(matchesCodeTokens(o, ["8480-6,29463-7"])).toBe(true);
  });
});
