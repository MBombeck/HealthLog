/**
 * v1.13.2 — per-derived-SCORE assessment text ("why is this score what it is").
 *
 * iOS asks for a short "Einschätzung" on each derived-score detail sheet
 * (READINESS, SLEEP_SCORE, RECOVERY_SCORE, STRAIN_SCORE, STRESS_SCORE)
 * explaining WHY the score sits where it does, referencing the score's
 * own contributors. The contract (LOCKED with iOS) is an additive,
 * non-breaking field on `GET /api/insights/derived`:
 *
 *   assessment: { text, source, updatedAt } | null
 *
 * null whenever the metric `status !== "ok"`; otherwise always a non-empty
 * `text` (so a provider-less account and the demo always get one). The
 * shape follows the v1.12.12 deterministic-narrative model: a deterministic
 * fallback composed from the SAME structured signal the model would read —
 * never empty — PLUS warmer AI prose when a provider is configured + warm.
 *
 * `source` is `"deterministic"` for the template text, or the provider type
 * (`"openai"`, `"anthropic"`, …) when a cached AI assessment is served.
 *
 * Pure prose lives here; the AI-warm read + enqueue is a thin layer over the
 * existing status cache (the same `auditLog` row pattern the per-metric cards
 * use), keyed `insights.derived-score:<ID>-status.<locale>`. de/en only — the
 * narratives, like the period narrative, are bilingual by design.
 */
import {
  buildMetricSignal,
  type MetricSignal,
} from "@/lib/insights/metric-signal";
import type { GradedSeries } from "@/lib/insights/graded-series";
import type { ReadinessValue, ReadinessComponentKey } from "./readiness";
import type { SleepScoreValue, SleepSubScoreKey } from "./sleep-score";
import type { WellnessScoreValue } from "./wellness-scores";
import type { Derived } from "./types";
import type { DerivedMetricId } from "./registry";

type Locale = "de" | "en";

/** The additive per-score assessment field on the derived response. */
export interface DerivedAssessment {
  /** Non-empty short explanation of why the score is what it is. */
  text: string;
  /** "deterministic" for the template, or the provider type for AI prose. */
  source: string;
  /** ISO timestamp the text was produced / last warmed. */
  updatedAt: string;
}

/**
 * The derived-score ids that carry a per-score assessment. These are the
 * five iOS requests; the assessment is keyed to the SAME id the caller
 * passed (so READINESS → assessment on READINESS, etc.). Any other derived
 * id returns no assessment (the field stays null / absent).
 */
export const ASSESSABLE_DERIVED_SCORES: ReadonlySet<DerivedMetricId> = new Set([
  "READINESS",
  "SLEEP_SCORE",
  "RECOVERY_SCORE",
  "STRAIN_SCORE",
  "STRESS_SCORE",
]);

/** `true` when the id is one iOS requests a per-score assessment for. */
export function isAssessableDerivedScore(metric: DerivedMetricId): boolean {
  return ASSESSABLE_DERIVED_SCORES.has(metric);
}

// ── bilingual labels ────────────────────────────────────────────────────

/** Display label for each assessable score. */
const SCORE_LABELS: Record<string, { de: string; en: string }> = {
  READINESS: { de: "deine Tagesform", en: "your readiness" },
  SLEEP_SCORE: { de: "dein Schlafscore", en: "your sleep score" },
  RECOVERY_SCORE: { de: "deine Erholung", en: "your recovery" },
  STRAIN_SCORE: { de: "deine Belastung", en: "your strain" },
  STRESS_SCORE: { de: "dein Stress", en: "your stress" },
};

/** Readiness contributor labels (its `components[].key`). */
const READINESS_COMPONENT_LABELS: Record<
  ReadinessComponentKey,
  { de: string; en: string }
