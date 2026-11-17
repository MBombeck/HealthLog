/**
 * The nutrient reads every surface shares: `GET /api/nutrients`,
 * `GET /api/nutrients/daily` and the MCP `get_nutrients` tool.
 *
 * A day can carry one row per source (migration 0249 put `source` in the
 * key), so every read folds a day's rows through `foldNutrientDay` (the
 * largest day-total source counts, additive sources add on top), keeps the
 * split by source, and judges the day against the nutrient's upper intake
 * level. The judgement is made here,
 * once, so no client and no prompt ever compares a number against a limit
 * of its own.
 */
import { prisma } from "@/lib/db";
import {
  NUTRIENT_CATALOG,
  NUTRIENT_CODES,
  isAboveUpperLimit,
  isNutrientCode,
  type NutrientCode,
  type NutrientUpperLimit,
} from "@/lib/nutrients/catalog";
import {
  foldNutrientDay,
  foldNutrientDays,
  type NutrientAmountBySource,
  type NutrientDayFold as DayFold,
  type NutrientDayRow,
} from "@/lib/nutrients/day-total";
import { NUTRIENT_SOURCE } from "@/lib/nutrients/sources";
import { readNutrientTargets } from "@/lib/nutrients/targets";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import type { NutrientTarget } from "@/lib/validations/nutrient-targets";

export type { NutrientAmountBySource };

interface StoredRow {
  nutrient: string;
  day: string;
  amount: number;
  unit: string;
  source: string;
}

/** Whether one folded day is above the code's upper limit (null without one). */
function dayAboveLimit(code: NutrientCode, fold: DayFold): boolean | null {
  return isAboveUpperLimit(code, {
    total: fold.total,
    supplemental: fold.bySource[NUTRIENT_SOURCE.SUPPLEMENT] ?? 0,
  });
}

/** The window's first day key, anchored on the caller's local today. */
export function nutrientWindowStart(timezone: string, days: number): string {
  return shiftDateKey(userDayKey(new Date(), timezone), -(days - 1));
}

export interface NutrientOverviewRow {
  nutrient: NutrientCode;
  unit: string;
  latestDay: string;
  latestAmount: number;
  daysWithData: number;
  latestBySource: NutrientAmountBySource;
  upperLimit: NutrientUpperLimit | null;
  latestAboveUpperLimit: boolean | null;
}

/**
 * Per nutrient with data inside the window: the latest day, its total and its
 * split, the count of distinct days with data, and the upper-limit verdict for
 * the latest day. Catalog order; a stored code that fell out of the catalog is
 * dropped rather than mislabelled.
 */
export async function readNutrientOverview(
  userId: string,
  timezone: string,
  days: number,
): Promise<{ nutrients: NutrientOverviewRow[]; rowCount: number }> {
  const since = nutrientWindowStart(timezone, days);
  const rows: StoredRow[] = await prisma.nutrientIntakeDay.findMany({
    where: { userId, day: { gte: since } },
    orderBy: [{ nutrient: "asc" }, { day: "desc" }],
    select: {
      nutrient: true,
      unit: true,
      day: true,
      amount: true,
      source: true,
    },
  });

  const byCode = new Map<
    string,
    {
      unit: string;
      latestDay: string;
      latestRows: NutrientDayRow[];
      daysSeen: Set<string>;
    }
  >();
  for (const row of rows) {
    let summary = byCode.get(row.nutrient);
    if (!summary) {
      // Rows arrive day-DESC inside each nutrient: the first day seen is the
      // latest one.
      summary = {
        unit: row.unit,
        latestDay: row.day,
        latestRows: [],
        daysSeen: new Set(),
      };
      byCode.set(row.nutrient, summary);
    }
    // A set of distinct day keys, so a day with several source rows counts
    // once.
    summary.daysSeen.add(row.day);
    if (row.day === summary.latestDay) {
      summary.latestRows.push(row);
    }
  }

  const nutrients = NUTRIENT_CODES.filter(
    (code) => isNutrientCode(code) && byCode.has(code),
  ).map((code) => {
    const summary = byCode.get(code)!;
    const latest = foldNutrientDay(summary.latestRows);
    return {
      nutrient: code,
      unit: summary.unit,
      latestDay: summary.latestDay,
      latestAmount: latest.total,
      daysWithData: summary.daysSeen.size,
      latestBySource: latest.bySource,
      upperLimit: NUTRIENT_CATALOG[code].upperLimit,
      latestAboveUpperLimit: dayAboveLimit(code, latest),
    };
  });

  return { nutrients, rowCount: rows.length };
}

export interface NutrientDailyEntry {
  day: string;
  amount: number;
  bySource: NutrientAmountBySource;
  aboveUpperLimit: boolean | null;
}

/**
 * One nutrient's dense day series over the window: one entry per calendar
 * day, 0 and an empty split on a day without data, each judged against the
 * upper limit; and the target the person set for the nutrient, or null.
 */
export async function readNutrientDaily(
  userId: string,
  timezone: string,
  nutrient: NutrientCode,
  days: number,
): Promise<{
  days: NutrientDailyEntry[];
  rowCount: number;
  personalTarget: NutrientTarget | null;
}> {
  const since = nutrientWindowStart(timezone, days);
  const [rows, targets] = await Promise.all([
    prisma.nutrientIntakeDay.findMany({
      where: { userId, nutrient, day: { gte: since } },
      select: { day: true, amount: true, source: true },
    }),
    readNutrientTargets(userId),
  ]);

  const folds = foldNutrientDays(rows, (row) => row.day);

  const series: NutrientDailyEntry[] = [];
  for (let i = 0; i < days; i++) {
    const day = shiftDateKey(since, i);
    const fold = folds.get(day) ?? { total: 0, bySource: {} };
    series.push({
      day,
      amount: fold.total,
      bySource: fold.bySource,
      aboveUpperLimit: dayAboveLimit(nutrient, fold),
    });
  }
  return {
    days: series,
    rowCount: rows.length,
    personalTarget: targets[nutrient] ?? null,
  };
}
