/**
 * The write phase of `POST /api/nutrients/batch`: land validated day totals
 * as one source's rows.
 *
 * Upsert key = the composite PK (userId, day, nutrient, source). The caller
 * picks the source from the credential (APPLE_HEALTH for the native client,
 * EXTERNAL for a bridge token) and this module writes only that source's rows,
 * so a manual water entry, a supplement total and the other day-total source
 * are never touched. A bridge's write wakes the owner's iOS devices with a
 * `nutrition` DATA_CHANGED (`push-relay/data-changed.ts`).
 *
 * Perf (measurements/batch shape): ONE indexed existence read splits the
 * entries into genuinely new (day, nutrient) pairs, landed by a single
 * `createMany`, and existing ones, updated through a batched `$transaction` of
 * per-row `update` calls (values differ per row, so a single bulk statement is
 * not available without raw SQL). A write failure marks its WHOLE group
 * `skipped upsert_failed` rather than isolating the one entry that would have
 * caused it (unavoidable once the write is batched); the request itself never
 * fails.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import type { NutrientCode } from "@/lib/nutrients/catalog";
import { NUTRIENT_SOURCE, type NutrientSource } from "@/lib/nutrients/sources";
import { noteDataChanged } from "@/lib/push-relay/data-changed";

export interface ValidNutrientEntry {
  /** Position in the request, echoed in the per-entry result. */
  index: number;
  day: string;
  nutrient: NutrientCode;
  amount: number;
  unit: string;
  externalSourceVersion: string | null;
}

export interface NutrientWriteOutcome {
  inserted: number;
  updated: number;
  /** Per entry: `inserted`, `updated`, or a failed write. */
  statuses: Array<{ index: number; status: "inserted" | "updated" | "failed" }>;
}

export async function writeNutrientDayTotals(
  userId: string,
  source: NutrientSource,
  entries: ReadonlyArray<ValidNutrientEntry>,
): Promise<NutrientWriteOutcome> {
  const outcome: NutrientWriteOutcome = {
    inserted: 0,
    updated: 0,
    statuses: [],
  };
  if (entries.length === 0) return outcome;

  const existing = await prisma.nutrientIntakeDay.findMany({
    where: {
      userId,
      source,
      OR: entries.map((e) => ({ day: e.day, nutrient: e.nutrient })),
    },
    select: { day: true, nutrient: true },
  });
  const existingKeys = new Set(existing.map((r) => `${r.day}::${r.nutrient}`));

  const toInsert: ValidNutrientEntry[] = [];
  const toUpdate: ValidNutrientEntry[] = [];
  for (const e of entries) {
    (existingKeys.has(`${e.day}::${e.nutrient}`) ? toUpdate : toInsert).push(e);
  }

  if (toInsert.length > 0) {
    try {
      const result = await prisma.nutrientIntakeDay.createMany({
        data: toInsert.map((e) => ({
          userId,
          day: e.day,
          nutrient: e.nutrient,
          amount: e.amount,
          unit: e.unit,
          source,
          externalSourceVersion: e.externalSourceVersion,
        })),
        skipDuplicates: true,
      });
      outcome.inserted += result.count;
      for (const e of toInsert) {
        outcome.statuses.push({ index: e.index, status: "inserted" });
      }
      // Rare race: a concurrent request claimed one of these keys between the
      // existence probe and this createMany, so skipDuplicates dropped that
      // row's write here — measurements/batch accepts the same count-only
      // trade-off. The database stays consistent (the racing writer's row is
      // stored); only this response's per-row label may be stale.
      if (result.count < toInsert.length) {
        annotate({
          action: { name: "nutrient.batch.insert_race" },
          meta: { attempted: toInsert.length, stored: result.count },
        });
      }
    } catch (err: unknown) {
      console.error("[nutrient-batch] bulk insert failed", err);
      for (const e of toInsert) {
        outcome.statuses.push({ index: e.index, status: "failed" });
      }
    }
  }

  if (toUpdate.length > 0) {
    try {
      await prisma.$transaction(
        toUpdate.map((e) =>
          prisma.nutrientIntakeDay.update({
            where: {
              userId_day_nutrient_source: {
                userId,
                day: e.day,
                nutrient: e.nutrient,
                source,
              },
            },
            data: {
              // Last-writer-wins on the day total: a client re-posts the
              // current and previous local day on every sync as the totals
              // grow, and a bridge posts 0 to correct a day.
              amount: e.amount,
              unit: e.unit,
              externalSourceVersion: e.externalSourceVersion,
            },
          }),
        ),
      );
      outcome.updated += toUpdate.length;
      for (const e of toUpdate) {
        outcome.statuses.push({ index: e.index, status: "updated" });
      }
    } catch (err: unknown) {
      // Logged server-side only; the client sees the closed `upsert_failed`
      // reason, never raw exception text.
      console.error("[nutrient-batch] bulk update failed", err);
      for (const e of toUpdate) {
        outcome.statuses.push({ index: e.index, status: "failed" });
      }
    }
  }
  // A bridge's day totals wake the owner's iOS devices (DATA_CHANGED); the
  // phone's own Apple Health totals do not.
  if (
    source === NUTRIENT_SOURCE.EXTERNAL &&
    outcome.inserted + outcome.updated > 0
  ) {
    void noteDataChanged(userId, ["nutrition"]);
  }
  return outcome;
}
