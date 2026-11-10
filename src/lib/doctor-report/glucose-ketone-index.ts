/**
 * The glucose-ketone index in the doctor report (#1367): count, mean, range
 * and latest over the report window, read by the one pairing rule
 * (`read-glucose-ketone-index.ts`) so the report carries the numbers the
 * ketones page shows.
 *
 * Both leaves must admit it. The index is glucose over ketones, so beside the
 * ketone series it gives the glucose back exactly: a report that withholds
 * glucose withholds the index too.
 */
import type { DoctorReportStats } from "@/lib/doctor-report-types";
import { summariseGlucoseKetoneIndex } from "@/lib/measurements/glucose-ketone-index";
import { readGlucoseKetoneIndex } from "@/lib/measurements/read-glucose-ketone-index";

import type { ReportGate } from "./selection-gate";

export async function readReportGki(
  gate: ReportGate,
  /** The report's own stats: no ketone row in the window, no read. */
  stats: Readonly<Record<string, DoctorReportStats>>,
  userId: string,
  /** The report window; `end` is inclusive, as the measurement read has it. */
  start: Date,
  end: Date,
): Promise<DoctorReportStats | null> {
  if (!gate.admits("BLOOD_KETONES") || !gate.admits("BLOOD_GLUCOSE")) {
    return null;
  }
  if (!stats.BLOOD_KETONES?.count) return null;
  const points = await readGlucoseKetoneIndex({
    userId,
    from: start,
    to: new Date(end.getTime() + 1),
  });
  const summary = summariseGlucoseKetoneIndex(points);
  if (!summary) return null;
  return {
    avg: summary.mean,
    min: summary.min,
    max: summary.max,
    count: summary.count,
    latest: summary.latest,
    latestAt: points[points.length - 1]!.at,
  };
}
