import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GLP1_DRUGS } from "@/lib/medications/glp1-knowledge";

/**
 * Drift guard for the GLP-1 knowledge layer.
 *
 * The research file `.planning/research/glp1-feature-inspiration.md`
 * §1 + §2.6 is the single source of truth — every numeric parameter
 * in `glp1-knowledge.ts` is cited there against an EMA EPAR PDF or
 * the peer-reviewed pharmacometric paper (Schneck & Urva 2024,
 * DOI 10.1002/psp4.13099).
 *
 * Two layers of guarantee:
 *   1) Hard-coded expected values that match the cited primary
 *      regulatory document — break if anyone edits the TS module
 *      without a matching research-file update.
 *   2) Soft pin against the research file itself — the test reads
 *      the markdown and asserts the citation strings still appear,
 *      so a research-file revision that *removes* a citation
 *      surfaces immediately.
 *
 * Together: a refactor that mutates a half-life or shifts a Ka by
 * a percent without a regulatory rationale fails the test before
 * it reaches production. The clinical reading layer (Coach,
 * inventory countdown, titration card) can trust the catalog.
 *
 * `.planning/` is untracked by design (local-only research artefacts),
 * so the soft-pin block self-skips on CI where the file is absent. The
 * hard pins always run and are the real production guarantee.
 */

const RESEARCH_PATH = join(
  __dirname,
  "../../../../.planning/research/glp1-feature-inspiration.md",
);

const RESEARCH_AVAILABLE = existsSync(RESEARCH_PATH);
const RESEARCH_TEXT = RESEARCH_AVAILABLE ? readFileSync(RESEARCH_PATH, "utf8") : "";

/** Hard pins — these are the exact values the research file cites
 *  against EMA EPAR / psp4.13099. If you change the TS module, you
 *  must update both halves: this test and the research file. */
const HARD_PINS = [
  {
    id: "tirzepatide",
    halfLifeDays: 5.0,
    bioavailability: 0.8,
    absorptionRateHourlyKa: 0.0373,
    clearanceLPerHour70kg: 0.0329,
    compartmentModel: "two-compartment",
    citation: "Schneck",
    citationDoi: "10.1002/psp4.13099",
    titrationStepsMg: [2.5, 5, 7.5, 10, 12.5, 15],
    inUseMaxDays: 30,
  },
  {
    id: "semaglutide",
    halfLifeDays: 7.0,
    bioavailability: 0.89,
    compartmentModel: "two-compartment",
    inUseMaxDays: 56,
  },
  {
    id: "liraglutide",
    // 13 h per EMA EPAR §5.2 — stored as fractional days.
    halfLifeHoursApprox: 13,
    bioavailability: 0.55,
  },
  {
    id: "dulaglutide",
    halfLifeDays: 5.0,
    // 47–65 % range; record carries the lower bound.
    bioavailability: 0.47,
  },
  {
    id: "exenatide",
    // Byetta IR ~2.4 h per EMA EPAR §5.2.
    halfLifeHoursApprox: 2.4,
    bioavailability: 0.65,
  },
] as const;

