import { describe, expect, it } from "vitest";

import { makeFormatters } from "@/lib/format-locale";
import { formatNutrientAmount } from "../format-amount";

const de = makeFormatters("de", "UTC", "AUTO", "AUTO");
const en = makeFormatters("en", "UTC", "AUTO", "AUTO");

describe("formatNutrientAmount", () => {
  it("keeps one decimal below 1,000 and drops a trailing zero", () => {
    expect(formatNutrientAmount(de, 120.5)).toBe("120,5");
    expect(formatNutrientAmount(de, 82.5)).toBe("82,5");
    expect(formatNutrientAmount(en, 82.5)).toBe("82.5");
    expect(formatNutrientAmount(de, 82.04)).toBe("82");
    expect(formatNutrientAmount(de, 0.4)).toBe("0,4");
  });

  it("prints whole numbers from 1,000 up, grouped for the locale", () => {
    expect(formatNutrientAmount(de, 2150.4)).toBe("2.150");
    expect(formatNutrientAmount(en, 2150.4)).toBe("2,150");
    expect(formatNutrientAmount(de, 400)).toBe("400");
  });

  it("prints milligram and microgram amounts whole from 100 up", () => {
    expect(formatNutrientAmount(de, 230.3, "mg")).toBe("230");
    expect(formatNutrientAmount(de, 120.5, "ug")).toBe("121");
    expect(formatNutrientAmount(de, 82.5, "mg")).toBe("82,5");
    expect(formatNutrientAmount(de, 120.5, "g")).toBe("120,5");
  });
});
