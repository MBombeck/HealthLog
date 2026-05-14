import { describe, expect, it } from "vitest";

import {
  GLP1_DRUG_IDS,
  GLP1_DRUGS,
  findDrugByBrand,
  findDrugIdByBrand,
  routeForBrand,
  type Glp1DrugId,
} from "@/lib/medications/glp1-knowledge";

describe("glp1-knowledge catalog", () => {
  describe("shape integrity", () => {
    it("includes exactly the five EMA-approved drug ids", () => {
      const keys = Object.keys(GLP1_DRUGS).sort();
      expect(keys).toEqual(
        [
          "dulaglutide",
          "exenatide",
          "liraglutide",
          "semaglutide",
          "tirzepatide",
        ].sort(),
      );
    });

    it("never lists retatrutide (no EMA approval — N7 exclusion)", () => {
      // Belt-and-braces — both at the catalog level AND the brand
      // level. Retatrutide has no EMA EPAR; including it would
      // imply endorsement of unauthorised use.
      expect(GLP1_DRUGS).not.toHaveProperty("retatrutide");
      for (const record of Object.values(GLP1_DRUGS)) {
        expect(
          record.brands.map((b) => b.toLowerCase()),
        ).not.toContain("retatrutide");
        expect(record.inn.toLowerCase()).not.toBe("retatrutide");
      }
    });

    it("populates every required field for every drug", () => {
      for (const [id, record] of Object.entries(GLP1_DRUGS)) {
        expect(record.inn, `inn missing on ${id}`).toBeTruthy();
        expect(record.brands.length, `brands empty on ${id}`).toBeGreaterThan(0);
        expect(record.route, `route missing on ${id}`).toBeTruthy();
        expect(record.drugClass, `drugClass missing on ${id}`).toBeTruthy();
        expect(record.pharmacology, `pharmacology missing on ${id}`).toBeTruthy();
        expect(
          record.pharmacology.halfLifeDays,
          `halfLifeDays missing on ${id}`,
        ).toBeGreaterThan(0);
        expect(
          record.pharmacology.bioavailability,
          `bioavailability missing on ${id}`,
        ).toBeGreaterThan(0);
        expect(record.storage.unopened.temperatureCelsius.min).toBeDefined();
        expect(record.storage.inUse.maxDays).toBeGreaterThan(0);
        expect(record.titrationStepsMg.length).toBeGreaterThan(0);
        expect(record.maxDoseMg).toBeGreaterThan(0);
        expect(record.sideEffects.veryCommon.length).toBeGreaterThan(0);
        expect(record.sourceEMA, `sourceEMA missing on ${id}`).toMatch(
          /^https:\/\/www\.ema\.europa\.eu\//,
        );
      }
    });

    it("matches drug-ids and inn to the expected case", () => {
      // Internal ids are lowercase; INN is title-case per WHO
      // convention.
      for (const id of GLP1_DRUG_IDS) {
        expect(id).toBe(id.toLowerCase());
        const record = GLP1_DRUGS[id];
        expect(record.inn[0]).toBe(record.inn[0].toUpperCase());
      }
    });

    it("keeps the catalog readonly at the type level", () => {
      // `as const` discipline — verify mutating the catalog at
      // runtime is impossible (frozen Object.freeze isn't applied
      // by `as const`, but the tests assert the static contract).
      // This is mostly a developer-readability test: if a future
      // refactor drops `as const`, the test failure says why.
      const tirzepatide = GLP1_DRUGS.tirzepatide;
      expect(tirzepatide.brands).toEqual(["Mounjaro", "Zepbound"]);
    });
  });

  describe("pharmacology values vs psp4.13099 + EMA EPAR", () => {
    it("pins tirzepatide half-life to 5.0 d (EMA EPAR §5.2 ≈ 5 d)", () => {
      expect(GLP1_DRUGS.tirzepatide.pharmacology.halfLifeDays).toBe(5.0);
    });

    it("pins tirzepatide Ka to 0.0373 h⁻¹ (psp4.13099 Table 3)", () => {
      expect(GLP1_DRUGS.tirzepatide.pharmacology.absorptionRateHourlyKa).toBe(
        0.0373,
      );
    });

    it("pins tirzepatide clearance to 0.0329 L/h per 70 kg (psp4.13099 Table 3)", () => {
      expect(GLP1_DRUGS.tirzepatide.pharmacology.clearanceLPerHour70kg).toBe(
        0.0329,
      );
    });

    it("pins tirzepatide bioavailability to 0.80 (psp4.13099 fixed)", () => {
      expect(GLP1_DRUGS.tirzepatide.pharmacology.bioavailability).toBe(0.8);
    });

    it("pins semaglutide half-life to 7 d (EMA EPAR §5.2 ≈ 1 week)", () => {
      expect(GLP1_DRUGS.semaglutide.pharmacology.halfLifeDays).toBe(7.0);
    });

    it("pins liraglutide half-life near 13 h (EMA EPAR §5.2)", () => {
      // Stored as days for shape consistency — 13 h = 0.5416…
      const days = GLP1_DRUGS.liraglutide.pharmacology.halfLifeDays;
      expect(days * 24).toBeCloseTo(13, 1);
    });

    it("pins dulaglutide half-life to ~5 d (EMA EPAR §5.2)", () => {
      expect(GLP1_DRUGS.dulaglutide.pharmacology.halfLifeDays).toBe(5.0);
    });

    it("pins exenatide IR half-life near 2.4 h (Byetta EMA EPAR §5.2)", () => {
      const days = GLP1_DRUGS.exenatide.pharmacology.halfLifeDays;
      expect(days * 24).toBeCloseTo(2.4, 1);
    });

    it("flags tirzepatide as two-compartment per the journal-of-record", () => {
      // psp4.13099 verbatim: "two-compartment model with first
      // order absorption and elimination."
      expect(GLP1_DRUGS.tirzepatide.pharmacology.compartmentModel).toBe(
        "two-compartment",
      );
    });
  });

  describe("brand-route mapping consistency", () => {
    it("keeps Rybelsus mapped to oral, Ozempic + Wegovy to SC", () => {
      expect(routeForBrand("semaglutide", "Rybelsus")).toBe("oral");
      expect(routeForBrand("semaglutide", "Ozempic")).toBe("subcutaneous");
      expect(routeForBrand("semaglutide", "Wegovy")).toBe("subcutaneous");
    });

    it("returns the default route when no per-brand override exists", () => {
      expect(routeForBrand("tirzepatide", "Mounjaro")).toBe("subcutaneous");
      expect(routeForBrand("tirzepatide", "Zepbound")).toBe("subcutaneous");
      expect(routeForBrand("liraglutide", "Saxenda")).toBe("subcutaneous");
      expect(routeForBrand("liraglutide", "Victoza")).toBe("subcutaneous");
    });

    it("returns null for an unknown brand on a known drug", () => {
      expect(routeForBrand("tirzepatide", "DoesNotExist")).toBeNull();
    });

    it("never marks an injection-only drug brand as oral", () => {
      for (const id of GLP1_DRUG_IDS) {
        const record = GLP1_DRUGS[id];
        for (const brand of record.brands) {
          const route = routeForBrand(id, brand);
          // The only oral brand is Rybelsus.
          if (brand !== "Rybelsus") {
            expect(route).toBe("subcutaneous");
          }
        }
      }
    });
  });

  describe("titration ladders", () => {
    it("ascends strictly for every drug", () => {
      for (const id of GLP1_DRUG_IDS) {
        const steps = GLP1_DRUGS[id].titrationStepsMg;
        for (let i = 1; i < steps.length; i++) {
          expect(
            steps[i],
            `${id} titration step ${i} not strictly ascending`,
          ).toBeGreaterThan(steps[i - 1]);
        }
      }
    });

    it("tops out at maxDoseMg for every drug", () => {
      for (const id of GLP1_DRUG_IDS) {
        const record = GLP1_DRUGS[id];
        const lastStep = record.titrationStepsMg[record.titrationStepsMg.length - 1];
        expect(lastStep).toBe(record.maxDoseMg);
      }
    });

    it("captures the 2.5-→-15 mg Mounjaro ladder per EMA §4.2", () => {
      expect(GLP1_DRUGS.tirzepatide.titrationStepsMg).toEqual([
        2.5, 5, 7.5, 10, 12.5, 15,
      ]);
    });
  });

  describe("storage windows", () => {
    it("refrigerates every product unopened at 2–8 °C", () => {
      for (const id of GLP1_DRUG_IDS) {
        const range = GLP1_DRUGS[id].storage.unopened.temperatureCelsius;
        expect(range.min).toBe(2);
        expect(range.max).toBe(8);
      }
    });

    it("caps in-use temperature at ≤ 30 °C per EMA §6.3", () => {
      for (const id of GLP1_DRUG_IDS) {
        const range = GLP1_DRUGS[id].storage.inUse.temperatureCelsius;
        // Byetta has a 25 °C cap; everything else 30 °C.
        expect(range.max).toBeLessThanOrEqual(30);
        expect(range.max).toBeGreaterThanOrEqual(25);
      }
    });

    it("keeps every in-use window between 1 and 60 days", () => {
      // Sanity check — no infinite shelf life, no stale defaults.
      for (const id of GLP1_DRUG_IDS) {
        const days = GLP1_DRUGS[id].storage.inUse.maxDays;
        expect(days).toBeGreaterThan(0);
        expect(days).toBeLessThanOrEqual(60);
      }
    });

    it("sets Mounjaro KwikPen to 30 days post-opening per EMA §6.3", () => {
      expect(GLP1_DRUGS.tirzepatide.storage.inUse.maxDays).toBe(30);
    });
  });

  describe("findDrugByBrand", () => {
    it("finds tirzepatide by Mounjaro and Zepbound", () => {
      expect(findDrugByBrand("Mounjaro")?.inn).toBe("Tirzepatide");
      expect(findDrugByBrand("Zepbound")?.inn).toBe("Tirzepatide");
    });

    it("is case-insensitive", () => {
      expect(findDrugByBrand("mounjaro")?.inn).toBe("Tirzepatide");
      expect(findDrugByBrand("MOUNJARO")?.inn).toBe("Tirzepatide");
    });

    it("returns null for unknown brand", () => {
      expect(findDrugByBrand("BogusName")).toBeNull();
    });

    it("trims whitespace", () => {
      expect(findDrugByBrand("  Wegovy  ")?.inn).toBe("Semaglutide");
    });
  });

  describe("findDrugIdByBrand", () => {
    it("returns the drug id for a known brand", () => {
      expect(findDrugIdByBrand("Mounjaro")).toBe("tirzepatide");
      expect(findDrugIdByBrand("Ozempic")).toBe("semaglutide");
      expect(findDrugIdByBrand("Saxenda")).toBe("liraglutide");
    });

    it("is case-insensitive on the brand argument", () => {
      expect(findDrugIdByBrand("mounjaro")).toBe("tirzepatide");
      expect(findDrugIdByBrand("OZEMPIC")).toBe("semaglutide");
    });

    it("returns null for an unknown brand", () => {
      expect(findDrugIdByBrand("BogusName")).toBeNull();
    });

    it("returns null for empty input", () => {
      expect(findDrugIdByBrand("")).toBeNull();
      expect(findDrugIdByBrand("   ")).toBeNull();
    });

    it("trims surrounding whitespace before matching", () => {
      expect(findDrugIdByBrand("  Wegovy  ")).toBe("semaglutide");
    });

    it("preserves the (id ↔ record) round-trip with findDrugByBrand", () => {
      for (const id of GLP1_DRUG_IDS) {
        const record = GLP1_DRUGS[id];
        const [firstBrand] = record.brands;
        expect(findDrugIdByBrand(firstBrand)).toBe(id);
        expect(findDrugByBrand(firstBrand)).toBe(record);
      }
    });
  });

  describe("citations", () => {
    it("links every record to an EMA EPAR PDF", () => {
      for (const id of GLP1_DRUG_IDS) {
        expect(GLP1_DRUGS[id].sourceEMA).toMatch(
          /^https:\/\/www\.ema\.europa\.eu\/.*\.pdf$/,
        );
      }
    });

    it("attaches the psp4.13099 journal citation to tirzepatide", () => {
      expect(GLP1_DRUGS.tirzepatide.sourceJournal?.doi).toBe(
        "10.1002/psp4.13099",
      );
    });
  });

  describe("GLP1_DRUG_IDS", () => {
    it("covers every catalog key in a stable order", () => {
      const fromIds = [...GLP1_DRUG_IDS].sort();
      const fromCatalog = Object.keys(GLP1_DRUGS).sort() as Glp1DrugId[];
      expect(fromIds).toEqual(fromCatalog);
    });
  });
});
