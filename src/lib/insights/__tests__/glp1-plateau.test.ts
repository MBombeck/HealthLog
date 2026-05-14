import { describe, expect, it } from "vitest";

import { buildGlp1PlateauPrompt } from "@/lib/insights/glp1-plateau";

describe("glp1-plateau", () => {
  describe("buildGlp1PlateauPrompt()", () => {
    it("renders the EN block with the named drug and dose", () => {
      const prompt = buildGlp1PlateauPrompt(
        {
          drug: "Mounjaro",
          doseValue: 7.5,
          doseUnit: "mg",
          doseSince: "2026-04-01",
          daysOnDose: 30,
          weightDeltaKg: -0.2,
          readingsCount: 9,
        },
        "en",
      );

      expect(prompt).toContain("GLP-1 PLATEAU ACTIVE");
      expect(prompt).toContain("Mounjaro 7.5 mg");
      expect(prompt).toContain("2026-04-01");
      expect(prompt).toContain("-0.2 kg");
      expect(prompt).toContain("glp1_plateau");
      expect(prompt).toContain("GROUND RULE 14");
      expect(prompt).toContain("NEVER recommend a dose change");
    });

    it("renders the DE block with German framing", () => {
      const prompt = buildGlp1PlateauPrompt(
        {
          drug: "Mounjaro",
          doseValue: 7.5,
          doseUnit: "mg",
          doseSince: "2026-04-01",
          daysOnDose: 30,
          weightDeltaKg: -0.2,
          readingsCount: 9,
        },
        "de",
      );

      expect(prompt).toContain("GLP-1-PLATEAU AKTIV");
      expect(prompt).toContain("Mounjaro 7.5 mg");
      expect(prompt).toContain("KEINE Dosis-Empfehlung");
      expect(prompt).toContain("GRUNDREGEL 14");
    });

    it("computes week number from days on dose", () => {
      const prompt = buildGlp1PlateauPrompt(
        {
          drug: "Mounjaro",
          doseValue: 7.5,
          doseUnit: "mg",
          doseSince: "2026-04-01",
          daysOnDose: 30,
          weightDeltaKg: -0.2,
          readingsCount: 9,
        },
        "en",
      );

      expect(prompt).toContain("week 4");
    });
  });
});
