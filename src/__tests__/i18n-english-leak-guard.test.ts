import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.25 — English-leak heuristic guard.
 *
 * The existing i18n guards (`i18n-locale-integrity`, `i18n-drift-guard`,
 * `i18n-reverse-coverage`, `i18n-call-site-coverage`) all prove key-SHAPE
 * parity and that no key is empty/TODO — but an English string copied verbatim
 * into es/fr/it/pl passes every one of them. The v1.25 audit found exactly this
 * class of bug (the illness journal shipped English in every locale; the
 * PHQ-9/GAD-7 screener shipped English in es/fr/it/pl).
 *
 * This guard flags any es/fr/it/pl value that is byte-identical to the en value
 * for a MULTI-WORD string — the strong signal of a forgotten translation. It is
 * deliberately scoped to es/fr/it/pl (de carries many legitimate anglicisms the
 * maintainer accepts) and to multi-word values (single tokens like "Note" /
 * "Dose" / "BMI" are legitimately identical in several languages).
 *
 * Two escape hatches keep it lightweight without going silent:
 *   - a value-pattern rule auto-skips URLs / `mailto:` placeholders, and
 *   - an explicit KEY allowlist enumerates the legitimately-identical keys
 *     (clinical abbreviations, units, brand/product names, OAuth field labels).
 * A genuinely new leak in any non-allowlisted key fails CI.
 */

const ROOT = join(__dirname, "../..");
const MESSAGES_DIR = join(ROOT, "messages");
const EN_PATH = join(MESSAGES_DIR, "en.json");

// The audit scope: the four locales that must never echo English. German is
// intentionally excluded — it carries accepted anglicisms (e.g. "Health
// Score") that would be noise here, and is covered by its own pinned checks in
// `i18n-locale-integrity`.
const LEAK_LOCALES = ["es", "fr", "it", "pl"] as const;

function flattenValues(
  obj: unknown,
  prefix: string,
  out: [string, string][],
): void {
  if (obj == null || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push([key, v]);
    else if (typeof v === "object") flattenValues(v, key, out);
  }
}

/**
 * Letter-initial word tokens, with `{placeholders}` stripped first. A value
 * with fewer than two such tokens (a single word, a bare number + unit like
 * "30 pts", a pure format string) is not a candidate — only multi-word prose
 * is a reliable English-leak signal.
 */
function letterWords(value: string): string[] {
  return value.replace(/\{[^}]*\}/g, " ").match(/\p{L}[\p{L}\p{N}]*/gu) ?? [];
}

// URLs and mailto placeholders are identical across locales by construction.
const URL_LIKE = /(https?:\/\/|mailto:)/i;

/**
 * A mask placeholder (e.g. a UUID template `xxxxxxxx-xxxx-…`) reads as
 * "multi-word" only because separators split it; every token is a single
 * repeated character. These are locale-independent by construction.
 */
function isMaskPlaceholder(words: string[]): boolean {
  return words.length > 0 && words.every((w) => /^(.)\1*$/.test(w));
}

/**
 * Keys whose value legitimately equals the en value in es/fr/it/pl. Grouped by
 * reason. Prune an entry only when the value genuinely diverges in a locale.
 */
