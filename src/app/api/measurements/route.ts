import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import {
  createMeasurementSchema,
  createBatchMeasurementSchema,
  listMeasurementsSchema,
  getUnitForType,
} from "@/lib/validations/measurement";
import {
  BUCKET_CAP,
  type AggregateGrain,
} from "@/lib/measurements/range-aggregation";
import { CUMULATIVE_HK_TYPES } from "@/lib/measurements/apple-health-mapping";
import {
  canonicalDailyTimestamp,
  dayKeyForUserTz,
  localDayWindow,
} from "@/lib/measurements/drain-per-sample-cumulative";
import { withIdempotency } from "@/lib/idempotency";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import {
  recomputeBucketsForMeasurement,
  collapseToTypeDayKeys,
} from "@/lib/measurements/rollups";
import { NextRequest } from "next/server";
import type {
  MeasurementType,
  MeasurementSource,
  GlucoseContext,
} from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = listMeasurementsSchema.safeParse(params);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const {
    type,
    from,
    to,
    limit,
    offset,
    sortBy,
    sortDir,
    aggregate,
    source,
    groupBy,
    dayKey,
  } = parsed.data;

  const where = {
    userId: user.id,
    ...(type && { type: type as MeasurementType }),
    ...(from || to
      ? {
          measuredAt: {
            ...(from && { gte: from }),
            ...(to && { lte: to }),
          },
        }
      : {}),
  };

  // v1.4.37 W7c — list-view drill-down to per-sample rows for a single
  // calendar day in the user's IANA timezone. Resolves the day's UTC
  // bounds against `User.timezone`, then runs a plain `findMany` so the
  // expandable list row shows every per-sample chunk the daily collapse
  // hid. Gated to cumulative HK types — the spot-sample types render
  // one-row-per-event already and have nothing to drill into.
  if (dayKey && type && CUMULATIVE_HK_TYPES.has(type as MeasurementType)) {
    const tz =
      user.timezone && user.timezone.length > 0
        ? user.timezone
        : "Europe/Berlin";
    // Resolve `[dayStart, dayEnd)` for the requested calendar day in
    // the user's local zone. v1.4.37 W10 — `localDayWindow` honours
    // DST: the previous shape (`canonicalDailyTimestamp ± 12 h`)
    // silently leaked or hid one hour of samples on spring-forward
    // (23-h day) and fall-back (25-h day) by always spanning exactly
    // 24 h. Works for every IANA offset including sub-half-hour
    // zones (Asia/Kathmandu UTC+5:45, Pacific/Chatham UTC+12:45).
    const { dayStart, dayEnd } = localDayWindow(dayKey, tz);
    const samples = await prisma.measurement.findMany({
      where: {
        userId: user.id,
        type: type as MeasurementType,
        measuredAt: { gte: dayStart, lt: dayEnd },
      },
      orderBy: { measuredAt: sortDir },
      // Cap the drill-down — a phone-only stepCount day can hit a few
      // hundred rows; the route ceiling keeps a pathological day bounded.
      take: Math.min(limit, 1000),
    });
    annotate({
      action: { name: "measurement.list" },
      meta: { total: samples.length, type, dayKey, mode: "drill-down" },
    });
    return apiSuccess({
      measurements: samples,
      meta: { total: samples.length, limit, offset: 0, dayKey },
    });
  }

  // v1.4.37 W7c — collapsed "one row per day" mode for cumulative
  // types. The list page renders the day's SUM as a single synthesised
  // row with a `sampleCount` chevron that drills back into the
  // per-sample rows via the `dayKey=…` branch above.
  if (
    groupBy === "day" &&
    type &&
    CUMULATIVE_HK_TYPES.has(type as MeasurementType)
  ) {
    const tz =
      user.timezone && user.timezone.length > 0
        ? user.timezone
        : "Europe/Berlin";
    const rows = await prisma.measurement.findMany({
      where,
      orderBy: { measuredAt: "asc" },
      // Per-sample row scan within the requested window — bounded by
      // the existing `limit` cap (default 100, max 5000) so a wide
      // multi-year window can still walk the whole range when the
      // chart explicitly asks for it.
      take: limit,
      select: {
        id: true,
        type: true,
        value: true,
        unit: true,
        source: true,
        measuredAt: true,
        notes: true,
      },
    });

    // Group by the user's calendar day, sum values, keep a representative
    // unit/source from the bucket's first row so the rendered row carries
    // a sensible label even when the bucket mixes sources.
    type Bucket = {
      dayKey: string;
      total: number;
      sampleCount: number;
      latest: Date;
      unit: string;
      source: string;
    };
    const buckets = new Map<string, Bucket>();
    for (const row of rows) {
      const key = dayKeyForUserTz(row.measuredAt, tz);
      const slot = buckets.get(key);
      if (!slot) {
        buckets.set(key, {
          dayKey: key,
          total: row.value,
          sampleCount: 1,
          latest: row.measuredAt,
          unit: row.unit,
          source: row.source,
        });
      } else {
        slot.total += row.value;
        slot.sampleCount += 1;
        if (row.measuredAt > slot.latest) slot.latest = row.measuredAt;
      }
    }

    const measurements = Array.from(buckets.values())
      .map((b) => ({
        // Synthetic id so the list-row key stays stable across pages
        // and the row never collides with a real `Measurement.id`.
        id: `day:${type}:${b.dayKey}`,
        type,
        value: b.total,
        unit: b.unit,
        source: b.source,
        // Anchor the row's timestamp to local noon so the row sorts
        // cleanly between same-day spot samples — matches the
        // `canonicalDailyTimestamp` convention used by the drain.
        measuredAt: canonicalDailyTimestamp(b.dayKey, tz).toISOString(),
        notes: null,
        dayKey: b.dayKey,
        sampleCount: b.sampleCount,
      }))
      .sort((a, b) => {
        const cmp = a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0;
        return sortDir === "asc" ? cmp : -cmp;
      });

    annotate({
      action: { name: "measurement.list" },
      meta: {
        total: measurements.length,
        type,
        groupBy: "day",
        rowsScanned: rows.length,
      },
    });
    return apiSuccess({
      measurements,
      meta: {
        total: measurements.length,
        limit,
        offset: 0,
        groupBy: "day",
      },
    });
  }

  // v1.4.28 FB-D2 — server-side aggregation. Gated on an explicit
  // `aggregate` param so the iOS contract (raw `MeasurementWireDTO`
  // shape on `GET /api/measurements`) is byte-stable for any caller
  // that omits the new query parameter. The chart-data client opts
  // in; iOS does not.
  //
  // R4-CODE-C1 — `take` no longer applies BEFORE bucketising. The
  // aggregation runs in Postgres via `date_trunc`, the bucket cap is
  // applied AFTER, so a 1-year `aggregate=daily` window walks every
  // row in the window and returns up to 365 buckets per type instead
  // of truncating to the first N raw rows.
  //
  // SD-H1 — "All time" range semantics. When the chart's "All" tab
  // is active, the client passes `from` = the user's earliest
  // measurement (or a sentinel like 1970-01-01) plus `to` = now plus
  // `aggregate=monthly` (or `weekly` when full history < 2 years).
  // The route's response is bounded by the `BUCKET_CAP` ceiling per
  // grain (monthly: 24, weekly: 105, daily: 365) so a multi-decade
  // account never paints an unbounded series.
  // v1.4.36 W1 — rollup-table read for daily aggregates.
  //
  // The Insights trends row fires three parallel
  // `GET /api/measurements?type=…&aggregate=daily&limit=5000` requests
  // (BP_SYS / BP_DIA / WEIGHT). The legacy `date_trunc('day', …)`
  // path scanned the measurements table each time — a full year window
  // on Marc's account hit 3 × ~3 s on the v1.4.35 HAR. Reading from
  // the persistent `measurement_rollups` DAY buckets drops each call
  // to a small indexed read against the ~5 k-row rollup table.
  //
  // Gating:
  //   - `source=rollup` is an explicit client opt-in (`@/lib/validations/measurement`
  //     constrains the enum to `["rollup"]`).
  //   - We require `aggregate=daily` because the rollup populator only
  //     keeps DAY buckets on the synchronous write hook; the WEEK /
  //     MONTH paths still depend on the async pg-boss recomputes which
  //     may lag behind a recent write.
  //   - `type` is mandatory so the response shape mirrors the per-type
  //     ask the chart code makes.
  //   - When the rollup window returns zero rows we fall through to
  //     the live `date_trunc` path so a brand-new account whose
  //     populator hasn't caught up still sees a correct chart on its
  //     first render.
  if (
    source === "rollup" &&
    aggregate === "daily" &&
    type &&
    from &&
    to
  ) {
    const cap = Math.min(limit, BUCKET_CAP.daily);
    const rollupRows = await prisma.measurementRollup.findMany({
      where: {
        userId: user.id,
        type: type as MeasurementType,
        granularity: "DAY",
        bucketStart: { gte: from, lte: to },
      },
      orderBy: { bucketStart: "asc" },
      take: cap,
      select: {
        type: true,
        bucketStart: true,
        mean: true,
        count: true,
      },
    });
    if (rollupRows.length > 0) {
      // Cumulative metrics (steps, active energy, distance, flights,
      // daylight) store `mean` per bucket but the chart needs the
      // daily SUM. Reconstruct as `mean * count` — algebraically
      // equivalent to SUM(value) for a single-source day because
      // AVG = SUM / COUNT.
      const useSum =
        type != null && CUMULATIVE_HK_TYPES.has(type as MeasurementType);
      const measurements = rollupRows.map((r) => ({
        type: r.type,
        value: useSum ? r.mean * r.count : r.mean,
        measuredAt: r.bucketStart.toISOString(),
        count: r.count,
      }));
      annotate({
        action: { name: "measurement.list" },
        meta: {
          total: measurements.length,
          type,
          aggregate: "daily",
          source: "rollup",
        },
      });
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
    // Fall through to the live aggregate path when the rollup is
    // empty for the requested window — covers brand-new accounts +
    // the race between a recent write hook and the read.
  }

  if (aggregate && aggregate !== "raw" && from && to) {
    const grain: AggregateGrain = aggregate;
    const cap = Math.min(limit, BUCKET_CAP[grain]);
    // Postgres `date_trunc` requires the unit argument to be a SQL
    // literal — it cannot be supplied as a prepared-statement parameter.
    // The previous `${truncUnit}` (bound) interpolation 500'd in
    // production for every grain; the grain string is restricted to
    // the `AggregateGrain` enum upstream via the Zod schema, so
    // injecting the mapped unit via `Prisma.raw` is safe. The mapping
    // also fixes the "weekly"/"monthly" passthrough — Postgres expects
    // the singular forms `week`/`month`.
    const TRUNC_UNIT: Record<Exclude<AggregateGrain, "raw">, string> = {
      daily: "day",
      weekly: "week",
      monthly: "month",
    };
    const truncUnit = TRUNC_UNIT[grain];
    const truncUnitLiteral = Prisma.raw(`'${truncUnit}'`);
    // Cumulative HK types (steps, active energy, flights, distance,
    // daylight) are partial-day increments — averaging across the day
    // understates the daily total by the per-bucket sample count.
    // SUM for those; AVG for spot metrics (BP, weight, pulse, BG,
    // body fat, mood, sleep). See R-A finding 2.
    const useSum =
      type != null && CUMULATIVE_HK_TYPES.has(type as MeasurementType);
    const aggregator = useSum
      ? Prisma.raw(`SUM(m."value")::double precision`)
      : Prisma.raw(`AVG(m."value")::double precision`);
    const buckets = await prisma.$queryRaw<
      Array<{ type: string; bucket_start: Date; avg: number; cnt: number }>
    >`
      SELECT
        m."type"::text AS type,
        date_trunc(${truncUnitLiteral}, m."measured_at") AS bucket_start,
        ${aggregator} AS avg,
        COUNT(*)::int AS cnt
      FROM measurements m
      WHERE m."user_id" = ${user.id}
        AND m."measured_at" >= ${from}
        AND m."measured_at" <= ${to}
        ${type ? Prisma.sql`AND m."type" = ${type}::measurement_type` : Prisma.empty}
      GROUP BY m."type", bucket_start
      ORDER BY bucket_start ASC
      LIMIT ${cap}
    `;

    const measurements = buckets.map((b) => ({
      type: b.type,
      value: Number(b.avg),
      measuredAt: b.bucket_start.toISOString(),
      count: Number(b.cnt),
    }));
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

  const [measurements, total] = await Promise.all([
    prisma.measurement.findMany({
      where,
      orderBy: { [sortBy]: sortDir },
      take: limit,
      skip: offset,
    }),
    prisma.measurement.count({ where }),
  ]);

  annotate({ action: { name: "measurement.list" }, meta: { total, type } });

  return apiSuccess({
    measurements,
    meta: { total, limit, offset },
  });
});

