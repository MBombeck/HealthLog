/**
 * The doctor report's treatment-series cells, worded once for both builders
 * (the PDF table and the clinician share view), in the report's language.
 */
import type { DoctorReportData } from "@/lib/doctor-report-types";

type Row = NonNullable<DoctorReportData["treatmentSeries"]>[number];
type T = (key: string, params?: Record<string, string | number>) => string;

const STATUS_KEY: Record<string, string> = {
  PLANNED: "treatmentSeries.status.planned",
  ACTIVE: "treatmentSeries.status.active",
  COMPLETED: "treatmentSeries.status.completed",
  EXPIRED: "treatmentSeries.status.expired",
};

/** A `YYYY-MM-DD` key as the instant a date formatter takes. */
function dayInstant(key: string): string {
  return `${key}T12:00:00.000Z`;
}

/** "3 of 6, active" or "4 sessions, completed". */
export function seriesSessionsCell(t: T, row: Row): string {
  const count =
    row.plannedSessions !== null
      ? t("treatmentSeries.progress", {
          done: row.done,
          planned: row.plannedSessions,
        })
      : t("treatmentSeries.sessionsDoneCount", { count: row.done });
  const status = STATUS_KEY[row.status];
  return status ? `${count}, ${t(status)}` : count;
}

/** From the first session (or the start) to the end, as far as it is known. */
export function seriesPeriodCell(
  t: T,
  row: Row,
  fmtDate: (iso: string) => string,
): string {
  const from = row.firstSessionAt ?? dayInstant(row.startsOn);
  const to = row.endedOn
    ? dayInstant(row.endedOn)
    : row.status === "COMPLETED"
      ? row.lastSessionAt
      : row.validUntil
        ? dayInstant(row.validUntil)
        : null;
  return to
    ? t("treatmentSeries.period", { from: fmtDate(from), to: fmtDate(to) })
    : t("treatmentSeries.periodOpen", { from: fmtDate(from) });
}
