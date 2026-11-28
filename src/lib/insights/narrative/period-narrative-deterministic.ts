/**
 * v1.12.12 — deterministic, non-AI period-narrative fallback (iOS H2).
 *
 * The period-retrospective card depends on a generated narrative row. For an
 * account with no usable AI provider (or before the first AI warm completes)
 * that row never appears and the card stays empty. This module composes a
 * short, factual, strictly NON-CAUSAL summary from the SAME structured
 * `PeriodNarrativeContext` the AI prompt is built from — no provider call —
 * so the card is never empty for an active account (and the no-key demo
 * fills too).
 *
 * Persisted with `providerType = "deterministic"` so a later AI warm replaces
 * it in place; the read route is unchanged (same envelope, same prose field).
 *
 * Pure + locale-bound (narratives are de/en only). Metric labels come from a
 * self-contained bilingual map — no dependency on message-bundle key coverage
 * — with a prettified-enum fallback for any unmapped type, so a newly added
 * measurement type degrades gracefully instead of leaking an enum constant.
 */
import type { PeriodNarrativeContext, MetricDelta } from "./period-narrative";
import { NBSP } from "@/lib/format/unit-join";

/** Marker stored in `InsightNarrative.providerType` for a fallback row. */
export const DETERMINISTIC_PROVIDER_TYPE = "deterministic" as const;

type Locale = "de" | "en";

/** Bilingual labels for the metric types that surface in a narrative. */
const METRIC_LABELS: Record<string, { de: string; en: string }> = {
  WEIGHT: { de: "dein Gewicht", en: "your weight" },
  BLOOD_PRESSURE_SYS: {
    de: "dein systolischer Blutdruck",
    en: "your systolic blood pressure",
  },
  BLOOD_PRESSURE_DIA: {
    de: "dein diastolischer Blutdruck",
    en: "your diastolic blood pressure",
  },
  PULSE: { de: "dein Puls", en: "your pulse" },
  RESTING_HEART_RATE: { de: "dein Ruhepuls", en: "your resting heart rate" },
  HEART_RATE_VARIABILITY: {
    de: "deine Herzfrequenzvariabilität",
    en: "your heart-rate variability",
  },
  RESPIRATORY_RATE: { de: "deine Atemfrequenz", en: "your respiratory rate" },
  OXYGEN_SATURATION: {
    de: "deine Sauerstoffsättigung",
    en: "your oxygen saturation",
  },
  BODY_FAT: { de: "dein Körperfettanteil", en: "your body fat" },
  MUSCLE_MASS: { de: "deine Muskelmasse", en: "your muscle mass" },
  TOTAL_BODY_WATER: {
    de: "dein Körperwasser",
    en: "your total body water",
  },
  BONE_MASS: { de: "deine Knochenmasse", en: "your bone mass" },
  BMI: { de: "dein BMI", en: "your BMI" },
  SLEEP_DURATION: { de: "deine Schlafdauer", en: "your sleep duration" },
  ACTIVITY_STEPS: { de: "deine Schritte", en: "your step count" },
  ACTIVE_ENERGY: { de: "dein Aktivitätsumsatz", en: "your active energy" },
  BLOOD_GLUCOSE: { de: "dein Blutzucker", en: "your blood glucose" },
  VO2MAX: { de: "deine VO₂max", en: "your VO₂max" },
  BODY_TEMPERATURE: {
    de: "deine Körpertemperatur",
    en: "your body temperature",
  },
  MOOD: { de: "deine Stimmung", en: "your mood" },
};

/** Prettify an unmapped enum constant: RESTING_HEART_RATE → resting heart rate. */
function prettifyType(type: string, locale: Locale): string {
  const words = type.toLowerCase().replace(/_/g, " ");
  return locale === "de" ? `dein Wert „${words}“` : `your ${words}`;
}

function labelFor(type: string, locale: Locale): string {
  return METRIC_LABELS[type]?.[locale] ?? prettifyType(type, locale);
}

/**
 * Fraction digits a change is written with. A step count, a blood pressure, a
 * heart rate, a heart-rate variability and a breathing rate are whole numbers
 * on every screen; weight, body fat, sleep hours, glucose and anything else
 * carry one decimal, in whichever unit the reader chose.
 */
const WHOLE_NUMBER_TYPES = new Set<string>([
  "ACTIVITY_STEPS",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "RESTING_HEART_RATE",
  "HEART_RATE_VARIABILITY",
  "RESPIRATORY_RATE",
]);

function fractionDigitsFor(type: string): number {
  return WHOLE_NUMBER_TYPES.has(type) ? 0 : 1;
}

/**
 * A signed number in the reader's notation: decimal mark and digit grouping
 * of the locale, a typographic minus, `digits` fraction digits at most.
 */
function fmtSigned(n: number, locale: Locale, digits: number): string {
  const factor = 10 ** digits;
  const rounded = Math.round(Math.abs(n) * factor) / factor;
  const sign = rounded === 0 ? "±" : n > 0 ? "+" : "−"; // U+2212 minus
  const body = new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-US", {
    maximumFractionDigits: digits,
  }).format(rounded);
  return `${sign}${body}`;
}

/** A step count has no unit symbol; the narrative names it. */
const STEP_WORD: Record<Locale, string> = { de: "Schritte", en: "steps" };

