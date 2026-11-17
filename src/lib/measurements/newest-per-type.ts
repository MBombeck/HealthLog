/**
 * The newest rows of each of several measurement types, capped per type.
 *
 * The bulk reads that feed the insight aggregates and the Coach snapshot used
 * to read newest-first across all their types at once under a single row cap.
 * The cap then belonged to whichever type wrote fastest: a watch sending heart
 * rate every few seconds fills 6,000 rows within hours, and every weight or
 * blood pressure reading older than those hours fell out of the read, so a
 * block reported no data for a metric with years of it (#1398).
 *
 * Here the cap applies to each type on its own. A dense type is still bounded
 * at `perTypeCap` rows, which is what the cap is for, and a sparse type keeps
 * its newest rows whatever the other types write. So each type sees exactly
 * the rows it would see if it were read alone, which is what lets a block
 * built from one type's read equal the block a read of many types builds.
 * The worst case is `perTypeCap` rows times the number of distinct types,
 * reached only when every one of them is denser than the cap.
 *
 * A read with no single-type block to match can keep its old total instead
 * (`totalCap`): every type's rows are ranked newest first within the type and
 * the `totalCap` lowest ranks are kept, so each type keeps at least
 * `totalCap / types` rows (all of them, if it has fewer), and the room a
 * sparse type leaves goes to the dense ones. No type is starved and the rows
 * returned never exceed the total.
 *
 * One statement: one index descent per type on the partial live index
 * `measurements_live_covering_idx (user_id, type, measured_at DESC) WHERE
 * deleted_at IS NULL`, each stopping at the cap, so the rows touched track the
 * rows returned, never the length of a dense stream (`liveTypeDescent` says how
 * the statement keeps the planner on that path). The driving relation is
 * aliased `mt` so the i18n call-site scanner does not read the SQL as a
 * translation call.
 */
import { prisma } from "@/lib/db";
import { liveTypeDescent } from "@/lib/measurements/live-type-descent";
import {
  Prisma,
  type GlucoseContext,
  type MeasurementSource,
  type MeasurementType,
  type SleepStage,
} from "@/generated/prisma/client";

export interface NewestPerTypeRow {
  type: MeasurementType;
  value: number;
  measuredAt: Date;
  source: MeasurementSource;
  deviceType: string | null;
  sleepStage: SleepStage | null;
  glucoseContext: GlucoseContext | null;
}

export interface NewestPerTypeRead {
  /** Every type's rows, oldest first. */
  rows: NewestPerTypeRow[];
  /** The types that reached the cap, so older rows of theirs were left out. */
  cappedTypes: MeasurementType[];
}

export async function readNewestRowsPerType(
  userId: string,
  types: readonly MeasurementType[],
  options: { perTypeCap: number; totalCap?: number; since?: Date | null },
): Promise<NewestPerTypeRead> {
  const distinct = [...new Set(types)];
  if (distinct.length === 0) return { rows: [], cappedTypes: [] };
  const { perTypeCap, totalCap } = options;
  // A total below the type count would cut whole types, the thing this read
  // exists to prevent.
  for (const cap of [perTypeCap, totalCap ?? distinct.length]) {
    if (!Number.isInteger(cap) || cap < distinct.length || cap <= 0) {
      throw new RangeError(
        "row caps must be integers of at least one per type",
      );
    }
  }
  const since = options.since ?? null;
  // With a total, each row's rank within its type orders the cut, and the
  // count per type says whether the cut reached it.
  const fairShare = totalCap !== undefined;
  const shareColumns = fairShare
    ? Prisma.sql`,
           row_number() OVER (
             PARTITION BY mt."type" ORDER BY x."measured_at" DESC, x."id" DESC
           )::int AS "rank",
           (count(*) OVER (PARTITION BY mt."type"))::int AS "read"`
    : Prisma.sql`, 0 AS "read"`;
  const shareCut = fairShare
    ? Prisma.sql`ORDER BY "rank" ASC, x."measured_at" DESC, mt."type" ASC
      LIMIT ${totalCap}`
    : Prisma.empty;
  const raw = await prisma.$queryRaw<
    Array<{
      type: string;
      value: number;
      measured_at: Date;
      source: string;
      device_type: string | null;
      sleep_stage: string | null;
      glucose_context: string | null;
      read: number;
    }>
  >`
    SELECT y."type", y."value", y."measured_at", y."source", y."device_type",
           y."sleep_stage", y."glucose_context", y."read"
    FROM (
      SELECT mt."type" AS "type", x."id", x."value", x."measured_at",
             x."source"::text AS "source", x."device_type",
             x."sleep_stage"::text AS "sleep_stage",
             x."glucose_context"::text AS "glucose_context"
             ${shareColumns}
      FROM unnest(${distinct}::text[]) AS mt("type")
      CROSS JOIN LATERAL (
        SELECT m."id", m."value", m."measured_at", m."source",
               m."device_type", m."sleep_stage", m."glucose_context"
        FROM measurements m
        ${liveTypeDescent(userId, Prisma.sql`mt."type"::measurement_type`, "newest", since)}
        LIMIT (SELECT ${perTypeCap}::int)
      ) x
      ${shareCut}
    ) y
    ORDER BY y."measured_at" ASC, y."id" ASC
  `;

  const kept = new Map<string, number>();
  const read = new Map<string, number>();
  const rows = raw.map((r) => {
    kept.set(r.type, (kept.get(r.type) ?? 0) + 1);
    read.set(r.type, Number(r.read));
    return {
      type: r.type as MeasurementType,
      value: Number(r.value),
      measuredAt: new Date(r.measured_at),
      source: r.source as MeasurementSource,
      deviceType: r.device_type,
      sleepStage: r.sleep_stage as SleepStage | null,
      glucoseContext: r.glucose_context as GlucoseContext | null,
    };
  });
  // Capped: the type filled its own cap, or the total cut it short.
  const cappedTypes = distinct.filter((t) => {
    const n = kept.get(t) ?? 0;
    return n >= perTypeCap || n < (read.get(t) ?? 0);
  });
  return { rows, cappedTypes };
}

