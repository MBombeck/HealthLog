import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

import type { NutrientDailySeries, NutrientOverviewRow } from "../types";

const state = vi.hoisted(() => ({
  rows: [] as NutrientOverviewRow[],
  daily: {} as Record<string, NutrientDailySeries>,
  chartLine: [] as Array<number | null>,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[1] === "daily") {
      return {
        data: state.daily[queryKey[2] as string],
        isLoading: false,
        isError: false,
        refetch: () => undefined,
      };
    }
    return {
      data: { nutrients: state.rows, windowDays: 30, lastAttempt: null },
      isLoading: false,
      isError: false,
      refetch: () => undefined,
    };
  },
  useQueryClient: () => ({ invalidateQueries: async () => undefined }),
}));

vi.mock("@/components/charts/nutrient-daily-bar-chart-dynamic", () => ({
  NutrientDailyBarChartDynamic: ({
    referenceValue,
  }: {
    referenceValue: number | null;
  }) => {
    state.chartLine.push(referenceValue);
    return <div data-slot="chart" />;
  },
}));

import { EnergyMacrosCard } from "../energy-macros-card";
import { MicronutrientsCard } from "../micronutrients-card";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { gender: "MALE" } }),
}));

function row(nutrient: string, unit: string): NutrientOverviewRow {
  return {
    nutrient,
    unit,
    latestDay: "2026-11-15",
    latestAmount: 100,
    daysWithData: 3,
  };
}

function series(
  nutrient: string,
  unit: string,
  extra: Partial<NutrientDailySeries> = {},
): NutrientDailySeries {
  return {
    nutrient,
    unit,
    windowDays: 30,
    days: [
      { day: "2026-11-14", amount: 2000 },
      { day: "2026-11-15", amount: 2150 },
    ],
    reference: null,
    personalTarget: null,
    ...extra,
  };
}

function render(node: React.ReactNode) {
  state.chartLine = [];
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("EnergyMacrosCard", () => {
  it("renders nothing when no energy or macro code has data", () => {
    state.rows = [row("water", "ml"), row("magnesium", "mg")];
    expect(render(<EnergyMacrosCard />)).toBe("");
  });

  it("offers only the logged codes and shows the first one's latest day", () => {
    state.rows = [row("energy", "kcal"), row("protein", "g")];
    state.daily = { energy: series("energy", "kcal") };
    const html = render(<EnergyMacrosCard />);
    expect(html).toContain('data-slot="nutrients-energy-macros-card"');
    expect(html).toContain('data-slot="nutrients-macros-pick-energy"');
    expect(html).toContain('data-slot="nutrients-macros-pick-protein"');
    expect(html).not.toContain("nutrients-macros-pick-fat");
    expect(html).toContain("2,150");
    expect(html).toContain("kcal");
    // Energy has no reference: no meta line, no dashed line.
    expect(html).not.toContain('data-slot="nutrients-macros-meta"');
    expect(state.chartLine).toEqual([null]);
  });

  it("draws the person's own target over the reference and names it", () => {
    state.rows = [row("protein", "g")];
    state.daily = {
      protein: series("protein", "g", {
        reference: {
          authority: "IOM",
          kind: "PRI",
          direction: "target",
          value: 56,
          source: "IOM 2005",
        },
        personalTarget: { value: 120, direction: "target" },
      }),
    };
    const html = render(<EnergyMacrosCard />);
    expect(html).toContain("Your target 120 g/day");
    expect(html).toContain("Edit target");
    expect(state.chartLine).toEqual([120]);
  });

  it("falls back to the reference with its authority when no target is set", () => {
    state.rows = [row("protein", "g")];
    state.daily = {
      protein: series("protein", "g", {
        reference: {
          authority: "IOM",
          kind: "PRI",
          direction: "target",
          value: 56,
          source: "IOM 2005",
        },
      }),
    };
    const html = render(<EnergyMacrosCard />);
    expect(html).toContain("Reference 56 g/day (IOM)");
    expect(html).toContain("Set target");
    expect(state.chartLine).toEqual([56]);
  });
});

describe("MicronutrientsCard grouping", () => {
  it("lists sodium and potassium as minerals and leaves the macros and alcohol to their own cards", () => {
    state.rows = [
      row("sodium", "mg"),
      row("potassium", "mg"),
      row("energy", "kcal"),
      row("protein", "g"),
      row("alcohol", "g"),
      row("caffeine", "mg"),
    ];
    const html = render(<MicronutrientsCard />);
    expect(html).toContain("Sodium");
    expect(html).toContain("Potassium");
    expect(html).not.toContain("Energy");
    expect(html).not.toContain("Protein");
    expect(html).not.toContain("Alcohol");
    expect(html).not.toContain("Caffeine");
    // Sodium's reference is EFSA's safe and adequate intake.
    expect(html).toContain("ref 2,000.0 mg (EFSA)");
  });
});
