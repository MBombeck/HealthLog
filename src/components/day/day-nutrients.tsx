"use client";

import Link from "next/link";

import { InlineAction } from "@/components/ui/inline-action";
import { nutrientUnitLabel } from "@/components/insights/nutrients/unit-label";
import type { DayResponse } from "@/lib/day/contract";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { NUTRIENT_CATALOG, isNutrientCode } from "@/lib/nutrients/catalog";
import { formatNutrientAmount } from "@/lib/nutrients/format-amount";

import { DAY_SECTION_LABEL } from "./day-sections";

type DayNutrient = NonNullable<DayResponse["nutrients"]>[number];

/** Groups that get a cell of their own; vitamins, minerals and omega-3 are counted. */
const CELL_GROUPS = new Set(["energy_macro", "water", "caffeine", "alcohol"]);

/**
 * The cells' reading order: energy and the macros first, as on the nutrients
 * page, then what was drunk. The server's order put caffeine beside water
 * ahead of energy.
 */
const CELL_ORDER = [
  "energy",
  "protein",
  "carbohydrates",
  "fat",
  "sugar",
  "fiber",
  "water",
  "caffeine",
  "alcohol",
];

function cellRank(code: string): number {
  const at = CELL_ORDER.indexOf(code);
  return at === -1 ? CELL_ORDER.length : at;
}

/**
 * "Nutrition": the day's nutrient totals as the server summed them, in the
 * movement section's shape (a label over a two-column grid). Energy, the
 * macros, water, caffeine and alcohol each get a cell; the micronutrients are
 * counted in one line beside the way to the nutrients page, where they are
 * listed with their references. The amounts read like the nutrients cards
 * ("2.150 kcal", "82,5 g").
 */
export function DayNutrientsSection({
  nutrients,
}: {
  nutrients: readonly DayNutrient[];
}) {
  const { t, tCount } = useTranslations();
  const fmt = useFormatters();
  const known = nutrients.filter((n) => isNutrientCode(n.code));
  const entry = (code: string) =>
    NUTRIENT_CATALOG[code as keyof typeof NUTRIENT_CATALOG];
  const cells = known
    .filter((n) => CELL_GROUPS.has(entry(n.code).group))
    .sort((a, b) => cellRank(a.code) - cellRank(b.code));
  const micronutrients = known.length - cells.length;
  if (known.length === 0) return null;

  return (
    <section className="space-y-2" data-slot="day-nutrients">
      <h3 className={DAY_SECTION_LABEL}>{t("day.groups.nutrients")}</h3>
      {cells.length > 0 ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
          {cells.map((n) => (
            <div key={n.code} className="min-w-0" data-nutrient={n.code}>
              <dt className="text-muted-foreground truncate text-xs">
                {t(entry(n.code).labelKey)}
              </dt>
              <dd className="truncate text-sm tabular-nums">
                {formatNutrientAmount(fmt, n.amount, n.unit)}{" "}
                {nutrientUnitLabel(n.unit, t)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
        {micronutrients > 0 ? (
          <span>
            {tCount("day.nutrients.micronutrients", micronutrients, {
              count: fmt.integer(micronutrients),
            })}
          </span>
        ) : null}
        <InlineAction asChild tone="primary" size="xs">
          <Link href="/insights/nutrients" data-slot="day-nutrients-open">
            {t("day.nutrients.open")}
          </Link>
        </InlineAction>
      </p>
    </section>
  );
}
