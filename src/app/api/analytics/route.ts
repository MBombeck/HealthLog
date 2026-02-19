import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
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

  // BP in-target percentage
  let bpInTargetPct: number | null = null;
  const { bpSysTargetLow, bpSysTargetHigh, bpDiaTargetLow, bpDiaTargetHigh } =
    sessionData.user;
  if (bpSysTargetLow && bpSysTargetHigh && bpDiaTargetLow && bpDiaTargetHigh) {
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
      // Match sys/dia by closest timestamp
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
        // Only pair if within 5 minutes
        if (timeDiff < 5 * 60 * 1000) {
          if (
            sys.value >= bpSysTargetLow &&
            sys.value <= bpSysTargetHigh &&
            closestDia.value >= bpDiaTargetLow &&
            closestDia.value <= bpDiaTargetHigh
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
