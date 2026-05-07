import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import type { MeasurementType } from "@/generated/prisma/client";
import { measurementTypeEnum } from "@/lib/validations/measurement";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "analytics.get" } });

  // Derived from canonical enum so a new measurement type is auto-summarised
  // by /api/analytics (V3 audit: enum drift cousins).
  const types = [...measurementTypeEnum.options] as MeasurementType[];

  const measurementsByType = await Promise.all(
    types.map((type) =>
      prisma.measurement
        .findMany({
          where: { userId: user.id, type },
          orderBy: { measuredAt: "asc" },
          select: { value: true, measuredAt: true },
        })
        .then((measurements) => ({
          type,
          summary: summarize(
            measurements.map(
              (m): DataPoint => ({
                date: m.measuredAt,
                value: m.value,
              }),
            ),
          ),
        })),
    ),
  );

  const results: Record<string, ReturnType<typeof summarize>> = {};
  for (const { type, summary } of measurementsByType) {
    results[type] = summary;
  }

  // BMI calculation
  let bmi: number | null = null;
  if (user.heightCm && results.WEIGHT?.latest) {
    const heightM = user.heightCm / 100;
    bmi = Math.round((results.WEIGHT.latest / (heightM * heightM)) * 10) / 10;
  }

  // BP in-target percentage (auto-calculated from date of birth)
  let bpInTargetPct: number | null = null;
  const bpTargets = getBpTargets(user.dateOfBirth);
  if (bpTargets) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [sysData, diaData] = await Promise.all([
      prisma.measurement.findMany({
        where: {
          userId: user.id,
          type: "BLOOD_PRESSURE_SYS",
          measuredAt: { gte: thirtyDaysAgo },
        },
        select: { measuredAt: true, value: true },
      }),
      prisma.measurement.findMany({
        where: {
          userId: user.id,
          type: "BLOOD_PRESSURE_DIA",
          measuredAt: { gte: thirtyDaysAgo },
        },
        select: { measuredAt: true, value: true },
      }),
    ]);

    if (sysData.length > 0 && diaData.length > 0) {
      let inTarget = 0;
      for (const sys of sysData) {
        const closestDia = diaData.reduce((closest, dia) =>
          Math.abs(dia.measuredAt.getTime() - sys.measuredAt.getTime()) <
          Math.abs(closest.measuredAt.getTime() - sys.measuredAt.getTime())
            ? dia
            : closest,
        );
        const timeDiff = Math.abs(
          closestDia.measuredAt.getTime() - sys.measuredAt.getTime(),
        );
        if (timeDiff < 5 * 60 * 1000) {
          if (
            sys.value >= bpTargets.sysLow &&
            sys.value <= bpTargets.sysHigh &&
            closestDia.value >= bpTargets.diaLow &&
            closestDia.value <= bpTargets.diaHigh
          ) {
            inTarget++;
          }
        }
      }
      bpInTargetPct =
        sysData.length > 0
          ? Math.round((inTarget / sysData.length) * 100)
          : null;
    }
  }

  // Per-context glucose summaries (canonical mg/dL).
  const glucoseRows = await prisma.measurement.findMany({
    where: { userId: user.id, type: "BLOOD_GLUCOSE" },
    orderBy: { measuredAt: "asc" },
    select: { value: true, measuredAt: true, glucoseContext: true },
  });
  const glucoseByContext: Record<string, ReturnType<typeof summarize>> = {};
  if (glucoseRows.length > 0) {
    const contexts = ["FASTING", "POSTPRANDIAL", "RANDOM", "BEDTIME"] as const;
    for (const ctx of contexts) {
      const ctxRows = glucoseRows.filter((r) => r.glucoseContext === ctx);
      if (ctxRows.length === 0) continue;
      glucoseByContext[ctx] = summarize(
        ctxRows.map((r): DataPoint => ({ date: r.measuredAt, value: r.value })),
      );
    }
  }

  return apiSuccess({
    summaries: results,
    bmi,
    bpInTargetPct,
    glucoseByContext,
  });
});
