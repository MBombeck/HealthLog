/**
 * How a value line's number reads (v1.42, #613): whole numbers for pressure,
 * pulse and counts, one decimal for the rest, sleep in hours. The unit is the
 * server's, already in the person's display unit.
 */
import type { Formatters } from "@/lib/format-locale";

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

/**
 * The month means in one short line: systolic and diastolic fold into
 * "129/82 mmHg", the rest follow as "82,6 kg".
 */
export function formatMonthMeans(
  means: ReadonlyArray<{ key: string; mean: number; unit: string | null }>,
  fmt: Pick<Formatters, "number">,
): string {
  const sys = means.find((m) => m.key === "BLOOD_PRESSURE_SYS");
  const dia = means.find((m) => m.key === "BLOOD_PRESSURE_DIA");
  const parts: string[] = [];
  for (const m of means) {
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