> = {
  rhr: { de: "dein Ruhepuls", en: "your resting heart rate" },
  hrv: {
    de: "deine Herzfrequenzvariabilität",
    en: "your heart-rate variability",
  },
  sleep: { de: "dein Schlaf", en: "your sleep" },
  respiratory: { de: "deine Atemfrequenz", en: "your respiratory rate" },
  mood: { de: "deine Stimmung", en: "your mood" },
};

/** Sleep sub-score labels (its `subScores[].key`). */
const SLEEP_SUBSCORE_LABELS: Record<
  SleepSubScoreKey,
  { de: string; en: string }
> = {
  sufficiency: { de: "die Schlafmenge", en: "sleep duration" },
  efficiency: { de: "die Schlafeffizienz", en: "sleep efficiency" },
  consistency: { de: "die Regelmäßigkeit", en: "sleep consistency" },
  timing: { de: "der Schlafrhythmus", en: "sleep timing" },
  composition: { de: "die Schlafphasen", en: "sleep composition" },
};

function scoreLabel(metric: string, locale: Locale): string {
  return (
    SCORE_LABELS[metric]?.[locale] ??
    (locale === "de" ? "dein Wert" : "your score")
  );
}

/**
 * Band → bilingual standing phrase. Stress and strain are banded on
 * `100 - score` (a heavy day is red), so their phrase names the load: a red
 * stress is "high", never "on the low side".
 */
function bandPhrase(
  band: "green" | "yellow" | "red",
  locale: Locale,
  metric?: DerivedMetricId,
): string {
  if (metric === "STRESS_SCORE" || metric === "STRAIN_SCORE") {
    const de = { green: "niedrig", yellow: "mittel", red: "hoch" } as const;
    const en = { green: "low", yellow: "moderate", red: "high" } as const;
    return locale === "de" ? de[band] : en[band];
  }
  if (locale === "de") {
    return band === "green"
      ? "im guten Bereich"
      : band === "yellow"
        ? "im mittleren Bereich"
        : "im niedrigen Bereich";
  }
  return band === "green"
    ? "in a good place"
    : band === "yellow"
      ? "in the middle"
      : "on the low side";
}

// ── signal builders per score ─────────────────────────────────────────────

/**
 * Build a one-day graded series from a single score value so a derived
 * score (which carries no raw bucket series) can flow through the SAME
 * `buildMetricSignal` contract every other surface uses. The recent slice
 * holds today's score; an optional trend baseline (score − trendDelta)
 * becomes a one-point monthly slice so the signal carries a signed delta.
 */
function singlePointGraded(
  score: number,
  baseline: number | null,
): GradedSeries {
  return {
    recent: [{ date: "today", min: score, max: score, mean: score, n: 1 }],
    weekly: [],
    monthly:
      baseline !== null
        ? [
            {
              month: "baseline",
              min: baseline,
              max: baseline,
              mean: baseline,
              n: 1,
            },
          ]
        : [],
    yearly: [],
  };
}

/** Map a derived OK value for one assessable score to its `MetricSignal`. */
export function buildScoreSignal(
  metric: DerivedMetricId,
  value: unknown,
  locale: Locale,
): MetricSignal | null {
  const label = scoreLabel(metric, locale);
  if (metric === "READINESS") {
    const v = value as ReadinessValue;
    const signal = buildMetricSignal({
      metric: label,
      direction: "higher-better",
      graded: singlePointGraded(v.score, null),
    });
    if (!signal) return null;
    signal.contributors = v.components.map((c) => ({
      key: c.key,
      value: c.value,
      weight: c.weight,
    }));
    return signal;
  }
  if (metric === "SLEEP_SCORE") {
    const v = value as SleepScoreValue;
    const signal = buildMetricSignal({
      metric: label,
      direction: "higher-better",
      graded: singlePointGraded(v.score, null),
    });
    if (!signal) return null;
    signal.contributors = v.subScores.map((s) => ({
      key: s.key,
      value: s.value,
      weight: s.weight,
    }));
    return signal;
  }
  // RECOVERY / STRESS / STRAIN — a persisted composite with a trend delta but
  // no component breakdown. The trend baseline (score − trendDelta) gives a
  // signed delta; direction follows the metric (recovery higher-better,
  // stress/strain lower-better).
  const v = value as WellnessScoreValue;
  const baseline = v.trendDelta !== null ? v.score - v.trendDelta : null;
  const direction =
    metric === "RECOVERY_SCORE" ? "higher-better" : "lower-better";
  return buildMetricSignal({
    metric: label,
    direction,
    graded: singlePointGraded(v.score, baseline),
  });
}