/** A percent sign the way the language sets it: "8,2 %" and "8.2%". */
function fmtPercent(n: number, locale: Locale): string {
  const figure = fmtSigned(n, locale, 1);
  return locale === "de" ? `${figure}${NBSP}%` : `${figure}%`;
}

/**
 * A delta is "notable" when it has a computable change that survives the
 * rounding it is written with: "+0 mmHg" is no change to report.
 */
function isNotable(d: MetricDelta): boolean {
  if (d.delta === null) return false;
  const factor = 10 ** fractionDigitsFor(d.type);
  return Math.round(Math.abs(d.delta) * factor) !== 0;
}

/** Rank notable deltas by relative magnitude (percent), falling back to abs. */
function rankDeltas(deltas: MetricDelta[]): MetricDelta[] {
  return deltas
    .filter(isNotable)
    .slice()
    .sort((a, b) => {
      const ap = a.deltaPercent !== null ? Math.abs(a.deltaPercent) : null;
      const bp = b.deltaPercent !== null ? Math.abs(b.deltaPercent) : null;
      if (ap !== null && bp !== null) return bp - ap;
      if (ap !== null) return -1;
      if (bp !== null) return 1;
      return Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0);
    });
}

function deltaPhrase(d: MetricDelta, locale: Locale): string {
  const label = labelFor(d.type, locale);
  const unitWord =
    d.unit === "" && d.type === "ACTIVITY_STEPS" ? STEP_WORD[locale] : d.unit;
  const unit = unitWord ? `${NBSP}${unitWord}` : "";
  const amount = `${fmtSigned(d.delta as number, locale, fractionDigitsFor(d.type))}${unit}`;
  // One bracket: the change and its percent side by side, not nested.
  const pct =
    d.deltaPercent !== null && Math.round(d.deltaPercent * 10) !== 0
      ? `, ${fmtPercent(d.deltaPercent, locale)}`
      : "";
  return `${label} (${amount}${pct})`;
}

/**
 * Compose the deterministic narrative prose. Always returns a non-empty,
 * factual paragraph for a ready context: changes lead, then any vitals that
 * moved out of their typical range, then an honest, non-causal mention of how
 * many statistical associations were noted. Returns the "held steady" line
 * when nothing moved.
 */
export function buildDeterministicNarrative(
  context: PeriodNarrativeContext,
  locale: Locale,
): string {
  const periodLabel =
    context.period === "week"
      ? locale === "de"
        ? "der letzten Woche"
        : "the last week"
      : locale === "de"
        ? "dem letzten Monat"
        : "the last month";

  const sentences: string[] = [];

  const ranked = rankDeltas(context.metricDeltas).slice(0, 3);

  // v1.28.40 — verdict-first: open on a one-line read of the period before the
  // delta list, so the deterministic floor leads with meaning like the warm AI
  // narrative beside it. No number is introduced — the movers and their figures
  // follow in the next sentence.
  const periodWordEn = context.period === "week" ? "week" : "month";
  if (ranked.length > 0) {
    sentences.push(
      locale === "de"
        ? context.period === "week"
          ? "Eine Woche mit echter Bewegung."
          : "Ein Monat mit echter Bewegung."
        : `A ${periodWordEn} of real movement.`,
    );
  } else {
    sentences.push(
      locale === "de"
        ? context.period === "week"
          ? "Eine ruhige Woche."
          : "Ein ruhiger Monat."
        : `A calm ${periodWordEn}.`,
    );
  }

  if (ranked.length > 0) {
    const phrases = ranked.map((d) => deltaPhrase(d, locale));
    const joined =
      locale === "de" ? joinList(phrases, "und") : joinList(phrases, "and");
    sentences.push(
      locale === "de"
        ? `In ${periodLabel} hat sich am deutlichsten verändert: ${joined}, jeweils im Vergleich zum vorherigen Zeitraum.`
        : `Over ${periodLabel}, the clearest changes were ${joined}, each compared with the prior period.`,
    );
  } else {
    sentences.push(
      locale === "de"
        ? `In ${periodLabel} sind deine erfassten Werte weitgehend stabil geblieben.`
        : `Over ${periodLabel}, your tracked metrics held largely steady.`,
    );
  }

  const movedOut = context.bandTransitions.filter((b) => b.movedOut);
  if (movedOut.length > 0) {
    const parts = movedOut.map((b) => {
      const label = labelFor(b.type, locale);
      const where =
        b.direction === "above"
          ? locale === "de"
            ? "über"
            : "above"
          : locale === "de"
            ? "unter"
            : "below";
      return locale === "de"
        ? `${label} lag ${where} deinem üblichen Bereich`
        : `${label} sat ${where} your typical range`;
    });
    const joined =
      locale === "de" ? joinList(parts, "und") : joinList(parts, "and");
    sentences.push(capitaliseFirst(`${joined}.`));
  }

  if (context.drivers.length > 0) {
    const n = context.drivers.length;
    sentences.push(
      locale === "de"
        ? `Außerdem ${n === 1 ? "wurde 1 statistischer Zusammenhang" : `wurden ${n} statistische Zusammenhänge`} festgestellt — rein beschreibend, nicht ursächlich.`
        : `${n === 1 ? "1 statistical association was" : `${n} statistical associations were`} also noted — descriptive only, not causal.`,
    );
  }

  return sentences.join(" ");
}

/** Join a list with commas and a final conjunction, locale-agnostic glue. */
function joinList(items: string[], conjunction: string): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

function capitaliseFirst(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
