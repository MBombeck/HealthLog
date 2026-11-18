/**
 * Test double for `readMeasurementSample`, fed by the grouped-aggregate rows
 * the availability tests script (one per type and unit). Each row stands for
 * a type whose whole history fits the sample, so the sample is the history:
 * its oldest reading is the group's minimum, and the mean is the scripted
 * day-weighted mean for a type that has one, the plain mean otherwise.
 */
import type { MeasurementSampleRow } from "@/lib/ai/coach/tools/measurement-sample";

export interface ScriptedGroupRow {
  type: string;
  unit: string | null;
  _count: { _all: number };
  _min: { measuredAt: Date | null; value: number | null };
  _max: { measuredAt: Date | null; value: number | null };
  _avg: { value: number | null };
}

export function sampleFromGroupRows(
  rows: readonly ScriptedGroupRow[],
  dayMeans: ReadonlyArray<{
    type: string;
    unit: string | null;
    mean: number;
  }> = [],
): MeasurementSampleRow[] {
  return rows
    .filter((r) => r._min.measuredAt !== null && r._max.measuredAt !== null)
    .map((r) => {
      const dayMean = dayMeans.find(
        (d) => d.type === r.type && d.unit === r.unit,
      );
      return {
        type: r.type,
        unit: r.unit,
        n: r._count._all,
        first_at: r._min.measuredAt as Date,
        last_at: r._max.measuredAt as Date,
        min: r._min.value,
        max: r._max.value,
        mean: r.type === "PULSE" ? (dayMean?.mean ?? null) : r._avg.value,
        oldest_at: r._min.measuredAt,
        oldest_unit: r.unit,
      };
    });
}
