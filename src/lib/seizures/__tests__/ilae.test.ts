import { describe, expect, it } from "vitest";

import { SeizureIlaeType as PrismaIlaeType } from "@/generated/prisma/enums";
import {
  ILAE_TYPE_INFO,
  SEIZURE_ILAE_CLASSES,
  SEIZURE_ILAE_TYPES,
  ilae2017LabelKey,
  ilaeClassOf,
  ilaeLabelKey,
  ilaeTypesOfClass,
  isConvulsiveType,
  loincSeizureTypeAnswer,
} from "../ilae";
import en from "../../../../messages/en.json";

function lookup(key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      en,
    );
}

describe("the ILAE 2025 vocabulary", () => {
  it("is the stored enum, value for value", () => {
    expect([...SEIZURE_ILAE_TYPES].sort()).toEqual(
      Object.values(PrismaIlaeType).sort(),
    );
  });

  it("files every type under one of the four classes, each with a parent entry", () => {
    for (const ilaeClass of SEIZURE_ILAE_CLASSES) {
      const types = ilaeTypesOfClass(ilaeClass);
      expect(types.length).toBeGreaterThan(0);
      // "Not sure" comes last at the second step.
      expect(ILAE_TYPE_INFO[types.at(-1)!].isParent).toBe(true);
      for (const type of types) expect(ilaeClassOf(type)).toBe(ilaeClass);
    }
    const covered = SEIZURE_ILAE_CLASSES.flatMap(ilaeTypesOfClass);
    expect(covered.sort()).toEqual([...SEIZURE_ILAE_TYPES].sort());
  });

  it("counts exactly the three bilateral tonic-clonic types as convulsive", () => {
    expect(
      SEIZURE_ILAE_TYPES.filter((t) => isConvulsiveType(t)).sort(),
    ).toEqual([
      "FOCAL_TO_BILATERAL_TC",
      "GENERALIZED_TC",
      "UNKNOWN_BILATERAL_TC",
    ]);
    expect(isConvulsiveType(null)).toBe(false);
  });

  it("maps the 2017 synonyms one to one, with negative myoclonus new in 2025", () => {
    expect(ilae2017LabelKey("GEN_NEGATIVE_MYOCLONIC")).toBeNull();
    expect(ilae2017LabelKey("FOCAL_PRESERVED")).toBe(
      "seizures.ilae.FOCAL_PRESERVED.ilae2017",
    );
    for (const type of SEIZURE_ILAE_TYPES) {
      expect(typeof lookup(ilaeLabelKey(type))).toBe("string");
      const legacy = ilae2017LabelKey(type);
      if (legacy) expect(typeof lookup(legacy)).toBe("string");
    }
    // The reporter's own types read the way the 2017 paper names them.
    expect(lookup("seizures.ilae.FOCAL_PRESERVED.ilae2017")).toBe(
      "Focal aware seizure",
    );
    expect(lookup("seizures.ilae.FOCAL_IMPAIRED.ilae2017")).toBe(
      "Focal impaired awareness seizure",
    );
  });

  it("codes each type with its SNOMED concept, falling back to a parent only where none exists", () => {
    expect(ILAE_TYPE_INFO.FOCAL_PRESERVED.snomed.code).toBe("117891000119100");
    expect(ILAE_TYPE_INFO.FOCAL_IMPAIRED.snomed.code).toBe("407675009");
    expect(ILAE_TYPE_INFO.FOCAL_TO_BILATERAL_TC.snomed.code).toBe("246544003");
    expect(ILAE_TYPE_INFO.GENERALIZED_TC.snomed.code).toBe("1217209006");
    expect(ILAE_TYPE_INFO.ABSENCE_TYPICAL.snomed.code).toBe("1173024006");
    expect(ILAE_TYPE_INFO.UNKNOWN_BILATERAL_TC.snomed.code).toBe("1365926005");
    expect(ILAE_TYPE_INFO.GEN_NEGATIVE_MYOCLONIC.snomedIsParent).toBe(true);
    expect(ILAE_TYPE_INFO.GEN_NEGATIVE_MYOCLONIC.snomed.code).toBe("246545002");
  });

  it("carries Trinka's t1 for tonic-clonic, focal impaired and absence types only", () => {
    expect(ILAE_TYPE_INFO.GENERALIZED_TC.t1Sec).toBe(300);
    expect(ILAE_TYPE_INFO.FOCAL_TO_BILATERAL_TC.t1Sec).toBe(300);
    expect(ILAE_TYPE_INFO.FOCAL_IMPAIRED.t1Sec).toBe(600);
    expect(ILAE_TYPE_INFO.ABSENCE_TYPICAL.t1Sec).toBe(600);
    expect(ILAE_TYPE_INFO.FOCAL_PRESERVED.t1Sec).toBeNull();
    expect(ILAE_TYPE_INFO.GEN_MYOCLONIC.t1Sec).toBeNull();
  });

  it("answers LOINC 99311-3 in the 2017 categories, and not where 2017 needs a split 2025 dropped", () => {
    expect(loincSeizureTypeAnswer("FOCAL_PRESERVED")?.code).toBe("LA32841-1");
    expect(loincSeizureTypeAnswer("FOCAL_TO_BILATERAL_TC")?.code).toBe(
      "LA32843-7",
    );
    expect(loincSeizureTypeAnswer("ABSENCE_ATYPICAL")?.code).toBe("LA32846-0");
    expect(loincSeizureTypeAnswer("GEN_ATONIC")?.code).toBe("LA32845-2");
    expect(loincSeizureTypeAnswer("UNKNOWN_IMPAIRED")).toBeNull();
    expect(loincSeizureTypeAnswer("FOCAL_UNDETERMINED")).toBeNull();
  });
});