describe("glp1-knowledge drift guard", () => {
  describe("TS module values vs cited primary sources", () => {
    for (const pin of HARD_PINS) {
      describe(pin.id, () => {
        const record = GLP1_DRUGS[pin.id as keyof typeof GLP1_DRUGS];

        if ("halfLifeDays" in pin && pin.halfLifeDays !== undefined) {
          it(`pins half-life to ${pin.halfLifeDays} d`, () => {
            expect(record.pharmacology.halfLifeDays).toBe(pin.halfLifeDays);
          });
        }

        if ("halfLifeHoursApprox" in pin) {
          it(`pins half-life within rounding of ${pin.halfLifeHoursApprox} h`, () => {
            expect(record.pharmacology.halfLifeDays * 24).toBeCloseTo(
              pin.halfLifeHoursApprox,
              1,
            );
          });
        }

        if ("bioavailability" in pin) {
          it(`pins bioavailability to ${pin.bioavailability}`, () => {
            expect(record.pharmacology.bioavailability).toBe(pin.bioavailability);
          });
        }

        if ("absorptionRateHourlyKa" in pin && pin.absorptionRateHourlyKa !== undefined) {
          it(`pins Ka to ${pin.absorptionRateHourlyKa} h⁻¹ (psp4.13099 Table 3)`, () => {
            expect(record.pharmacology.absorptionRateHourlyKa).toBe(
              pin.absorptionRateHourlyKa,
            );
          });
        }

        if ("clearanceLPerHour70kg" in pin && pin.clearanceLPerHour70kg !== undefined) {
          it(`pins CL to ${pin.clearanceLPerHour70kg} L/h per 70 kg`, () => {
            expect(record.pharmacology.clearanceLPerHour70kg).toBe(
              pin.clearanceLPerHour70kg,
            );
          });
        }

        if ("compartmentModel" in pin && pin.compartmentModel !== undefined) {
          it(`pins compartment model to ${pin.compartmentModel}`, () => {
            expect(record.pharmacology.compartmentModel).toBe(pin.compartmentModel);
          });
        }

        if ("titrationStepsMg" in pin && pin.titrationStepsMg !== undefined) {
          it("pins titration ladder to EMA EPAR §4.2 sequence", () => {
            expect(record.titrationStepsMg).toEqual(pin.titrationStepsMg);
          });
        }

        if ("inUseMaxDays" in pin && pin.inUseMaxDays !== undefined) {
          it(`pins post-opening in-use window to ${pin.inUseMaxDays} d`, () => {
            expect(record.storage.inUse.maxDays).toBe(pin.inUseMaxDays);
          });
        }

        if ("citation" in pin && pin.citation !== undefined) {
          it(`carries the ${pin.citation} citation`, () => {
            expect(record.sourceJournal?.citation).toContain(pin.citation);
          });
        }

        if ("citationDoi" in pin && pin.citationDoi !== undefined) {
          it(`carries the DOI ${pin.citationDoi}`, () => {
            expect(record.sourceJournal?.doi).toBe(pin.citationDoi);
          });
        }
      });
    }
  });

  // Local-only soft pins: the research markdown lives under `.planning/`
  // which is untracked, so the block is a no-op on CI. Marc's local
  // working copy keeps the file and the assertions run there.
  describe.skipIf(!RESEARCH_AVAILABLE)("research-file citation presence", () => {
    it("references the EMA Mounjaro EPAR for tirzepatide", () => {
      expect(RESEARCH_TEXT).toMatch(/mounjaro-epar-product-information/);
    });

    it("references the Schneck/Urva 2024 paper for tirzepatide PK", () => {
      expect(RESEARCH_TEXT).toMatch(/Schneck/);
      expect(RESEARCH_TEXT).toMatch(/psp4\.13099/);
    });

    it("cites tirzepatide Ka 0.0373 h⁻¹ in §1.1 / §2.6", () => {
      expect(RESEARCH_TEXT).toMatch(/0\.0373/);
    });

    it("cites tirzepatide CL 0.0329 L/h in §1.1 / §2.6", () => {
      expect(RESEARCH_TEXT).toMatch(/0\.0329/);
    });

    it("cites the 30-day in-use KwikPen window in §1.1", () => {
      expect(RESEARCH_TEXT).toMatch(/30 days/);
    });

    it("references the Ozempic EPAR for semaglutide", () => {
      expect(RESEARCH_TEXT).toMatch(/ozempic-epar/);
    });

    it("references the Saxenda EPAR for liraglutide", () => {
      expect(RESEARCH_TEXT).toMatch(/saxenda-epar/);
    });

    it("declares the N7 retatrutide exclusion explicitly", () => {
      // Two phrasings appear in the research file; either is enough.
      expect(
        /retatrutide.*not approved|EMA approval|including it implies endorsement/i.test(
          RESEARCH_TEXT,
        ),
      ).toBe(true);
    });
  });

  describe.skipIf(!RESEARCH_AVAILABLE)("research-file presence checks for module values", () => {
    it("agrees with the research file on tirzepatide half-life ≈ 5 days", () => {
      // Research file's §1.1 + §2.6 both say "≈ 5 days" / "5.4 days"
      // for tirzepatide. TS module pins 5.0. The numbers reconcile
      // within psp4.13099's IIV (5.4 d journal vs ≈ 5 d EMA EPAR).
      expect(GLP1_DRUGS.tirzepatide.pharmacology.halfLifeDays).toBeGreaterThanOrEqual(
        5.0,
      );
      expect(GLP1_DRUGS.tirzepatide.pharmacology.halfLifeDays).toBeLessThanOrEqual(
        5.5,
      );
      expect(RESEARCH_TEXT).toMatch(/(≈ 5 d|5 days|5\.4 d|5\.4 days)/);
    });

    it("agrees with the research file on semaglutide half-life ≈ 1 week", () => {
      expect(GLP1_DRUGS.semaglutide.pharmacology.halfLifeDays).toBe(7);
      expect(RESEARCH_TEXT).toMatch(/(≈ 1 week|half-life ≈ 1 week|7 days)/);
    });

    it("agrees with the research file on liraglutide half-life ≈ 13 h", () => {
      expect(GLP1_DRUGS.liraglutide.pharmacology.halfLifeDays * 24).toBeCloseTo(
        13,
        1,
      );
      expect(RESEARCH_TEXT).toMatch(/(≈ 13 hours|13 h|half-life ≈ 13)/);
    });
  });
});
