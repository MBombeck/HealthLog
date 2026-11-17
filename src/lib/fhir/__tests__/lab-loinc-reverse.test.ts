import { describe, expect, it } from "vitest";

import { BIOMARKER_CATALOG } from "@/lib/labs/biomarker-catalog";

import { CATALOG_SLUG_TO_LOINC_KEY, catalogSlugForLoinc } from "../lab-loinc";

describe("catalogSlugForLoinc", () => {
  it("inverts the export map: each slug's own code answers with the slug", () => {
    const exported: Record<string, string> = {
      "2093-3": "total-cholesterol",
      "2089-1": "ldl",
      "2085-9": "hdl",
      "2571-8": "triglycerides",
      "1558-6": "fasting-glucose",
      "4548-4": "hba1c",
      "3016-3": "tsh",
      "2276-4": "ferritin",
      "62292-8": "vitamin-d",
      "30522-7": "hs-crp",
      "2160-0": "creatinine",
      "69405-9": "egfr",
      "1742-6": "alt",
      "1920-8": "ast",
      "2324-2": "ggt",
      "718-7": "hemoglobin",
      "1884-6": "apob",
      "43583-4": "lp-a",
      "27873-9": "fasting-insulin",
    };
    expect(Object.keys(exported)).toHaveLength(
      Object.keys(CATALOG_SLUG_TO_LOINC_KEY).length,
    );
    for (const [loinc, slug] of Object.entries(exported)) {
      expect(catalogSlugForLoinc(loinc)).toBe(slug);
    }
  });

  it.each([
    ["13457-7", "ldl"],
    ["18262-6", "ldl"],
    ["33914-3", "egfr"],
    ["48642-3", "egfr"],
    ["48643-1", "egfr"],
    ["50044-7", "egfr"],
    ["62238-1", "egfr"],
    ["98979-8", "egfr"],
    ["17856-6", "hba1c"],
    ["11579-0", "tsh"],
  ])("pins the import-only alias %s -> %s", (loinc, slug) => {
    expect(catalogSlugForLoinc(loinc)).toBe(slug);
  });

  it("answers only with slugs the catalog has", () => {
    const slugs = new Set(BIOMARKER_CATALOG.map((seed) => seed.slug));
    for (const loinc of [
      "2089-1",
      "13457-7",
      "62238-1",
      "17856-6",
      "11579-0",
    ]) {
      expect(slugs.has(catalogSlugForLoinc(loinc)!)).toBe(true);
    }
  });

  it("returns null for a code it does not know", () => {
    expect(catalogSlugForLoinc("1988-5")).toBeNull();
    expect(catalogSlugForLoinc("")).toBeNull();
  });
});
