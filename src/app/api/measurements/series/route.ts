/**
 * GET /api/measurements/series?kind=&days=
 *
 * iOS-friendly time-series adapter. Maps the camelCase `kind` to the
 * canonical Prisma `MeasurementType`(s) and returns
 *   { kind, points: [{ id, at, value, secondary }], stats }
 *
 * The `kind=bloodPressure` case pairs systolic + diastolic by
 * `measuredAt` so iOS can render the dual-line chart with one fetch.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  returnAllZodIssues,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import type { MeasurementType } from "@/generated/prisma/client";

const kindEnum = z.enum([
  "weight",
  "bloodPressure",
  "pulse",
  "bodyFat",
  "glucose",
  "sleep",
  "steps",
  "totalBodyWater",
  "boneMass",
  "oxygenSaturation",
]);

const querySchema = z.object({
  kind: kindEnum,
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

const KIND_TO_TYPE: Record<z.infer<typeof kindEnum>, MeasurementType> = {
  weight: "WEIGHT",
  bloodPressure: "BLOOD_PRESSURE_SYS",
  pulse: "PULSE",
  bodyFat: "BODY_FAT",
  glucose: "BLOOD_GLUCOSE",
  sleep: "SLEEP_DURATION",
  steps: "ACTIVITY_STEPS",
  totalBodyWater: "TOTAL_BODY_WATER",
  boneMass: "BONE_MASS",
  oxygenSaturation: "OXYGEN_SATURATION",
};

interface SeriesPoint {
  id: string;
  at: string;
  value: number;
  secondary: number | null;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.round(Math.sqrt(variance) * 100) / 100;
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const parsed = querySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    // v1.4.43 W6 — iOS chart loader hot path; multi-issue 422 +
    // audit breadcrumb keyed `measurements.series.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "measurements.series.validation-failed" },
      meta: { issue_count: issues.length },
    });
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "measurements.series.validation-failed",
          details: JSON.stringify({ issues }),
        },
      })
      .catch(() => {
        /* swallow — 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422);
  }

  const { kind, days } = parsed.data;
  const since = new Date(Date.now() - days * 86_400_000);

  let points: SeriesPoint[] = [];
  if (kind === "bloodPressure") {
    const [sys, dia] = await Promise.all([
      prisma.measurement.findMany({
        where: {
          userId: user.id,
          type: "BLOOD_PRESSURE_SYS",
          measuredAt: { gte: since },
          deletedAt: null,
        },
        orderBy: { measuredAt: "asc" },
        select: { id: true, value: true, measuredAt: true },
      }),
      prisma.measurement.findMany({
        where: {
          userId: user.id,
          type: "BLOOD_PRESSURE_DIA",
          measuredAt: { gte: since },
          deletedAt: null,
        },
        orderBy: { measuredAt: "asc" },
        select: { id: true, value: true, measuredAt: true },
      }),
    ]);

    // Pair by closest timestamp within ±5 minutes.
    const PAIR_WINDOW_MS = 5 * 60_000;
    points = sys.map((s) => {
      let bestDia: { value: number; dt: number } | null = null;
      for (const d of dia) {
        const dt = Math.abs(d.measuredAt.getTime() - s.measuredAt.getTime());
        if (dt > PAIR_WINDOW_MS) continue;
        if (!bestDia || dt < bestDia.dt) {
          bestDia = { value: d.value, dt };
        }
      }
      return {
        id: s.id,
        at: s.measuredAt.toISOString(),
        value: s.value,
        secondary: bestDia?.value ?? null,
      };
    });
  } else {
    const type = KIND_TO_TYPE[kind];
    const rows = await prisma.measurement.findMany({
      where: {
        userId: user.id,
        type,
        measuredAt: { gte: since },
        deletedAt: null,
      },
      orderBy: { measuredAt: "asc" },
      select: { id: true, value: true, measuredAt: true },
    });
    points = rows.map((r) => ({
      id: r.id,
      at: r.measuredAt.toISOString(),
      value: r.value,
      secondary: null,
    }));
  }

  const dataPoints: DataPoint[] = points.map((p) => ({
    date: new Date(p.at),
    value: p.value,
  }));
  const summary = dataPoints.length > 0 ? summarize(dataPoints) : null;
  const values = dataPoints.map((p) => p.value);

  annotate({
    action: { name: "measurements.series" },
    meta: { kind, days, count: points.length },
  });

  return apiSuccess({
    kind,
    points,
    stats: summary
      ? {
          mean: summary.mean,
          min: summary.min,
          max: summary.max,
          stdDev: stdDev(values),
          count: summary.count,
        }
      : { mean: 0, min: 0, max: 0, stdDev: 0, count: 0 },
  });
});
