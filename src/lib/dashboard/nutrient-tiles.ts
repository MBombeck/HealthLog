/**
 * The dashboard's nutrient strip tiles: fluid intake (`NUTRIENT_WATER`) and
 * the opt-in energy tile (`NUTRIENT_ENERGY`). Both are synthetic summary keys
 * read from `NutrientIntakeDay` rather than a `MeasurementType`, over the last
 * 30 day keys, each day folded across sources by `foldNutrientDay` (an Apple
 * Health and a manual row for one day are one day). One indexed read off
 * `(userId, nutrient, day desc)` serves both.
 *
 * Sparse by construction: only days with a write become a `DataPoint`, the
 * convention every real `MeasurementType` summary follows, so an unlogged day
 * is absent rather than a zero reading. A tile with no data in the window has
 * no block, and its key is left out entirely (as mood's is). The blocks are
 * always read and stripped afterwards by `gateSummariesByModules` when the
 * `nutrients` module is off, the fetch-then-gate posture the sleep, glucose
 * and recovery types use.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import {
  summarize,
  type DataPoint,
  type DataSummary,
} from "@/lib/analytics/trends";
import { foldNutrientDays } from "@/lib/nutrients/day-total";
import { dayKeyAsUtcMidnight } from "@/lib/tz/date-only";

export type NutrientTileBlock = { summary: DataSummary; lastSeenAt: string };

export interface NutrientTileBlocks {
  water: NutrientTileBlock | null;
  energy: NutrientTileBlock | null;
}

export async function buildNutrientTileBlocks(
  prisma: PrismaClient,
  userId: string,
): Promise<NutrientTileBlocks> {
  // eslint-disable-next-line healthlog/no-utc-day-key -- baseline: 30-day lower bound on stored nutrient day keys; a day either way at the far edge does not change a tile
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const rows = await prisma.nutrientIntakeDay.findMany({
    where: {
      userId,
      nutrient: { in: ["water", "energy"] },
      day: { gte: since },
    },
    select: { nutrient: true, day: true, amount: true, source: true },
  });
  return {
    water: nutrientTileBlock(rows.filter((row) => row.nutrient === "water")),
    energy: nutrientTileBlock(rows.filter((row) => row.nutrient === "energy")),
  };
}

/** One nutrient's 30-day tile block from its day rows; null with none. */
function nutrientTileBlock(
  rows: ReadonlyArray<{ day: string; amount: number; source: string }>,
): NutrientTileBlock | null {
  if (rows.length === 0) return null;
  const folds = foldNutrientDays(rows, (row) => row.day);
  const points: DataPoint[] = [...folds.entries()]
    .map(([day, fold]) => ({
      date: dayKeyAsUtcMidnight(day),
      value: fold.total,
    }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  return {
    summary: summarize(points),
    lastSeenAt: points[points.length - 1].date.toISOString(),
  };
}

/**
 * Fold the blocks into the slim slice under their synthetic keys, before the
 * module gate strips them with the rest when `nutrients` is off. The slice is
 * the shared cache cell's value: this folds into copies, never into it.
 */
export function foldNutrientTiles<
  S extends Record<string, unknown>,
  L extends Record<string, unknown>,
>(
  slim: { summaries: S; lastSeenByType: L },
  blocks: NutrientTileBlocks,
  nowMs: number,
): { summaries: S; lastSeenByType: L } {
  const entries: Array<[string, NutrientTileBlock]> = [];
  if (blocks.water) entries.push(["NUTRIENT_WATER", blocks.water]);
  if (blocks.energy) entries.push(["NUTRIENT_ENERGY", blocks.energy]);
  if (entries.length === 0) return slim;
  const summaries = { ...slim.summaries };
  const lastSeenByType = { ...slim.lastSeenByType };
  for (const [key, block] of entries) {
    (summaries as Record<string, unknown>)[key] = block.summary;
    (lastSeenByType as Record<string, unknown>)[key] = {
      lastSeenAt: block.lastSeenAt,
      daysAgo: Math.floor(
        (nowMs - new Date(block.lastSeenAt).getTime()) / (24 * 60 * 60 * 1000),
      ),
    };
  }
  return { summaries, lastSeenByType };
}
