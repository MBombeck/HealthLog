import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import type { MeasurementType } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

export async function GET() {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const types: MeasurementType[] = [
    "WEIGHT",
    "BLOOD_PRESSURE_SYS",
    "BLOOD_PRESSURE_DIA",
    "PULSE",
    "BODY_FAT",
    "SLEEP_DURATION",
    "ACTIVITY_STEPS",
  ];

  const results: Record<string, ReturnType<typeof summarize>> = {};

  for (const type of types) {
    const measurements = await prisma.measurement.findMany({
      where: { userId: sessionData.user.id, type },
      orderBy: { measuredAt: "asc" },
      select: { value: true, measuredAt: true },
    });

    const dataPoints: DataPoint[] = measurements.map((m) => ({
      date: m.measuredAt,
      value: m.value,
    }));

    results[type] = summarize(dataPoints);
  }

  // BMI calculation
  let bmi: number | null = null;
  if (sessionData.user.heightCm && results.WEIGHT?.latest) {
    const heightM = sessionData.user.heightCm / 100;
    bmi = Math.round((results.WEIGHT.latest / (heightM * heightM)) * 10) / 10;
  }

  // BP in-target percentage (auto-calculated from date of birth)
  let bpInTargetPct: number | null = null;
  const bpTargets = getBpTargets(sessionData.user.dateOfBirth);
  if (bpTargets) {
    const sysData = await prisma.measurement.findMany({
      where: {
        userId: sessionData.user.id,
        type: "BLOOD_PRESSURE_SYS",
        measuredAt: {
          gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        },
      },
      select: { measuredAt: true, value: true },
    });
    const diaData = await prisma.measurement.findMany({
      where: {
        userId: sessionData.user.id,
        type: "BLOOD_PRESSURE_DIA",
        measuredAt: {
          gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        },
      },
      select: { measuredAt: true, value: true },
    });

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

  return apiSuccess({
    summaries: results,
    bmi,
    bpInTargetPct,
  });
}
