import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/modules/gate", () => ({ isModuleEnabled: vi.fn() }));
const { nutrientIntakeDay, user } = vi.hoisted(() => ({
  nutrientIntakeDay: { findMany: vi.fn() },
  user: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: { nutrientIntakeDay, user } }));

import {
  getNutrients,
  resolveNutrientCode,
  NUTRIENT_LABELS,
} from "../nutrients-read";
import type {
  NutrientsOverviewResult,
  NutrientsDailyResult,
} from "../nutrients-read";
import { isModuleEnabled } from "@/lib/modules/gate";
import { locales } from "@/lib/i18n/config";
import { labelIn } from "@/lib/i18n/localised-label-index";
import { NUTRIENT_CODES } from "@/lib/nutrients/catalog";

/** Narrow the union to the overview shape for a test's own assertions. */
function overview(
  r: NutrientsOverviewResult | NutrientsDailyResult,
): NutrientsOverviewResult {
  return r as NutrientsOverviewResult;
}

/** Narrow the union to the per-nutrient shape for a test's own assertions. */
function daily(
  r: NutrientsOverviewResult | NutrientsDailyResult,
): NutrientsDailyResult {
  return r as NutrientsDailyResult;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isModuleEnabled).mockResolvedValue(true);
  vi.mocked(user.findUnique).mockResolvedValue({
    timezone: "UTC",
    gender: null,
  } as never);
  vi.mocked(nutrientIntakeDay.findMany).mockResolvedValue([] as never);
});

describe("resolveNutrientCode", () => {
  it("resolves the exact catalog code", () => {
    expect(resolveNutrientCode("water")).toBe("water");
    expect(resolveNutrientCode("vitamin_d")).toBe("vitamin_d");
  });

  it("folds spaces/hyphens and case", () => {
    expect(resolveNutrientCode("Vitamin D")).toBe("vitamin_d");
    expect(resolveNutrientCode("vitamin-d")).toBe("vitamin_d");
    expect(resolveNutrientCode("MAGNESIUM")).toBe("magnesium");
  });

  it("matches a display label (e.g. 'Vitamin B12')", () => {
    expect(resolveNutrientCode("Vitamin B12")).toBe("vitamin_b12");
  });

  it("returns null for an unknown name (never invents a code)", () => {
    expect(resolveNutrientCode("bananas")).toBeNull();
    expect(resolveNutrientCode("")).toBeNull();
  });
});

describe("resolveNutrientCode — every shipped locale, not just English", () => {
  // `nutrients.names.*` already ships in all six bundles and is what the
  // settings card renders. The resolver used to compare against a hand-typed
  // English copy of that bundle, so an account whose language is French or
  // Polish got `unknown_nutrient` for the word its own screen shows.
  it.each([
    ["de", "Eisen", "iron"],
    ["es", "Hierro", "iron"],
    ["fr", "Fer", "iron"],
    ["it", "Ferro", "iron"],
    ["pl", "Żelazo", "iron"],
    ["de", "Wasser", "water"],
    ["es", "Agua", "water"],
    ["fr", "Eau", "water"],
    ["it", "Acqua", "water"],
    ["pl", "Woda", "water"],
    ["fr", "Magnésium", "magnesium"],
    ["pl", "Wapń", "calcium"],
    ["de", "Koffein", "caffeine"],
    ["it", "Iodio", "iodine"],
    ["pl", "Kwas pantotenowy (B5)", "pantothenic_acid"],
    ["fr", "Acide pantothénique (B5)", "pantothenic_acid"],
  ] as const)("resolves the %s name %s", (_locale, name, code) => {
    expect(resolveNutrientCode(name)).toBe(code);
  });

  it("folds case, accents and separators on the localised names too", () => {
    expect(resolveNutrientCode("  magnésium ")).toBe("magnesium");
    expect(resolveNutrientCode("MAGNESIO")).toBe("magnesium");
    expect(resolveNutrientCode("zelazo")).toBe("iron");
  });

  it("keeps every English spelling that resolved before resolving the same", () => {
    // The pre-fix English arms: exact code, space/hyphen folding, and a
    // display-label match. None of them may move.
    expect(resolveNutrientCode("water")).toBe("water");
    expect(resolveNutrientCode("vitamin_d")).toBe("vitamin_d");
    expect(resolveNutrientCode("Vitamin D")).toBe("vitamin_d");
    expect(resolveNutrientCode("vitamin-d")).toBe("vitamin_d");
    expect(resolveNutrientCode("MAGNESIUM")).toBe("magnesium");
    expect(resolveNutrientCode("Vitamin B12")).toBe("vitamin_b12");
    expect(resolveNutrientCode("Pantothenic acid B5")).toBe("pantothenic_acid");
    expect(resolveNutrientCode("Caffeine")).toBe("caffeine");
  });

  it("still refuses a word that is in no bundle — a parse miss stays a miss", () => {
    expect(resolveNutrientCode("bananas")).toBeNull();
    expect(resolveNutrientCode("Bananen")).toBeNull();
    expect(resolveNutrientCode("creatine")).toBeNull();
  });

  // The property, not a sample: EVERY code's name in EVERY shipped locale
  // round-trips. A seventh locale added to `locales` is covered by this test
  // the moment its bundle lands — which is the point of deriving the index
  // instead of transcribing it.
  it("round-trips every catalog code from every shipped locale's bundle", () => {
    for (const locale of locales) {
      for (const code of NUTRIENT_CODES) {
        const label = labelIn(locale, `nutrients.names.${code}`);
        expect(label, `${locale} is missing nutrients.names.${code}`).not.toBe(
          null,
        );
        expect(resolveNutrientCode(label!), `${locale}/${code}`).toBe(code);
      }
    }
  });

  it("exposes the same English label the bundle carries, not a copy of it", () => {
    for (const code of NUTRIENT_CODES) {
      expect(NUTRIENT_LABELS[code]).toBe(
        labelIn("en", `nutrients.names.${code}`),
      );
    }
  });
});