export const POST = apiHandler(withIdempotency<[NextRequest]>(postMeasurement));

async function postMeasurement(request: NextRequest) {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request);

  if (jsonError) return jsonError;

  // Batch mode (array of measurements, e.g. combined BP + Pulse)
  if (Array.isArray(body)) {
    const parsed = createBatchMeasurementSchema.safeParse({
      measurements: body,
    });
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const results = await prisma.$transaction(
      parsed.data.measurements.map((m) =>
        prisma.measurement.create({
          data: {
            userId: user.id,
            type: m.type as MeasurementType,
            value: m.value,
            unit: getUnitForType(m.type),
            source: (m.source ?? "MANUAL") as MeasurementSource,
            measuredAt: m.measuredAt,
            notes: m.notes ?? null,
            glucoseContext:
              (m.glucoseContext as GlucoseContext | undefined) ?? null,
            // v1.4.25 W10 reconcile (code-review M4): mirror the
            // single-entry path so the multi-entry batch persists
            // `deviceType` instead of silently dropping it.
            deviceType: m.deviceType ?? null,
          },
        }),
      ),
    );

    await auditLog("measurement.create.batch", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        count: results.length,
        types: parsed.data.measurements.map((m) => m.type),
      },
    });

    annotate({
      action: { name: "measurement.create.batch" },
      meta: {
        count: results.length,
        types: parsed.data.measurements.map((m) => m.type),
      },
    });

    // v1.4.34 IW-G — flush every cache that reflects this user's
    // measurement set so the next read paints the new rows.
    invalidateUserMeasurements(user.id);

    // v1.5.0 — refresh the persistent rollup table for every distinct
    // (type, day) the batch touched so the next analytics / coach read
    // hits the cache rather than falling through to live aggregation.
    // Collapsed by day so a multi-entry batch on the same morning fires
    // one DAY recompute per type instead of one per row. Best-effort
    // — a populator hiccup never fails the user's write.
    try {
      const keys = collapseToTypeDayKeys(
        results.map((r) => ({ type: r.type, measuredAt: r.measuredAt })),
      );
      for (const k of keys) {
        await recomputeBucketsForMeasurement(user.id, k.type, k.measuredAt);
      }
    } catch (err) {
      console.warn("[measurements] rollup recompute failed", err);
    }

    return apiSuccess(results, 201);
  }

  // Single mode (existing behavior)
  const parsed = createMeasurementSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const { type, value, measuredAt, notes, source, glucoseContext, deviceType } =
    parsed.data;

  // Handle unique constraint violation
  let measurement;
  try {
    measurement = await prisma.measurement.create({
      data: {
        userId: user.id,
        type: type as MeasurementType,
        value,
        unit: getUnitForType(type),
        source: (source ?? "MANUAL") as MeasurementSource,
        measuredAt,
        notes: notes ?? null,
        glucoseContext: (glucoseContext as GlucoseContext | undefined) ?? null,
        // v1.4.25 W10 reconcile (code-review M4): the deviceType column
        // already accepts client metadata from the batch route. Mirror
        // the behaviour here so single-entry POST persists the tag
        // instead of silently dropping it.
        deviceType: deviceType ?? null,
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return apiError("A measurement with this data already exists", 409);
    }
    throw err;
  }

  await auditLog("measurement.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { type, measurementId: measurement.id },
  });

  annotate({
    action: {
      name: "measurement.create",
      entity_type: "measurement",
      entity_id: measurement.id,
    },
  });

  // v1.4.34 IW-G — flush every cache that reflects this user's
  // measurement set so the next read paints the new row.
  invalidateUserMeasurements(user.id);

  // v1.5.0 — refresh the persistent rollup row for the affected
  // (type, day) tuple. Runs inline so the next read of the
  // comprehensive / analytics surface is correct without waiting on
  // pg-boss; WEEK / MONTH / YEAR recomputes are enqueued under the
  // hood. Best-effort — a populator hiccup never fails the user's
  // write.
  try {
    await recomputeBucketsForMeasurement(
      user.id,
      measurement.type,
      measurement.measuredAt,
    );
  } catch (err) {
    console.warn("[measurements] rollup recompute failed", err);
  }

  return apiSuccess(measurement, 201);
}