// ── deterministic prose ────────────────────────────────────────────────────

/** Format a signed integer with the typographic minus glyph. */
function fmtSignedInt(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "±";
  return `${sign}${Math.abs(Math.round(n))}`;
}

/** Rank present contributors by how far they sit from a full 100 (impact). */
function rankContributors(
  signal: MetricSignal,
): { key: string; value: number }[] {
  return (signal.contributors ?? [])
    .filter(
      (c): c is { key: string; value: number; weight: number } =>
        c.value !== null,
    )
    .map((c) => ({ key: c.key, value: c.value, weight: c.weight }))
    .sort((a, b) => a.value - b.value);
}

function contributorLabel(
  metric: DerivedMetricId,
  key: string,
  locale: Locale,
): string {
  if (metric === "READINESS") {
    return (
      READINESS_COMPONENT_LABELS[key as ReadinessComponentKey]?.[locale] ?? key
    );
  }
  if (metric === "SLEEP_SCORE") {
    return SLEEP_SUBSCORE_LABELS[key as SleepSubScoreKey]?.[locale] ?? key;
  }
  return key;
}

/**
 * v1.21.0 (coach C1 MEDIUM-2) — a single grounded next-step pointer keyed to
 * the weakest BEHAVIOURALLY ADDRESSABLE contributor. Only the contributors a
 * person can actually move (sleep, mood, consistency, timing) carry a
 * pointer; physiology-only contributors (rhr, hrv, respiratory) return null,
 * so the assessment affirms-and-watches rather than manufacturing a step —
 * matching the `base-system.ts` "do NOT manufacture a step" rule.
 */
const CONTRIBUTOR_POINTERS: Record<string, { de: string; en: string }> = {
  sleep: {
    de: "Eine etwas frühere Nacht würde das am ehesten anheben.",
    en: "An earlier night would lift this most.",
  },
  sufficiency: {
    de: "Etwas mehr Schlafzeit ist hier der wirksamste Hebel.",
    en: "A little more time asleep is the most effective lever here.",
  },
  consistency: {
    de: "Gleichmäßigere Schlafzeiten über die Woche helfen am meisten.",
    en: "More even sleep and wake times across the week help most.",
  },
  timing: {
    de: "Ein gleichmäßigerer Rhythmus zieht das am ehesten nach oben.",
    en: "A steadier sleep rhythm is the most likely thing to pull this up.",
  },
  mood: {
    de: "Ein kurzer Moment für etwas, das dir guttut, kann hier spürbar helfen.",
    en: "A small moment for something that does you good can noticeably help here.",
  },
};

function contributorPointer(key: string, locale: Locale): string | null {
  return CONTRIBUTOR_POINTERS[key]?.[locale] ?? null;
}

/**
 * v1.22 — band → "what it means for today" interpretation. A CLOSED
 * deterministic table (so the read can never hallucinate a verdict) keyed by
 * metric + band, mirroring the WHOOP/Oura forward read: a strong readiness /
 * recovery / sleep score is a day to take on a little more; a soft one is a
 * recovery cue. For strain/stress the bands already encode favourable→green, so
 * green reads as "in a sustainable place" and red as "ease off". This is a
 * band-conditioned interpretation, never a new number, so it carries no figure
 * the score-grounding gate could flag.
 */
