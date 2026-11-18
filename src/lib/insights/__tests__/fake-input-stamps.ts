/**
 * Test double for `readMeasurementInputStamps`, answered from the mocked
 * grouped count the status tests script: per type, the live row count and
 * the newest `measuredAt`, the figures the stamp read returns.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import type { MeasurementInputStamp } from "@/lib/insights/measurement-input-stamps";

interface ScriptedGroup {
  type: MeasurementType;
  _count: { _all: number };
  _max: { measuredAt: Date | null };
}

export async function stampsFromMockedGroupBy(
  userId: string,
  types: readonly MeasurementType[],
): Promise<MeasurementInputStamp[]> {
  const { prisma } = await import("@/lib/db");
  const groupBy = prisma.measurement.groupBy as unknown as (
    args: unknown,
  ) => Promise<ScriptedGroup[] | undefined>;
  const rows =
    (await groupBy({
      by: ["type"],
      where: { userId, type: { in: [...types] }, deletedAt: null },
      _count: { _all: true },
      _max: { measuredAt: true },
    })) ?? [];
  return rows.map((r) => ({
    type: r.type,
    count: r._count._all,
    newest: r._max.measuredAt ?? null,
  }));
}
