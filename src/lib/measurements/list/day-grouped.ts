import { prisma } from "@/lib/db";
import { readingWallSql } from "@/lib/tz/reading-zone-sql";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { metricKeyForType } from "@/lib/measurements/cumulative-day-sum";
import { pickCanonicalSourceRows } from "@/lib/analytics/source-priority";
import { canonicalDailyTimestamp } from "@/lib/measurements/drain-per-sample-cumulative";
import { localDayWindow } from "@/lib/tz/local-day";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { resolveStoredTimezone } from "@/lib/tz/resolver";
import {
  Prisma,
  type MeasurementSource,
  type MeasurementType,
} from "@/generated/prisma/client";
import { pageWithWindowTotal } from "./paging";
import { userDayKey } from "@/lib/tz/format";

/**
 * The day-grouped list for a cumulative type, paged over local days.
 *
 * Everything heavy runs in Postgres. The first query picks the page: the
 * distinct local days that hold a reading, sorted and cut by `limit` /
 * `offset`, each row carrying the distinct-day count of the whole filtered
 * set as `meta.total` from a window count. The second folds only the page's
 * days, one row per day, source, device and unit with its sum and sample
 * count, and the source ladder picks among those groups exactly as it would
 * among the raw rows (it keeps or drops whole source and device groups per
 * day, never single rows). So a page costs its own days whatever the length
 * of the history, every day is complete, and no raw row reaches the heap.
 *
 * Until v1.43.6 the branch read the newest `limit` raw rows (the web asked
 * for 5000), bucketed them and returned every bucket. A long history came
 * back as thousands of rows in one response, and every day older than the
 * 5000th raw row was missing with nothing to say so.
 *
 * A day exists for the page when any reading of the type falls on it; the
 * source collapse narrows a day's groups but never empties one, so the count
 * and the folded rows agree. A value range would filter single readings and
 * leave partial days behind, so the validator refuses `valueMin` /
 * `valueMax` beside `groupBy=day`.
 *
 * Every page reads the filtered history to find its days. After the nightly
 * drain a cumulative type holds about one row per day and source, so the
 * scan is the index-only walk over days it would be anyway.
 */
