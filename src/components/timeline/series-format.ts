/**
 * How a value line's number reads (v1.42, #613). The server sends each
 * series in its stored, canonical unit (minutes for sleep, kilograms for
 * weight); the person's unit preference and the duration spelling are
 * applied here, through the same formatter the day view uses
 * (`useSeriesValueFormat`), so a night reads "9 h 16 min" on both pages.
 */
import type { TimelineBucket, TimelineResponse } from "@/lib/day/contract";
import type { Formatters } from "@/lib/format-locale";

import { addMonths, bucketAfter, bucketStart } from "./timeline-dates";

/** How one series value reads: the number, and the unit beside it. */
export interface SeriesValueFormat {
  /** "82,6", "129", or a duration that carries its own unit ("9 h 16 min"). */
  number: (key: string, value: number, unit: string | null) => string;
  /** The unit beside the number, or "" when the number carries its own. */
  unit: (key: string, unit: string | null) => string;
}

/**
 * The format for a series without a measurement type behind it (mood, a
 * score without a unit): one decimal, no unit.
 */
export function plainSeriesFormat(
  fmt: Pick<Formatters, "number">,
): SeriesValueFormat {
  return {
    number: (_key, value) => fmt.number(value, 1),
    unit: (_key, unit) => unit ?? "",
  };
}

/** "129 mmHg", "82,6 kg", "9 h 16 min". */
export function formatSeriesValue(
  key: string,
  value: number,
  unit: string | null,
  format: SeriesValueFormat,
): string {
  const number = format.number(key, value, unit);
  const shown = format.unit(key, unit);
  return shown ? `${number} ${shown}` : number;
}

/** One series in one bucket: its mean, or nothing when it has no reading. */
export interface BucketValue {
  key: string;
  unit: string | null;
  mean: number | null;
  count: number | null;
}

/**
 * Every series in the bucket that holds `date`. A series without a reading
 * in that bucket is listed with `mean: null`: the gap stays a gap.
 */
export function bucketValues(
  series: TimelineResponse["series"],
  bucket: TimelineBucket,
  date: string,
): { start: string; values: BucketValue[] } {
  const start = bucketStart(date, bucket);
  return {
    start,
    values: series.map((s) => {
      const point = s.points.find((p) => p.t === start);
      return {
        key: s.key,
        unit: s.unit,
        mean: point?.mean ?? null,
        count: point?.count ?? null,
      };
    }),
  };
}

/**
 * The bucket means each chronicle month shows (`months` newest first, as the
 * chronicle lists them). A bucket is named once, at the newest listed month
 * it overlaps: a quarter rides on its latest month with entries, never on
 * all three. Where two buckets of one series meet at one month (weeks), the
 * newer stands. Only buckets with a reading appear; a month without one
 * shows nothing rather than a number.
 */
export function chronicleMeans(
  series: TimelineResponse["series"],
  bucket: TimelineBucket,
  months: readonly string[],
): Map<string, { start: string; values: BucketValue[] }> {
  const out = new Map<string, { start: string; values: BucketValue[] }>();
  for (const s of series) {
    const points = [...s.points].sort((a, b) => (a.t < b.t ? 1 : -1));
    const taken = new Set<string>();
    for (const p of points) {
      const end = bucketAfter(p.t, bucket);
      const month = months.find(
        (m) => m < end && addMonths(m, 1) > p.t && !taken.has(m),
      );
      if (!month) continue;
      taken.add(month);
      const slot = out.get(month) ?? { start: p.t, values: [] };
      if (p.t > slot.start) slot.start = p.t;
      slot.values.push({
        key: s.key,
        unit: s.unit,
        mean: p.mean,
        count: p.count,
      });
      out.set(month, slot);
    }
  }
  return out;
}

/** Systolic over diastolic, one unit: "129/82 mmHg". */
function pressure(
  sys: BucketValue,
  dia: BucketValue,
  format: SeriesValueFormat,
): string {
  const unit = format.unit(sys.key, sys.unit);
  return `${format.number(sys.key, sys.mean!, sys.unit)}/${format.number(dia.key, dia.mean!, dia.unit)}${unit ? ` ${unit}` : ""}`;
}

/** One value of a means line, with the series whose colour marks it. */
export interface MeanPart {
  key: string;
  text: string;
}

/**
 * The means of one bucket for a glance: systolic and diastolic fold into
 * "129/82 mmHg" (marked as systolic), the rest follow as "82,6 kg". Series
 * without a value are left out; the selection bar names the gaps.
 */
export function meanParts(
  means: readonly BucketValue[],
  format: SeriesValueFormat,
): MeanPart[] {
  const present = means.filter(
    (m): m is BucketValue & { mean: number } => m.mean !== null,
  );
  const sys = present.find((m) => m.key === "BLOOD_PRESSURE_SYS");
  const dia = present.find((m) => m.key === "BLOOD_PRESSURE_DIA");
  const parts: MeanPart[] = [];
  for (const m of present) {
    if (sys && dia && m.key === "BLOOD_PRESSURE_DIA") continue;
    if (sys && dia && m.key === "BLOOD_PRESSURE_SYS") {
      parts.push({
        key: m.key,
        text: pressure(sys, dia, format),
      });
      continue;
    }
    parts.push({
      key: m.key,
      text: formatSeriesValue(m.key, m.mean, m.unit, format),
    });
  }
  return parts;
}

/**
 * The means of one bucket with their names, readings and gaps, for the
 * selection bar: "Blood pressure 129/82 mmHg (mean of 4 readings)", then
 * "Weight no value". Systolic and diastolic fold when both have a value.
 */
export function labelledMeanParts(
  means: readonly BucketValue[],
  format: SeriesValueFormat,
  words: {
    label: (key: string) => string;
    bloodPressure: string;
    noValue: string;
    readings: (count: number) => string;
  },
): MeanPart[] {
  const sys = means.find(
    (m) => m.key === "BLOOD_PRESSURE_SYS" && m.mean !== null,
  );
  const dia = means.find(
    (m) => m.key === "BLOOD_PRESSURE_DIA" && m.mean !== null,
  );
  const fold = sys && dia;
  const parts: MeanPart[] = [];
  for (const m of means) {
    if (fold && m.key === "BLOOD_PRESSURE_DIA") continue;
    if (fold && m.key === "BLOOD_PRESSURE_SYS") {
      parts.push({
        key: m.key,
        text: `${words.bloodPressure} ${pressure(sys, dia!, format)} (${words.readings(sys.count ?? 0)})`,
      });
      continue;
    }
    parts.push({
      key: m.key,
      text:
        m.mean === null
          ? `${words.label(m.key)} ${words.noValue}`
          : `${words.label(m.key)} ${formatSeriesValue(m.key, m.mean, m.unit, format)} (${words.readings(m.count ?? 0)})`,
    });
  }
  return parts;
}
