/**
 * The plain-text citation sentences `fetch` returns as `text`: short,
 * human-readable lines built only from figures the server-authoritative
 * result carried.
 */
import { fenceUserText } from "@/lib/ai/coach/data-fence";
import type { NutrientsDailyResult } from "@/lib/mcp/nutrients-read";
import type { NutrientUpperLimit } from "@/lib/nutrients/catalog";

/** Finite-number guard for the citation summarisers. */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Render a `fetch` result for a metric id as a short, human-readable citation
 * sentence (NOT a JSON blob). Pulls the recent aggregate + the grounding band
 * out of the server-authoritative result; falls back to a plain factual line
 * when a field is absent. Never fabricates a number the result did not carry.
 */
export function plainMetricText(rid: string, result: unknown): string {
  const r = result as {
    present?: boolean;
    data?: { section?: Record<string, unknown> } & Record<string, unknown>;
    grounding?: string;
  };
  if (!r?.present) return `No recent ${rid} data is on file.`;
  const section = (r.data?.section ?? r.data) as
    Record<string, unknown> | undefined;
  const agg = section?.aggregate as Record<string, unknown> | undefined;
  const parts: string[] = [];
  const mean = num(agg?.mean);
  const count = num(agg?.count);
  if (mean !== null) parts.push(`recent mean ${round1(mean)}`);
  if (count !== null) parts.push(`${count} readings`);
  const head =
    parts.length > 0
      ? `${rid}: ${parts.join(", ")}.`
      : `${rid}: data is available for the recent window.`;
  return [head, typeof r.grounding === "string" ? r.grounding : ""]
    .filter(Boolean)
    .join(" ");
}

/**
 * Render a `fetch` result for a lab analyte id as a short citation sentence,
 * quoting the latest reading's value/unit/status/date verbatim from the
 * server-authoritative result.
 */
export function plainLabText(rid: string, result: unknown): string {
  const r = result as {
    present?: boolean;
    data?: { recent?: Array<Record<string, unknown>> };
  };
  if (!r?.present) return `No lab result for ${rid} is on file.`;
  const reading = Array.isArray(r.data?.recent) ? r.data!.recent[0] : undefined;
  if (!reading) return `${rid}: a reading is on file.`;
  const analyte = typeof reading.analyte === "string" ? reading.analyte : rid;
  const value =
    reading.value != null
      ? String(reading.value)
      : typeof reading.valueText === "string"
        ? reading.valueText
        : "—";
  const unit = typeof reading.unit === "string" ? reading.unit : "";
  const status =
    typeof reading.rangeStatus === "string" ? reading.rangeStatus : "";
  const taken =
    typeof reading.takenAt === "string" ? reading.takenAt.slice(0, 10) : "";
  // `analyte`, `unit` and a qualitative `valueText` are free text the server
  // did not author — a lab analyte name is transcribed by a model out of an
  // UPLOADED PDF, so a hostile document chooses it. Fence the sentence so the
  // model reads it as data, and so nothing inside can forge a fence boundary.
  return fenceUserText(
    `${analyte}: ${value}${unit ? ` ${unit}` : ""}` +
      `${status && status !== "unknown" ? ` (${status})` : ""}` +
      `${taken ? `, measured ${taken}` : ""}.`,
  );
}

/**
 * Render a `fetch` result for a v1.25 clinical signal (grip strength, pain NRS,
 * waist circumference, waist-to-height) as a plain-text citation sentence. These
 * sit off the Coach snapshot, so they hydrate through the rollup-backed baseline
 * read (`get_metric_baseline`) rather than the Coach `get_metric_series` path:
 * the latest reading, where it sits against the user's own usual range, and the
 * population reference band. Quotes only values the result carried; never
 * fabricates a figure or asserts a clinical verdict.
 */
export function plainClinicalText(
  label: string,
  result: {
    present?: boolean;
    reason?: string;
    unit?: string;
    latest?: number;
    placement?: "within" | "above" | "below";
    baseline?: { low: number; high: number };
    referenceBand?: { low: number; high: number } | null;
  },
): string {
  const unit = result.unit ? ` ${result.unit}` : "";
  const band = result.referenceBand
    ? ` Reference band ${result.referenceBand.low}–${result.referenceBand.high}${unit}.`
    : "";
  if (!result.present) {
    if (result.reason === "insufficient_history") {
      return `${label}: still learning your usual range — too little history yet.${band}`;
    }
    return `No recent ${label.toLowerCase()} data is on file.`;
  }
  const parts: string[] = [];
  if (typeof result.latest === "number") {
    parts.push(`latest ${round1(result.latest)}${unit}`);
  }
  if (result.placement && result.baseline) {
    parts.push(
      `${result.placement} your usual ${round1(result.baseline.low)}–${round1(
        result.baseline.high,
      )}${unit}`,
    );
  }
  const head =
    parts.length > 0
      ? `${label}: ${parts.join(", ")}.`
      : `${label}: a reading is on file.`;
  return `${head}${band}`.trim();
}

/** What the EFSA level covers where it is narrower than the nutrient. */
const UPPER_LIMIT_FORM_NOTE: Record<
  NonNullable<NutrientUpperLimit["form"]>,
  string
> = {
  retinol:
    " (preformed vitamin A, retinol, only; beta-carotene does not count toward it)",
  folic_acid: " (folic acid from supplements and fortified foods)",
  magnesium_salts: " (readily dissociable magnesium salts in supplements)",
  alpha_tocopherol: " (alpha-tocopherol)",
};

/**
 * Render a `fetch` result for a nutrient code as a plain-text citation
 * sentence: the most recent non-zero day's total plus the resolved EFSA
 * reference (target vs upper-guidance ceiling), quoting only values the
 * result carried. Never fabricates a figure.
 */
export function plainNutrientText(
  label: string,
  result: NutrientsDailyResult,
): string {
  if (!result.present) {
    return result.reason === "module_disabled"
      ? `${label}: nutrient tracking is turned off for this account.`
      : `No recent ${label.toLowerCase()} data is on file.`;
  }
  const unit = result.unit ? ` ${result.unit}` : "";
  const latestDay = [...(result.days ?? [])]
    .reverse()
    .find((d) => d.amount > 0);
  const parts: string[] = [];
  if (latestDay) {
    parts.push(
      `most recent logged day ${latestDay.day}: ${round1(latestDay.amount)}${unit}`,
    );
  }
  const ref = result.reference;
  if (ref) {
    const verb =
      ref.direction === "upperGuidance" ? "guidance ceiling" : "target";
    parts.push(`EFSA ${verb} ${round1(ref.value)}${unit}`);
  }
  // The upper-limit verdict is the server's, read off the day.
  const limit = result.upperLimit;
  if (limit && latestDay?.aboveUpperLimit) {
    const share =
      limit.scope === "supplemental" ? " for the supplement share" : "";
    const form = limit.form ? UPPER_LIMIT_FORM_NOTE[limit.form] : "";
    parts.push(
      `that day is above the EFSA upper intake level of ${round1(limit.value)}${unit}${share}${form}`,
    );
  }
  return parts.length > 0
    ? `${label}: ${parts.join(", ")}.`
    : `${label}: data is on file for the recent window.`;
}