const LEGIT_IDENTICAL = new Set<string>([
  // The AM/PM marker label — the affix abbreviations themselves are the same
  // 12-hour-clock notation across the shipped Latin-script locales.
  "common.period",
  // Clinical abbreviations / SI units — identical across locales.
  "charts.vo2Max",
  "cycle.insights.crosstab.unitGlucose",
  "dashboard.metric.unit.bmi",
  "dashboard.metric.unit.mood",
  "dashboard.metric.unit.glucose",
  "dashboard.vo2Max",
  "dashboard.vo2MaxShort",
  "dashboard.vo2MaxUnit",
  "insights.cardioFitness.chartTitle",
  "insights.coach.metric.vo2_max",
  "insights.derived.composite.READINESS.component.hrv",
  "labs.catalog.hs-crp",
  "measurements.typeHrvRmssd",
  "measurements.typeVo2Max",
  "settings.sections.sources.metrics.vo2Max",
  // Brand / product / proper nouns.
  "settings.googleHealth",
  "admin.glitchtipDsn",
  "admin.integrationWebPush",
  "admin.offlineGeoEnabled",
  "admin.overview.snapshotOfflineGeoOff",
  "admin.overview.snapshotOfflineGeoOn",
  "admin.webPushVapidTitle",
  "dashboard.hero.scoreLabel",
  "insights.healthScore.provenance.sources.appleHealth",
  "measurements.sourceAppleHealth",
  "onboarding.source.more.appleHealth",
  "settings.ai.providerChain.types.anthropic",
  "settings.ai.providerChain.types.codex",
  "settings.ai.providerSelect.anthropic",
  "settings.moodLogUrl",
  "settings.sections.export.import.appleHealth.title",
  "settings.sections.sources.sourceLabels.APPLE_HEALTH",
  "settings.appleHealth.title",
  "mood.tag.fastFood",
  // Technical / config labels conventionally kept verbatim.
  "admin.hostMetrics.diskBusyPercent",
  "admin.overview.snapshotBuildSha",
  "admin.servicesGlobal",
  "admin.webPushVapidPublicKeyPlaceholder",
  "settings.ai.baseUrlLabel",
  "settings.ai.openai.modelCustomPlaceholder",
  "settings.fitbitClientId",
  "settings.fitbitClientSecret",
  "settings.ouraClientId",
  "settings.ouraClientSecret",
  "settings.polarClientId",
  "settings.polarClientSecret",
  "settings.whoopClientId",
  "settings.whoopClientSecret",
  "settings.sections.api.title",
  // Mental-health screener + crisis-resource copy is owned and translated by
  // the mental-health workstream (PHQ-9/GAD-7 wording is locale-validated
  // separately); the US brand names (988 / Crisis Text Line) stay verbatim.
  // Listed here so this guard does not double-own those strings.
  "mentalHealth.crisisResource.crisisTextLine.name",
  "mentalHealth.crisisResource.euEmotionalSupport.name",
  "mentalHealth.crisisResource.findahelpline.name",
  "mentalHealth.crisisResource.krisenchat.name",
  "mentalHealth.crisisResource.lifeline988.name",
  "mentalHealth.crisisResource.nummerGegenKummer.name",
  "mentalHealth.crisisResource.telefonSeelsorge.name",
  "mentalHealth.items.gad7.1",
  "mentalHealth.items.gad7.2",
  "mentalHealth.items.gad7.3",
  "mentalHealth.items.gad7.4",
  "mentalHealth.items.gad7.5",
  "mentalHealth.items.gad7.6",
  "mentalHealth.items.gad7.7",
  "mentalHealth.items.phq9.1",
  "mentalHealth.items.phq9.2",
  "mentalHealth.items.phq9.3",
  "mentalHealth.items.phq9.4",
  "mentalHealth.items.phq9.5",
  "mentalHealth.items.phq9.6",
  "mentalHealth.items.phq9.7",
  "mentalHealth.items.phq9.8",
  "mentalHealth.items.phq9.9",
  // v1.27.9 — the Sleep Condition Indicator is validated in English only
  // (Espie 2014, CC BY-NC). Item text, section stems and response anchors
  // ship VERBATIM in the source language in every locale — a self-made
  // translation would invalidate the instrument — and the UI shows a
  // localized "validated in English" note instead. Identical-to-EN is the
  // intended state here, not a leak.
  "mentalHealth.items.sci.1",
  "mentalHealth.items.sci.2",
  "mentalHealth.items.sci.3",
  "mentalHealth.items.sci.4",
  "mentalHealth.items.sci.5",
  "mentalHealth.items.sci.6",
  "mentalHealth.items.sci.7",
  "mentalHealth.items.sci.8",
  "mentalHealth.stems.sci.night",
  "mentalHealth.stems.sci.impact",
  "mentalHealth.stems.sci.finally",
  "mentalHealth.sciOptions.duration.0",
  "mentalHealth.sciOptions.quality.4",
  "mentalHealth.sciOptions.quality.3",
  "mentalHealth.sciOptions.quality.2",
  "mentalHealth.sciOptions.quality.1",
  "mentalHealth.sciOptions.quality.0",
  "mentalHealth.sciOptions.impact.4",
  "mentalHealth.sciOptions.impact.3",
  "mentalHealth.sciOptions.impact.2",
  "mentalHealth.sciOptions.impact.1",
  "mentalHealth.sciOptions.impact.0",
  "mentalHealth.sciOptions.problemDuration.4",
  "mentalHealth.sciOptions.problemDuration.3",
  "mentalHealth.sciOptions.problemDuration.2",
  "mentalHealth.sciOptions.problemDuration.1",
  "mentalHealth.sciOptions.problemDuration.0",
]);

describe("i18n English-leak guard", () => {
  const en = JSON.parse(readFileSync(EN_PATH, "utf8")) as Record<
    string,
    unknown
  >;
  const enFlat: [string, string][] = [];
  flattenValues(en, "", enFlat);
  const enMap = new Map(enFlat);

  it.each(LEAK_LOCALES.map((locale) => ({ locale })))(
    "$locale does not echo English for multi-word strings",
    ({ locale }) => {
      const data = JSON.parse(
        readFileSync(join(MESSAGES_DIR, `${locale}.json`), "utf8"),
      ) as Record<string, unknown>;
      const flat: [string, string][] = [];
      flattenValues(data, "", flat);

      const leaks = flat
        .filter(([key, value]) => {
          if (LEGIT_IDENTICAL.has(key)) return false;
          const enValue = enMap.get(key);
          if (enValue === undefined) return false;
          if (value.trim() !== enValue.trim()) return false; // translated
          if (URL_LIKE.test(value)) return false;
          const words = letterWords(value);
          if (isMaskPlaceholder(words)) return false;
          return words.length >= 2; // multi-word only
        })
        .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);

      expect(
        leaks,
        `${locale}.json carries English values identical to en.json.\n` +
          `Translate them, or — if the match is genuinely legitimate (a\n` +
          `clinical abbreviation, unit, brand, or proper noun) — add the key\n` +
          `to LEGIT_IDENTICAL in this test:\n` +
          leaks.map((s) => `  ${s}`).join("\n"),
      ).toEqual([]);
    },
  );
});
