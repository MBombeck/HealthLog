/**
 * How a value line's number reads (v1.42, #613): whole numbers for pressure,
 * pulse and counts, one decimal for the rest, sleep in hours. The unit is the
 * server's, already in the person's display unit.
 */
import type { TimelineBucket, TimelineResponse } from "@/lib/day/contract";
import type { Formatters } from "@/lib/format-locale";

import { addMonths, bucketAfter, bucketStart } from "./timeline-dates";

const WHOLE_NUMBER_KEYS: ReadonlySet<string> = new Set([
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "RESTING_HEART_RATE",
  "HEART_RATE_VARIABILITY",
  "ACTIVITY_STEPS",
]);

export function formatSeriesNumber(
  key: string,
  value: number,
  unit: string | null,
  fmt: Pick<Formatters, "number">,
): { value: string; unit: string | null } {
  if (key === "SLEEP_DURATION" && unit === "min") {
    return { value: fmt.number(value / 60, 1), unit: "h" };
  }
  // Glucose arrives in the person's display unit: whole numbers in the
  // hundreds, one decimal for single digits.
  const digits =
    WHOLE_NUMBER_KEYS.has(key) || (key === "BLOOD_GLUCOSE" && value >= 30)
      ? 0
      : 1;
  return { value: fmt.number(value, digits), unit };
}

/** "129 mmHg", "82,6 kg", "7,4 h". */
export function formatSeriesValue(
  key: string,
  value: number,
  unit: string | null,
  fmt: Pick<Formatters, "number">,
): string {
  const out = formatSeriesNumber(key, value, unit, fmt);
  return out.unit ? `${out.value} ${out.unit}` : out.value;
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

/**
 * The means in one short line: systolic and diastolic fold into
 * "129/82 mmHg", the rest follow as "82,6 kg". Series without a value are
 * left out; the line is for a glance, the selection bar names the gaps.
 */
export function formatMeans(
  means: readonly BucketValue[],
  fmt: Pick<Formatters, "number">,
): string {
  const present = means.filter(
    (m): m is BucketValue & { mean: number } => m.mean !== null,
  );
  const sys = present.find((m) => m.key === "BLOOD_PRESSURE_SYS");
  const dia = present.find((m) => m.key === "BLOOD_PRESSURE_DIA");
  const parts: string[] = [];
  for (const m of present) {
    if (sys && dia && m.key === "BLOOD_PRESSURE_DIA") continue;
    if (sys && dia && m.key === "BLOOD_PRESSURE_SYS") {
      parts.push(
        `${fmt.number(sys.mean, 0)}/${fmt.number(dia.mean, 0)}${sys.unit ? ` ${sys.unit}` : ""}`,
      );
      continue;
    }
    parts.push(formatSeriesValue(m.key, m.mean, m.unit, fmt));
  }
  return parts.join(" · ");
}

/**
 * The means of one bucket with their names, readings and gaps, for the
 * selection bar: "Blood pressure 129/82 mmHg (mean of 4 readings) · Weight
 * no value". Systolic and diastolic fold when both have a value.
 */
export function formatLabelledMeans(
  means: readonly BucketValue[],
  fmt: Pick<Formatters, "number">,
  words: {
    label: (key: string) => string;
    bloodPressure: string;
    noValue: string;
    readings: (count: number) => string;
  },
): string {
  const sys = means.find(
    (m) => m.key === "BLOOD_PRESSURE_SYS" && m.mean !== null,
  );
  const dia = means.find(
    (m) => m.key === "BLOOD_PRESSURE_DIA" && m.mean !== null,
  );
  const fold = sys && dia;
  const parts: string[] = [];
  for (const m of means) {
    if (fold && m.key === "BLOOD_PRESSURE_DIA") continue;
    if (fold && m.key === "BLOOD_PRESSURE_SYS") {
      parts.push(
        `${words.bloodPressure} ${fmt.number(sys.mean!, 0)}/${fmt.number(dia.mean!, 0)}${sys.unit ? ` ${sys.unit}` : ""} (${words.readings(sys.count ?? 0)})`,
      );
      continue;
    }
    parts.push(
      m.mean === null
        ? `${words.label(m.key)} ${words.noValue}`
        : `${words.label(m.key)} ${formatSeriesValue(m.key, m.mean, m.unit, fmt)} (${words.readings(m.count ?? 0)})`,
    );
  }
  return parts.join(" · ");
}