const SCORE_BAND_MEANING: Partial<
  Record<
    DerivedMetricId,
    Record<"green" | "yellow" | "red", { de: string; en: string }>
  >
> = {
  READINESS: {
    green: {
      de: "Heute ist ein guter Tag, um etwas mehr zu wagen.",
      en: "Today reads like a good day to take on a little more.",
    },
    yellow: {
      de: "Ein mittlerer Tag — gut für Gewohntes, ohne zu überziehen.",
      en: "A middling day — fine for your usual load without overreaching.",
    },
    red: {
      de: "Ein ruhigerer Tag würde dir guttun — nimm es als Erholungshinweis.",
      en: "A lighter day would serve you — take it as a recovery cue.",
    },
  },
  RECOVERY_SCORE: {
    green: {
      de: "Dein Körper wirkt erholt — Raum, heute etwas mehr zu geben.",
      en: "Your body reads recovered — room to give a little more today.",
    },
    yellow: {
      de: "Teilweise erholt — ein gewohnter Tag passt, kein harter Push.",
      en: "Partly recovered — a normal day fits, nothing too hard.",
    },
    red: {
      de: "Noch nicht erholt — heute eher schonen als pushen.",
      en: "Not yet recovered — favour easing off over pushing today.",
    },
  },
  SLEEP_SCORE: {
    green: {
      de: "Eine Nacht, die dich gut durch den Tag tragen sollte.",
      en: "A night that should carry you well through the day.",
    },
    yellow: {
      de: "Eine durchwachsene Nacht — heute etwas bewusster mit deiner Energie.",
      en: "A mixed night — be a little deliberate with your energy today.",
    },
    red: {
      de: "Eine kurze Nacht — plane heute bewusst Erholung ein.",
      en: "A short night — build a little recovery into today on purpose.",
    },
  },
  STRAIN_SCORE: {
    green: {
      de: "Deine Belastung liegt in einem gut tragbaren Bereich.",
      en: "Your load is sitting in a comfortably sustainable place.",
    },
    yellow: {
      de: "Eine spürbare Belastung — achte heute auf genug Erholung.",
      en: "A noticeable load — keep an eye on recovery today.",
    },
    red: {
      de: "Eine hohe Belastung — heute zählt Erholung mehr als noch mehr.",
      en: "A high load — recovery matters more than more today.",
    },
  },
  STRESS_SCORE: {
    green: {
      de: "Dein Stress liegt niedrig — eine gute Basis für den Tag.",
      en: "Your stress is sitting low — a good base for the day.",
    },
    yellow: {
      de: "Etwas erhöhter Stress — ein ruhiger Moment kann heute helfen.",
      en: "Slightly raised stress — a calm moment could help today.",
    },
    red: {
      de: "Erhöhter Stress — ein bewusst ruhigerer Tag würde dir guttun.",
      en: "Raised stress — a deliberately calmer day would serve you.",
    },
  },
};

function scoreBandMeaning(
  metric: DerivedMetricId,
  band: "green" | "yellow" | "red",
  locale: Locale,
): string | null {
  return SCORE_BAND_MEANING[metric]?.[band]?.[locale] ?? null;
}

/**
 * Compose the deterministic per-score assessment from the score's signal +
 * its contributors. Always returns a non-empty, factual, non-causal text.
 * Leads with the score + standing, then names the 1–2 lowest contributors
 * (the ones holding the score back) or the trend for the contributor-less
 * scores.
 */