describe("getNutrients — module gate", () => {
  it("returns { present: false, reason: module_disabled } when the opt-in module is off", async () => {
    vi.mocked(isModuleEnabled).mockResolvedValue(false);
    const result = await getNutrients("user-1", {});
    expect(result).toEqual({ present: false, reason: "module_disabled" });
    expect(nutrientIntakeDay.findMany).not.toHaveBeenCalled();
  });
});

describe("getNutrients — overview mode (no `nutrient` arg)", () => {
  it("sums a day across sources and reports latest day / total / days-with-data", async () => {
    vi.mocked(nutrientIntakeDay.findMany).mockResolvedValue([
      // Two sources on the SAME latest day — must sum, not double-count the day.
      {
        nutrient: "water",
        unit: "ml",
        day: "2026-07-10",
        amount: 1200,
        source: "APPLE_HEALTH",
      },
      {
        nutrient: "water",
        unit: "ml",
        day: "2026-07-10",
        amount: 500,
        source: "MANUAL",
      },
      {
        nutrient: "water",
        unit: "ml",
        day: "2026-07-09",
        amount: 2000,
        source: "APPLE_HEALTH",
      },
    ] as never);

    const result = overview(await getNutrients("user-1", {}));
    expect(result.present).toBe(true);
    expect(result.nutrients).toEqual([
      {
        nutrient: "water",
        label: "Water",
        unit: "ml",
        latestDay: "2026-07-10",
        latestAmount: 1700,
        daysWithData: 2,
        latestBySource: { APPLE_HEALTH: 1200, MANUAL: 500 },
        upperLimit: null,
        latestAboveUpperLimit: null,
      },
    ]);
  });

  it("returns { present: false, reason: no_data } when nothing is logged", async () => {
    const result = await getNutrients("user-1", {});
    expect(result).toMatchObject({ present: false, reason: "no_data" });
  });

  it("clamps an out-of-range `days` to the overview ceiling (365)", async () => {
    const result = overview(await getNutrients("user-1", { days: 10000 }));
    expect(result.windowDays).toBe(365);
  });
});

describe("getNutrients — per-nutrient mode", () => {
  it("returns a dense day series + the resolved reference for a known-sex profile", async () => {
    vi.mocked(user.findUnique).mockResolvedValue({
      timezone: "UTC",
      gender: "FEMALE",
    } as never);
    vi.mocked(nutrientIntakeDay.findMany).mockResolvedValue([
      { day: "2026-07-10", amount: 300 },
    ] as never);

    const result = daily(
      await getNutrients("user-1", { nutrient: "magnesium", days: 3 }),
    );
    expect(result.present).toBe(true);
    expect(result.nutrient).toBe("magnesium");
    expect(result.unit).toBe("mg");
    expect(result.days).toHaveLength(3);
    // Female reference for magnesium is 300 mg (EFSA DRV 2015).
    expect(result.reference).toEqual({
      authority: "EFSA",
      kind: "AI",
      direction: "target",
      value: 300,
      source: "EFSA DRV 2015 (adults)",
    });
    expect(result.personalTarget).toBeNull();
  });

  it("omits the reference (never guesses) when the profile has no sex on file", async () => {
    vi.mocked(user.findUnique).mockResolvedValue({
      timezone: "UTC",
      gender: null,
    } as never);
    const result = daily(
      await getNutrients("user-1", { nutrient: "magnesium" }),
    );
    expect(result.reference).toBeNull();
  });

  it("resolves a free-text nutrient name (display label)", async () => {
    const result = daily(
      await getNutrients("user-1", { nutrient: "Vitamin D" }),
    );
    expect(result.nutrient).toBe("vitamin_d");
  });

  it("returns { present: false, reason: unknown_nutrient } for an unresolvable name", async () => {
    const result = await getNutrients("user-1", { nutrient: "bananas" });
    expect(result).toEqual({ present: false, reason: "unknown_nutrient" });
    expect(nutrientIntakeDay.findMany).not.toHaveBeenCalled();
  });

  it("clamps an out-of-range `days` to the per-nutrient ceiling (90)", async () => {
    const result = daily(
      await getNutrients("user-1", { nutrient: "water", days: 9000 }),
    );
    expect(result.windowDays).toBe(90);
    expect(result.days).toHaveLength(90);
  });

  it("resolves caffeine's reference as an upper-guidance ceiling, not a target", async () => {
    const result = daily(
      await getNutrients("user-1", { nutrient: "caffeine" }),
    );
    expect(result.reference).toMatchObject({
      kind: "safeLevel",
      direction: "upperGuidance",
      value: 400,
    });
  });
});
