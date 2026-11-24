/**
 * One cumulative metric's day totals, one source per day, with the source and
 * the time the day's total last changed on the server.
 *
 * The pick is the one the "per day" chart makes (`readLiveBuckets` in
 * `daily-series-read.ts`): each source's readings are summed per local day of
 * the reader's zone, and each day keeps the source the person's source order
 * ranks first (`buildSourceRankCase`), ties broken by the source name. An
 * account with an iPhone and a Garmin watch therefore reads one of the two per
 * day, never their sum, and the total here is the number the chart shows for
 * that day.
 *
 * What it adds over the chart read is the provenance a day total needs to be
 * shown honestly while the day is still running: which source the total is
 * from, and `lastUpdatedAt`, the newest `updated_at` among that source's rows
 * of the day. A provider that reports the day as one total (Garmin, Withings,
 * a Gadgetbridge import) rewrites that row when its total moves; a rewrite
 * with the same value keeps the stamp (`measurements_noop_update_keeps_stamps`).
 * So this is when the running total last changed on the server: never later
 * than the truth, which is what "updated" may claim on the card.
 */
import type {
  MeasurementSource,
  MeasurementType,
  PrismaClient,
} from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { buildSourceRankCase } from "@/lib/analytics/source-rank-sql";
import { isValidTimezone } from "@/lib/tz/format";
import { localDayWindow } from "@/lib/tz/local-day";
import { READING_ZONE_SLACK_MS } from "@/lib/tz/reading-zone";
import { readingWallSql } from "@/lib/tz/reading-zone-sql";

/** One local day's canonical total. */
export interface CumulativeDayTotal {
  /** Local calendar day, `YYYY-MM-DD`, in the zone the read was cut in. */
  dateKey: string;
  /** The day's total from `source`. */
  total: number;
  /** The source the person's source order picked for the day. */
  source: MeasurementSource;
  /** Newest `updated_at` among the picked source's rows of the day. */
  lastUpdatedAt: Date;
}

/**
 * The statement {@link readCanonicalCumulativeDayTotals} sends. Exported so a
 * test can run exactly what the reader runs.
 */
export function canonicalCumulativeDayTotalsSql(opts: {
  userId: string;
  type: MeasurementType;
  timeZone: string;
  /** Oldest local day, inclusive. */
  fromDateKey: string;
  /** Newest local day, inclusive. */
  toDateKey: string;
  priorityJson: unknown;
}): Prisma.Sql {
  const timeZone = isValidTimezone(opts.timeZone) ? opts.timeZone : "UTC";
  const { dayStart } = localDayWindow(opts.fromDateKey, timeZone);
  const { dayEnd } = localDayWindow(opts.toDateKey, timeZone);
  // A reading that carries its own zone may sit on a different profile day,
  // so the scan is widened by the zone slack and the day is decided on the
  // reading's own wall clock below, as `readLocalDayMinuteBuckets` does.
  const wideStart = new Date(dayStart.getTime() - READING_ZONE_SLACK_MS);
  const wideEnd = new Date(dayEnd.getTime() + READING_ZONE_SLACK_MS);
  // Code-built CASE over closed enum literals (`assertEnumLiteral` inside).
  const rank = Prisma.raw(
    buildSourceRankCase(opts.priorityJson, 'p."type"', 'p."source"'),
  );
  const wall = readingWallSql("m", timeZone);
  return Prisma.sql`
    WITH per_source AS (
      SELECT
        m."type",
        m."source",
        to_char(${wall}, 'YYYY-MM-DD') AS day,
        SUM(m."value")::double precision AS total,
        MAX(m."updated_at") AS last_updated_at
      FROM measurements m
      WHERE m."user_id" = ${opts.userId}
        AND m."type" = ${opts.type}::measurement_type
        AND m."deleted_at" IS NULL
        AND m."measured_at" >= ${wideStart}
        AND m."measured_at" < ${wideEnd}
        AND (
          m."time_zone" IS NOT NULL
          OR (m."measured_at" >= ${dayStart} AND m."measured_at" < ${dayEnd})
        )
      GROUP BY m."type", m."source", 3
    )
    SELECT DISTINCT ON (p.day)
      p.day,
      p."source"::text AS source,
      p.total,
      p.last_updated_at
    FROM per_source p
    WHERE p.day >= ${opts.fromDateKey} AND p.day <= ${opts.toDateKey}
    ORDER BY p.day, (${rank}), p."source"::text
  `;
}

/**
 * The canonical day totals of `type` over `[fromDateKey, toDateKey]`, oldest
 * first. A day without a reading is absent, not zero.
 */
export async function readCanonicalCumulativeDayTotals(opts: {
  userId: string;
  type: MeasurementType;
  timeZone: string;
  fromDateKey: string;
  toDateKey: string;
  priorityJson: unknown;
  db?: PrismaClient;
}): Promise<CumulativeDayTotal[]> {
  const rows = await (opts.db ?? prisma).$queryRaw<
    Array<{
      day: string;
      source: string;
      total: number;
      last_updated_at: Date;
    }>
  >(canonicalCumulativeDayTotalsSql(opts));
  return rows.map((r) => ({
    dateKey: r.day,
    total: Number(r.total),
    source: r.source as MeasurementSource,
    lastUpdatedAt: new Date(r.last_updated_at),
  }));
}
