/**
 * `GET /api/measurements` after its query has been validated: pick the list
 * mode the query asks for and answer it.
 *
 * The modes are tried in a fixed order: the per-night sleep list, the
 * cumulative day drill-down, the day-grouped cumulative list, the chart's
 * rollup series, a live aggregate, and the plain page. The route owns
 * authentication and the query refusal.
 */
import type { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import type { listMeasurementsSchema } from "@/lib/validations/measurement";
import {
  BUCKET_CAP,
  type AggregateGrain,
} from "@/lib/measurements/range-aggregation";
import { CUMULATIVE_HK_TYPES } from "@/lib/measurements/apple-health-mapping";
import { localDayWindow } from "@/lib/tz/local-day";
import { shapeMeasurementNotes } from "@/lib/crypto/note-cipher";
import {
  APPLE_HEALTH_MIRROR_SELECT,
  APPLE_HEALTH_MIRROR_WHERE,
  withAppleHealthMirror,
} from "@/lib/measurements/apple-health-mirror";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import {
  readDailySeries,
  readLiveBuckets,
} from "@/lib/measurements/daily-series-read";
import { dayGroupedListResponse } from "@/lib/measurements/list/day-grouped";
import { sleepListResponse } from "@/lib/measurements/list/sleep-list";
import { resolveStoredTimezone, resolveUserTimezone } from "@/lib/tz/resolver";
import type { MeasurementType, Prisma } from "@/generated/prisma/client";

/**
 * The columns a measurement row answers with (`MeasurementResource`), plus
 * the sealed note `shapeMeasurementNotes` decrypts onto `notes` and drops.
 * Named column by column so a column added to the model reaches the wire
 * only when someone adds it here.
 */
const MEASUREMENT_WIRE_SELECT = {
  id: true,
  userId: true,
  type: true,
  value: true,
  valueMin: true,
  valueMax: true,
  unit: true,
  source: true,
  measuredAt: true,
  notes: true,
  notesEncrypted: true,
  externalId: true,
  externalSourceVersion: true,
  aggregationProvenance: true,
  glucoseContext: true,
  sleepStage: true,
  rhythmClassification: true,
  deviceType: true,
  syncVersion: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
  // Resolved onto `appleHealthMirror` and dropped by `withAppleHealthMirror`.
  ingestToken: APPLE_HEALTH_MIRROR_SELECT.ingestToken,
} as const satisfies Prisma.MeasurementSelect;

/** One row as it is answered: the note readable, the write-back resolved. */
function wireRow<
  T extends Parameters<typeof shapeMeasurementNotes>[0] &
    Parameters<typeof withAppleHealthMirror>[0],
>(row: T) {
  return withAppleHealthMirror(shapeMeasurementNotes(row));
}

type ListQuery = z.output<typeof listMeasurementsSchema>;
type ListUser = { id: string; timezone: string | null };

export async function measurementListResponse(
  user: ListUser,
  query: ListQuery,
): Promise<Response> {
  const { type, from, to, limit, offset, sortDir, groupBy, dayKey } = query;
  const { aggregate, source, sourceEq } = query;

  // Sleep is read row-per-STAGE (≈5 rows/night × source-count), not a spot
  // sample and not a cumulative day-sum. A plain list query for
  // SLEEP_DURATION would leak every stage segment as its own "value" — the
  // "many small numbers that stand for themselves" complaint. Route it
  // through the canonical per-night aggregation (the same helper the chart
  // series + dashboard tile use) so a sleep list returns one row per night
  // carrying the night's TIME ASLEEP, with a `dayKey` drill-down to that
  // night's stage segments. Storage is untouched; only the display
  // collapses. Runs ahead of the cumulative branches because sleep is in
  // neither CUMULATIVE_HK_TYPES nor the spot-sample set.
  if (type === "SLEEP_DURATION") {
    return sleepListResponse(user, {
      from,
      to,
      limit,
      offset,
      sortDir,
      dayKey,
    });
  }

  // List-view drill-down to per-sample rows for a single calendar day in the
  // user's IANA timezone. Gated to cumulative HK types — the spot-sample
  // types render one-row-per-event already and have nothing to drill into.
  if (dayKey && type && CUMULATIVE_HK_TYPES.has(type as MeasurementType)) {
    return drillDownResponse(user, type as MeasurementType, query);
  }

  // Collapsed "one row per day" mode for cumulative types. The list page
  // renders the day's SUM as a single synthesised row with a `sampleCount`
  // chevron that drills back into the per-sample rows via the `dayKey=…`
  // branch above. `limit` / `offset` page over DAYS, not raw rows (#1245).
  if (
    groupBy === "day" &&
    type &&
    CUMULATIVE_HK_TYPES.has(type as MeasurementType)
  ) {
    return dayGroupedListResponse(user, {
      type: type as MeasurementType,
      limit,
      offset,
      sortDir,
      sourceEq,
      from,
      to,
    });
  }

  // Server-side aggregation. Gated on an explicit `aggregate` param so the
  // iOS contract (raw `MeasurementWireDTO` shape on `GET /api/measurements`)
  // is byte-stable for any caller that omits the query parameter. The
  // chart-data client opts in; iOS does not.
  //
  // `take` does not apply BEFORE bucketising. The aggregation runs in
  // Postgres via `date_trunc`, the bucket cap is applied AFTER, so a 1-year
  // `aggregate=daily` window walks every row in the window and returns up to
  // 365 buckets per type instead of truncating to the first N raw rows.
  //
  // "All time" range semantics. When the chart's "All" tab is active, the
  // client passes `from` = the user's earliest measurement (or a sentinel
  // like 1970-01-01) plus `to` = now plus `aggregate=monthly` (or `weekly`
  // when full history < 2 years). The response is bounded by the
  // `BUCKET_CAP` ceiling per grain (monthly: 24, weekly: 105, daily: 365) so
  // a multi-decade account never paints an unbounded series.
  //
  // `source=rollup` + `aggregate=daily` — the chart's series read. Windows up
  // to the DAY cap fold live into the user's local days (#1026); wider
  // windows step up to the WEEK / MONTH / YEAR rollup tier. `type` is
  // mandatory so the response mirrors the per-type ask the chart makes.
  if (source === "rollup" && aggregate === "daily" && type && from && to) {
    const series = await rollupSeriesResponse(
      user.id,
      type as MeasurementType,
      { from, to, limit },
    );
    if (series) return series;
    // An empty result means the window genuinely holds no rows. Fall
    // through to the shared live aggregate branch below to keep the
    // response shape identical for the truly-empty case.
  }

  if (aggregate && aggregate !== "raw" && from && to) {
    return liveAggregateResponse(user.id, query, aggregate, { from, to });
  }

  return plainPageResponse(user.id, query);
}

async function drillDownResponse(
  user: ListUser,
  type: MeasurementType,
  query: ListQuery,
): Promise<Response> {
  const { limit, sortDir } = query;
  const dayKey = query.dayKey as string;
  // The same zone the day-grouped list cuts its days in, so a row's
  // drill-down opens exactly the day the row summed.
  const tz = await resolveStoredTimezone(user.timezone);
  // Resolve `[dayStart, dayEnd)` for the requested calendar day in the
  // user's local zone. `localDayWindow` honours DST: the earlier shape
  // (`canonicalDailyTimestamp ± 12 h`) silently leaked or hid one hour of
  // samples on spring-forward (23-h day) and fall-back (25-h day) by always
  // spanning exactly 24 h. Works for every IANA offset including
  // sub-half-hour zones (Asia/Kathmandu UTC+5:45, Pacific/Chatham UTC+12:45).
  const { dayStart, dayEnd } = localDayWindow(dayKey, tz);
  const samples = await prisma.measurement.findMany({
    where: {
      userId: user.id,
      type,
      measuredAt: { gte: dayStart, lt: dayEnd },
      deletedAt: null,
    },
    // Same tiebreaker as the paged list. This one slices in memory rather
    // than with `skip`, so there is no page drift to prevent — but two
    // identical requests would still be free to render a tied block in
    // different orders, and a drill-down that reshuffles on refresh reads
    // as data changing.
    orderBy: [{ measuredAt: sortDir }, { id: sortDir }],
    // The 1000-row cap lives on the validator (a refine on `(limit, dayKey)`
    // returning 422 when a caller asks for more). `limit` is read straight
    // through because the validator has already clamped it.
    take: limit,
    select: MEASUREMENT_WIRE_SELECT,
  });
  annotate({
    action: { name: "measurement.list" },
    meta: { total: samples.length, type, dayKey, mode: "drill-down" },
  });
  return apiSuccess({
    // The same row shape as the plain page: the note decrypted onto `notes`,
    // the ciphertext never on the wire.
    measurements: samples.map(wireRow),
    meta: { total: samples.length, limit, offset: 0, dayKey },
  });
}

/** The chart's daily series, or null when the window holds no rows. */
async function rollupSeriesResponse(
  userId: string,
  type: MeasurementType,
  window: { from: Date; to: Date; limit: number },
): Promise<Response | null> {
  const { from, to, limit } = window;
  // Shared with the batched series endpoint, so both read the same rows.
  const cap = Math.min(limit, BUCKET_CAP.daily);
  const priorityJson = await loadUserSourcePriority(userId);
  const measurements = await readDailySeries({
    userId,
    type,
    from,
    to,
    limit,
    priorityJson,
  });
  if (measurements.length === 0) return null;
  return apiSuccess({
    measurements,
    meta: {
      total: measurements.length,
      limit: cap,
      offset: 0,
      aggregate: "daily",
    },
  });
}

async function liveAggregateResponse(
  userId: string,
  query: ListQuery,
  aggregate: Exclude<AggregateGrain, "raw">,
  window: { from: Date; to: Date },
): Promise<Response> {
  const { type, limit } = query;
  const grain: Exclude<AggregateGrain, "raw"> = aggregate;
  const cap = Math.min(limit, BUCKET_CAP[grain]);
  // Buckets are cut at the user's own calendar boundaries (#1026), the
  // same day the raw list and the chart's short range use. Cumulative
  // types SUM per bucket, every other type averages; overlapping sources
  // collapse to the ladder-canonical one first.
  const priorityJson = await loadUserSourcePriority(userId);
  const measurements = await readLiveBuckets({
    userId,
    type: (type as MeasurementType | undefined) ?? null,
    from: window.from,
    to: window.to,
    cap,
    priorityJson,
    grain,
    timeZone: await resolveUserTimezone(userId),
  });
  annotate({
    action: { name: "measurement.list" },
    meta: { total: measurements.length, type, aggregate: grain },
  });
  return apiSuccess({
    measurements,
    meta: {
      total: measurements.length,
      limit: cap,
      offset: 0,
      aggregate: grain,
    },
  });
}

async function plainPageResponse(
  userId: string,
  query: ListQuery,
): Promise<Response> {
  const { type, from, to, limit, offset, sortBy, sortDir } = query;
  const { sourceEq, valueMin, valueMax, appleHealthMirror } = query;
  const where = {
    userId,
    // Soft-deleted readings are invisible to every list / count / aggregate
    // read. The dedicated `sync/state` route keeps surfacing them via its
    // own filter so iOS can reconcile tombstones; every other consumer (list
    // view, analytics fan-out, dashboard read paths) must never include them.
    deletedAt: null,
    ...(type && { type: type as MeasurementType }),
    // Management-list source filter. Distinct from the `source=rollup`
    // opt-in (which selects the rollup read tier); `sourceEq` narrows the
    // plain list to one ingest source.
    ...(sourceEq && { source: sourceEq }),
    // The rows the app mirrors into Apple Health, by the same rule the
    // field is resolved with (`apple-health-mirror.ts`).
    ...(appleHealthMirror === "true" && { AND: [APPLE_HEALTH_MIRROR_WHERE] }),
    // Value-range filter. Open-ended on either side; the validator has
    // already rejected an inverted `valueMin > valueMax`.
    ...(valueMin != null || valueMax != null
      ? {
          value: {
            ...(valueMin != null && { gte: valueMin }),
            ...(valueMax != null && { lte: valueMax }),
          },
        }
      : {}),
    ...(from || to
      ? {
          measuredAt: {
            ...(from && { gte: from }),
            ...(to && { lte: to }),
          },
        }
      : {}),
  };

  const [measurements, total] = await Promise.all([
    prisma.measurement.findMany({
      where,
      // `{ id: sortDir }` is the tiebreaker, not decoration. `measuredAt`
      // is not unique here and ties are the normal case. Only the exact
      // tuple `(userId, type, measuredAt, source, sleepStage)` is unique,
      // so a tie survives across `type` (the `stats:<id>:YYYY-MM-DD`
      // daily-rollup convention puts every daily total at one instant),
      // across `source` (two writers landing on the same instant) and
      // across `sleepStage`. Without a unique secondary key Postgres is
      // free to order the tied block differently between the query for page
      // N and the query for page N+1, so a client paging its own history
      // silently gets one row twice and never gets another.
      orderBy: [{ [sortBy]: sortDir }, { id: sortDir }],
      take: limit,
      skip: offset,
      // Named columns, so a column added to the model (a token link) reaches
      // the wire only through this select.
      select: MEASUREMENT_WIRE_SELECT,
    }),
    prisma.measurement.count({ where }),
  ]);

  annotate({ action: { name: "measurement.list" }, meta: { total, type } });

  return apiSuccess({
    // Decrypt `notesEncrypted` onto `notes` and strip the ciphertext before
    // it leaves the server (iOS MeasurementWireDTO contract).
    measurements: measurements.map(wireRow),
    meta: { total, limit, offset },
  });
}
