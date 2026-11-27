/**
 * The score register: every 0..100 score HealthLog shows, where it is drawn
 * as a ring, and how a device's own score is named and scaled.
 *
 * Two kinds of number share the screen and must never be mistaken for each
 * other:
 *
 *   - HealthLog's own scores (health score, readiness, sleep score, the
 *     computed recovery proxy, the stress and strain estimates). Each has a
 *     slug under `/insights/scores/<slug>` and is banded by the one rule in
 *     `bandForScoreKind`.
 *   - A device's own score (WHOOP Recovery, Oura Readiness, Polar Nightly
 *     Recharge, a vendor sleep score). It is named after the row's source,
 *     shown on the vendor's scale and never gets a HealthLog band.
 *
 * `src/lib/scores/__tests__/score-registry.test.ts` holds the register of
 * every `<ScoreRing>` call site and checks every score slug against the
 * scores here, so a new ring or a new score page cannot appear without a
 * decision about which score it shows.
 */
import type { HealthLogScoreKind } from "@/lib/analytics/score/shared";
import { translateOrNull } from "@/lib/i18n/translate-code";
import { metricName } from "@/lib/measurements/type-label-keys";

/** HealthLog's own scores. */
export const HEALTHLOG_SCORE_IDS = [
  "HEALTH_SCORE",
  "READINESS",
  "SLEEP_SCORE",
  "RECOVERY_SCORE",
  "STRESS_SCORE",
  "STRAIN_SCORE",
] as const;

export type HealthLogScoreId = (typeof HEALTHLOG_SCORE_IDS)[number];

export interface HealthLogScoreEntry {
  /** The band rule's kind (direction included). */
  bandKind: HealthLogScoreKind;
  /** The slug of its page under `/insights/scores/`. */
  slug: string;
  /** The message key of its display name. */
  titleKey: string;
  /**
   * The metric whose glossary short form names it on a tile
   * (`metricName(...).short`); absent when the name is already short.
   */
  shortMetric?: string;
}

export const HEALTHLOG_SCORES: Readonly<
  Record<HealthLogScoreId, HealthLogScoreEntry>
> = {
  HEALTH_SCORE: {
    bandKind: "health",
    slug: "health",
    titleKey: "insights.healthScore.label",
    shortMetric: "HEALTH_SCORE",
  },
  READINESS: {
    bandKind: "readiness",
    slug: "readiness",
    titleKey: "insights.derived.composite.READINESS.title",
  },
  SLEEP_SCORE: {
    bandKind: "sleep",
    slug: "sleep",
    titleKey: "insights.derived.composite.SLEEP_SCORE.title",
  },
  // The computed proxy. Its page redirects (readiness for a proxy account,
  // device scores for a device account); the slug stays reachable for links
  // already out there.
  RECOVERY_SCORE: {
    bandKind: "recovery",
    slug: "recovery",
    titleKey: "insights.derived.scores.recovery",
  },
  STRESS_SCORE: {
    bandKind: "stress",
    slug: "stress",
    titleKey: "insights.derived.scores.stress",
  },
  STRAIN_SCORE: {
    bandKind: "strain",
    slug: "strain",
    titleKey: "insights.derived.scores.strain",
  },
};

type ShortTranslate = (key: string) => string;

/**
 * A score's short name for a tile ("Gesundheit", "Schlafscore",
 * "Bereitschaft"): the glossary short form where the score has one, else its
 * name. Every surface and the wire (`shortLabel`) read it from here.
 */
export function scoreShortLabel(
  id: HealthLogScoreId,
  t: ShortTranslate,
): string {
  const entry = HEALTHLOG_SCORES[id];
  return entry.shortMetric
    ? metricName(entry.shortMetric, t).short
    : t(entry.titleKey);
}

/**
 * The one proxy rule. A `RECOVERY_SCORE` row from `COMPUTED` is HealthLog's
 * own readiness blend, stored by the 04:45 job (same formula as READINESS,
 * usually before the night's sleep has synced, so not the same number).
 * Every other source is a device's own score under the device's own name
 * ("WHOOP Recovery", "Oura Readiness", "Polar Nightly Recharge"): an Oura or
 * Polar recovery is a device score like WHOOP's, never the proxy. Re-exported
 * from `insights/derived/recovery-resolve.ts`; this module stays free of
 * server imports so a client component can ask it too.
 */
export function isProxyRecovery(row: { source: string }): boolean {
  return row.source === "COMPUTED";
}

type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/** A device's name as people know it, for the generic label. */
const SOURCE_NAMES: Readonly<Record<string, string>> = {
  WHOOP: "WHOOP",
  OURA: "Oura",
  POLAR: "Polar",
  GARMIN: "Garmin",
  WITHINGS: "Withings",
  GOOGLE_HEALTH: "Google Health",
  APPLE_HEALTH: "Apple Health",
  FITBIT: "Fitbit",
};

/** The display name of a measurement source ("GOOGLE_HEALTH" → "Google Health"). */
export function scoreSourceName(source: string): string {
  return (
    SOURCE_NAMES[source] ??
    source.charAt(0) + source.slice(1).toLowerCase().replace(/_/g, " ")
  );
}

/**
 * The vendor's own term for its recovery score, in English. The localised
 * bundles carry the same terms under `daily.morningCard.source.recovery.*`
 * (vendor terms are not translated).
 */
const RECOVERY_VENDOR_TERMS_EN: Readonly<Record<string, string>> = {
  WHOOP: "WHOOP Recovery",
  OURA: "Oura Readiness",
  POLAR: "Polar Nightly Recharge",
};

/** The suffix that marks HealthLog's computed recovery as its own readiness. */
const HEALTHLOG_SUFFIX = "(HealthLog)";

/**
 * The display name of one recovery row, by its source. The computed proxy is
 * HealthLog's readiness ("Bereitschaft (HealthLog)"); a device's row carries
 * the device's own term ("WHOOP Recovery") and is never called readiness in
 * HealthLog's words. Never names two sources at once.
 */
export function recoverySourceLabel(source: string, t: Translate): string {
  if (isProxyRecovery({ source })) {
    return `${t(HEALTHLOG_SCORES.READINESS.titleKey)} ${HEALTHLOG_SUFFIX}`;
  }
  return (
    translateOrNull(t, `daily.morningCard.source.recovery.${source}`) ??
    t("daily.morningCard.source.recoveryGeneric", {
      source: scoreSourceName(source),
    })
  );
}

/**
 * The same name in English, for surfaces that carry fixed English text (the
 * FHIR export).
 */
export function recoverySourceLabelEn(source: string): string {
  if (isProxyRecovery({ source })) return `Readiness ${HEALTHLOG_SUFFIX}`;
  return (
    RECOVERY_VENDOR_TERMS_EN[source] ?? `${scoreSourceName(source)} recovery`
  );
}

/**
 * The scale a stored score is shown on. Every score is stored 0..100; Polar's
 * Nightly Recharge is a 1..6 status rescaled on ingest (`polar/map.ts`), so
 * it is shown back on Polar's own scale.
 */
export function vendorScoreScale(
  type: string,
  source: string,
): { scaleMax: number; toDisplay: (stored: number) => number } {
  if (type === "RECOVERY_SCORE" && source === "POLAR") {
    return {
      scaleMax: 6,
      toDisplay: (stored) => Math.round((1 + (stored / 100) * 5) * 10) / 10,
    };
  }
  return { scaleMax: 100, toDisplay: (stored) => stored };
}