export function buildDeterministicScoreAssessment(
  metric: DerivedMetricId,
  signal: MetricSignal,
  band: "green" | "yellow" | "red",
  locale: Locale,
): string {
  const label = scoreLabel(metric, locale);
  const score = Math.round(signal.current);
  const standing = bandPhrase(band, locale, metric);

  const sentences: string[] = [];

  // v1.28.40 — verdict-first: open with the band → "what it means for today"
  // read (a closed, non-numeric table) BEFORE the score, so the deterministic
  // floor leads with meaning like the warm AI voice, e.g. "A good day to take
  // on a little more — your readiness is 72/100 …". No number is introduced
  // here, so the grounding posture is unchanged.
  const meaning = scoreBandMeaning(metric, band, locale);
  if (meaning) sentences.push(meaning);

  sentences.push(
    locale === "de"
      ? `${capitalise(label)} liegt heute bei ${score} von 100 — ${standing}.`
      : `${capitalise(label)} is ${score} out of 100 today — ${standing}.`,
  );

  const ranked = rankContributors(signal);
  if (ranked.length > 0) {
    // Name the 1–2 weakest contributors (driving the score down) when the
    // score is not maxed; affirm the strongest when it is high.
    if (band === "green") {
      const top = ranked[ranked.length - 1];
      const topLabel = contributorLabel(metric, top.key, locale);
      sentences.push(
        locale === "de"
          ? `Getragen vor allem von ${topLabel}.`
          : `Carried mostly by ${topLabel}.`,
      );
    } else {
      const weak = ranked
        .slice(0, 2)
        .map((c) => contributorLabel(metric, c.key, locale));
      const joined =
        locale === "de" ? joinList(weak, "und") : joinList(weak, "and");
      sentences.push(
        locale === "de"
          ? `Am stärksten gedämpft durch ${joined}.`
          : `Held back most by ${joined}.`,
      );
      // v1.21.0 — close with ONE grounded next step drawn from the
      // weakest contributor, but only when it is behaviourally addressable.
      // When the weakest driver is physiology-only, no step is manufactured.
      const pointer = contributorPointer(ranked[0].key, locale);
      if (pointer) sentences.push(pointer);
    }
  } else if (signal.delta !== null && signal.delta !== 0) {
    // No contributor breakdown (recovery/stress/strain): use the trend.
    const dir =
      signal.delta > 0
        ? locale === "de"
          ? "höher"
          : "higher"
        : locale === "de"
          ? "niedriger"
          : "lower";
    sentences.push(
      locale === "de"
        ? `Das sind ${fmtSignedInt(signal.delta)} Punkte ${dir} als zuletzt.`
        : `That is ${fmtSignedInt(signal.delta)} points ${dir} than your recent average.`,
    );
  } else {
    sentences.push(
      locale === "de"
        ? "Das entspricht deinem üblichen Niveau."
        : "That is in line with your usual level.",
    );
  }

  // v1.28.40 — the band-conditioned "what it means for today" read now OPENS the
  // assessment (above) instead of closing it, so the score card leads with
  // meaning. When no meaning is mapped for this band the card falls back to its
  // standing-first shape, which is already verdict-carrying ("… — in a good
  // place").

  return sentences.join(" ");
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function joinList(items: string[], conjunction: string): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

/**
 * Resolve the assessment field for a derived metric result. Returns null
 * when the metric is not assessable or its status is not `ok` (the locked
 * contract: assessment is null unless status === "ok"). Otherwise always a
 * non-empty deterministic text; a warmer AI text overrides it when one has
 * been cached (see `derived-assessment-ai.ts`).
 */
export function resolveDeterministicAssessment(
  metric: DerivedMetricId,
  derived: Derived<unknown>,
  locale: Locale,
  now: Date,
): DerivedAssessment | null {
  if (!isAssessableDerivedScore(metric)) return null;
  if (derived.status !== "ok") return null;

  const signal = buildScoreSignal(metric, derived.value, locale);
  if (!signal) return null;

  const band = readBand(derived.value);
  const text = buildDeterministicScoreAssessment(metric, signal, band, locale);
  return {
    text,
    source: "deterministic",
    updatedAt: now.toISOString(),
  };
}

/** Read the band off any assessable score value (all carry `band`). */
function readBand(value: unknown): "green" | "yellow" | "red" {
  const b = (value as { band?: unknown }).band;
  return b === "green" || b === "yellow" || b === "red" ? b : "yellow";
}