export async function dayGroupedListResponse(
  user: { id: string; timezone?: string | null },
  opts: {
    type: MeasurementType;
    limit: number;
    offset: number;
    sortDir: "asc" | "desc";
    sourceEq?: MeasurementSource;
    from?: Date;
    to?: Date;
  },
) {
  const { type, limit, offset, sortDir } = opts;
  // One resolver for the stored zone, shared with the drill-down and the
  // sleep list: a usable IANA name or the instance default, never a value
  // Postgres would refuse. The drill-down must cut the same days.
  const tz = await resolveStoredTimezone(user.timezone);

  // The request's filters, as SQL: the same ones the plain list applies.
  const filters = Prisma.sql`
    m."user_id" = ${user.id}
    AND m."type" = ${type}::measurement_type
    AND m."deleted_at" IS NULL
    ${opts.sourceEq ? Prisma.sql`AND m."source" = ${opts.sourceEq}::measurement_source` : Prisma.empty}
    ${opts.from ? Prisma.sql`AND m."measured_at" >= ${opts.from}` : Prisma.empty}
    ${opts.to ? Prisma.sql`AND m."measured_at" <= ${opts.to}` : Prisma.empty}
  `;
  // A reading's own zone decides its day when it carries one (iOS #181).
  const localDay = Prisma.sql`to_char(${readingWallSql("m", tz)}, 'YYYY-MM-DD')`;
  // Direction comes from the Zod enum, never from raw input. The window
  // count runs before LIMIT, so every row of the page carries the
  // distinct-day total of the whole filtered set.
  const direction = Prisma.raw(sortDir === "asc" ? "ASC" : "DESC");
  const { rows: pageDays, total } = await pageWithWindowTotal(
    await prisma.$queryRaw<Array<{ day_key: string; total: number }>>`
      SELECT d.day_key, (COUNT(*) OVER ())::int AS total
      FROM (
        SELECT ${localDay} AS day_key
        FROM measurements m
        WHERE ${filters}
        GROUP BY 1
      ) d
      ORDER BY d.day_key ${direction}
      LIMIT ${limit} OFFSET ${offset}
    `,
    offset,
    async () =>
      Number(
        (
          await prisma.$queryRaw<Array<{ total: number }>>`
            SELECT COUNT(DISTINCT ${localDay})::int AS total
            FROM measurements m
            WHERE ${filters}
          `
        )[0]?.total ?? 0,
      ),
  );
  const dayKeys = pageDays.map((d) => d.day_key);

  // The page's days are consecutive in the sorted day set, so the span from
  // the first one's start to the last one's end holds exactly their rows.
  let groups: Array<{
    day_key: string;
    source: MeasurementSource;
    device_type: string | null;
    unit: string;
    total: number;
    n: number;
  }> = [];
  if (dayKeys.length > 0) {
    const sorted = [...dayKeys].sort();
    const spanStart = localDayWindow(sorted[0], tz).dayStart;
    const spanEnd = localDayWindow(sorted[sorted.length - 1], tz).dayEnd;
    // Newest group first within a day, so the day's label comes from its
    // latest reading, as it did when raw rows were read newest first.
    groups = await prisma.$queryRaw`
      SELECT
        ${localDay} AS day_key,
        m."source"::text AS source,
        m."device_type" AS device_type,
        m."unit" AS unit,
        SUM(m."value")::float8 AS total,
        COUNT(*)::int AS n
      FROM measurements m
      WHERE ${filters}
        AND m."measured_at" >= ${spanStart}
        AND m."measured_at" < ${spanEnd}
      GROUP BY 1, 2, 3, 4
      ORDER BY 1, MAX(m."measured_at") DESC, 2, 3, 4
    `;
  }

  // v1.29.6 — collapse overlapping sources to the ladder-canonical
  // reading per day BEFORE summing. Without this, a day with both an
  // Apple Health AND a Withings write for the same cumulative metric
  // (e.g. steps) summed BOTH sources into one inflated total — a day
  // the dashboard tile (which reads through the source-collapsed
  // rollup, `collapseRollupRowsBySource` in
  // `src/lib/rollups/measurement-read.ts`) showed correctly. Uses the
  // same `metricKeyForType` ladder lookup the rollup collapse uses, so
  // this list and the tile agree on which source wins. A type with no
  // ladder (e.g. TIME_IN_DAYLIGHT, FALL_COUNT) has nothing to collapse
  // against — every group passes through unchanged. Each group stands at
  // its day's local noon, so the picker files it under the day SQL cut.
  const groupRows = groups.map((g) => ({
    ...g,
    type,
    deviceType: g.device_type,
    measuredAt: canonicalDailyTimestamp(g.day_key, tz),
  }));
  const metricKey = metricKeyForType(type);
  const priorityJson = metricKey ? await loadUserSourcePriority(user.id) : null;
  const canonicalGroups = metricKey
    ? pickCanonicalSourceRows(groupRows, metricKey, priorityJson, (d) =>
        userDayKey(d, tz),
      ).canonicalRows
    : groupRows;

  // Sum per local day; unit and source come from the day's first kept group
  // so the rendered row carries a sensible label even when sources mix.
  const buckets = new Map<
    string,
    { total: number; sampleCount: number; unit: string; source: string }
  >();
  for (const g of canonicalGroups) {
    const slot = buckets.get(g.day_key);
    if (!slot) {
      buckets.set(g.day_key, {
        total: g.total,
        sampleCount: g.n,
        unit: g.unit,
        source: g.source,
      });
    } else {
      slot.total += g.total;
      slot.sampleCount += g.n;
    }
  }
  const rowsScanned = groups.reduce((sum, g) => sum + g.n, 0);
  const rowsKept = canonicalGroups.reduce((sum, g) => sum + g.n, 0);

  // Rows follow the page's day order from SQL.
  const measurements = dayKeys.flatMap((dayKey) => {
    const b = buckets.get(dayKey);
    if (!b) return [];
    return [
      {
        // Synthetic id so the list-row key stays stable across pages
        // and the row never collides with a real `Measurement.id`.
        id: `day:${type}:${dayKey}`,
        type,
        value: b.total,
        unit: b.unit,
        source: b.source,
        // Anchor the row's timestamp to local noon so the row sorts
        // cleanly between same-day spot samples — matches the
        // `canonicalDailyTimestamp` convention used by the drain.
        measuredAt: canonicalDailyTimestamp(dayKey, tz).toISOString(),
        notes: null,
        dayKey,
        sampleCount: b.sampleCount,
      },
    ];
  });

  annotate({
    action: { name: "measurement.list" },
    meta: {
      total,
      type,
      groupBy: "day",
      days: measurements.length,
      rowsScanned,
      droppedDuplicates: rowsScanned - rowsKept,
    },
  });
  return apiSuccess({
    measurements,
    meta: {
      total,
      limit,
      offset,
      groupBy: "day",
      droppedDuplicates: rowsScanned - rowsKept,
    },
  });
}
