/**
 * The day's nutrient totals (`DayNutrient[]`): one entry per catalog code
 * the record holds for that local day, summed across sources the way the
 * nutrients page sums them (`foldNutrientDay`: the largest of the whole-day
 * sources, plus manual water and the supplement share). A bar on a nutrient
 * chart opens its day, and the day now shows the value that was tapped.
 *
 * The day key is the same local calendar day the nutrient store is keyed by,
 * so the read is one indexed lookup on the primary key's `(userId, day)`
 * prefix. A code outside the catalog (an older or newer client's) and a day
 * total of zero are left out; the list is in catalog order.
 */
import type { DayResponse } from "@/lib/day/contract";
import { prisma } from "@/lib/db";
import {
  NUTRIENT_CATALOG,
  NUTRIENT_CODES,
  isNutrientCode,
} from "@/lib/nutrients/catalog";
import { foldNutrientDays } from "@/lib/nutrients/day-total";

export type DayNutrient = NonNullable<DayResponse["nutrients"]>[number];

/** Fold one day's rows into the day's entries; exported for the unit suite. */
export function shapeDayNutrients(
  rows: ReadonlyArray<{ nutrient: string; source: string; amount: number }>,
): DayNutrient[] {
  const folds = foldNutrientDays(rows, (row) => row.nutrient);
  const out: DayNutrient[] = [];
  for (const code of NUTRIENT_CODES) {
    const fold = folds.get(code);
    if (!fold || !(fold.total > 0)) continue;
    out.push({ code, amount: fold.total, unit: NUTRIENT_CATALOG[code].unit });
  }
  return out;
}

export async function readDayNutrients(
  userId: string,
  day: string,
): Promise<DayNutrient[]> {
  const rows = await prisma.nutrientIntakeDay.findMany({
    where: { userId, day },
    select: { nutrient: true, source: true, amount: true },
  });
  return shapeDayNutrients(rows.filter((row) => isNutrientCode(row.nutrient)));
}