/**
 * The oldest and newest live reading of any type from `since` on (the whole
 * history when `since` is null), so the span a capped read reports is the
 * account's, not the hours a dense stream fills of the read. One index probe
 * at each end of every type on the partial live index, each stopping at its
 * first row (`liveTypeDescent`). The type-less `(user_id, measured_at)` index
 * would answer in two probes, but on a table without statistics the planner
 * took the live partial index instead and sorted every row of the account.
 */
export async function readLiveMeasurementSpan(
  userId: string,
  since: Date | null,
): Promise<{ oldest: Date | null; newest: Date | null }> {
  const type = Prisma.sql`mt."type"`;
  const [row] = await prisma.$queryRaw<
    Array<{ oldest: Date | null; newest: Date | null }>
  >`
    SELECT min(o."at") AS "oldest", max(n."at") AS "newest"
    FROM unnest(enum_range(NULL::measurement_type)) AS mt("type")
    LEFT JOIN LATERAL (
      SELECT m."measured_at" AS "at" FROM measurements m
      ${liveTypeDescent(userId, type, "oldest", since)}
      LIMIT 1
    ) o ON true
    LEFT JOIN LATERAL (
      SELECT m."measured_at" AS "at" FROM measurements m
      ${liveTypeDescent(userId, type, "newest", since)}
      LIMIT 1
    ) n ON true
  `;
  return {
    oldest: row?.oldest ? new Date(row.oldest) : null,
    newest: row?.newest ? new Date(row.newest) : null,
  };
}

/**
 * Live readings per type from `since` on (the whole history when null) and up
 * to `until` (inclusive, when given), each counted up to `cap`: one descent
 * per type that stops at the cap, so a dense stream costs the cap, not its
 * length. A type with no reading is absent. A caller that only compares a
 * count with a threshold asks for one past it; one that asks whether a type
 * exists asks for one.
 */
export async function countLiveReadingsPerType(
  userId: string,
  types: readonly MeasurementType[],
  cap: number,
  since: Date | null,
  until: Date | null = null,
): Promise<Map<MeasurementType, number>> {
  const out = new Map<MeasurementType, number>();
  if (types.length === 0) return out;
  const rows = await prisma.$queryRaw<Array<{ type: string; n: number }>>`
    SELECT mt."type" AS type, COUNT(*)::int AS n
    FROM unnest(${[...new Set(types)]}::text[]) AS mt("type")
    CROSS JOIN LATERAL (
      SELECT 1
      FROM measurements m
      ${liveTypeDescent(userId, Prisma.sql`mt."type"::measurement_type`, "newest", since, until)}
      LIMIT (SELECT ${cap}::int)
    ) x
    GROUP BY mt."type"
  `;
  for (const r of rows) out.set(r.type as MeasurementType, Number(r.n));
  return out;
}
