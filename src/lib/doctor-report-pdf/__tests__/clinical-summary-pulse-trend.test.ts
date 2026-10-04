import { describe, expect, it } from "vitest";

import { buildClinicalSummaryLines } from "../clinical-summary";
import type { DoctorReportData } from "../../doctor-report-data";

/**
 * The cover sheet's trend arrow compares the first half of a series with the
 * second. On the raw path a pulse series holds every reading, so its halves
 * were halves by reading count and a dense workout hour decided the arrow. It
 * now compares day values, each the mean of its hours' means.
 *
 * Day 1: three resting readings at 60. Day 2: a workout hour of twelve
 * readings at 150, then three resting hours at 60. By readings the halves are
 * equal (120 and 120, "→"); by day the pulse rose from 60 to 82.5 ("↑").
 */
function series(type: string) {
  const at = (d: number, h: number, m = 0) =>
    new Date(Date.UTC(2026, 2, d, h, m)).toISOString();
  return [
    ...[8, 9, 10].map((h) => ({ value: 60, measuredAt: at(2, h) })),
    ...Array.from({ length: 12 }, (_, i) => ({
      value: 150,
      measuredAt: at(3, 10, i * 5),
    })),
    ...[12, 14, 16].map((h) => ({ value: 60, measuredAt: at(3, h) })),
  ].map((p) => ({ ...p, type }));
}

function arrowFor(type: string): string | undefined {
  const points = series(type).map(({ value, measuredAt }) => ({
    value,
    measuredAt,
  }));
  const data = {
    period: { days: 2, since: "", start: "", end: "" },
    measurements: { [type]: points },
    stats: {
      [type]: { avg: 0, min: 60, max: 150, count: points.length, latest: 60 },
    },
    compliance: {},
  } as unknown as DoctorReportData;
  const lines = buildClinicalSummaryLines(
    data,
    (key, vars) => `${key}|${String(vars?.arrow ?? "")}`,
    (n) => String(n),
  );
  return lines
    .find((l) => l.startsWith("doctorReport.summaryTrend"))
    ?.split("|")[1];
}

describe("clinical summary trend arrow", () => {
  it("reads pulse by day, not by reading count", () => {
    expect(arrowFor("PULSE")).toBe("↑");
  });

  it("keeps the reading halves for every other type", () => {
    expect(arrowFor("WEIGHT")).toBe("→");
  });
});
