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
const LEAK_LOCALES = ["es", "fr", "it", "pl", "ko", "nl", "pt-BR"] as const;

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
  // Vaccine catalogue: clinical proper nouns whose accepted written form is the
  // same across these locales. "Hib" carries its Latin binomial verbatim, and
  // "Hepatitis A" / "Hepatitis B" read identically in Spanish. The catalogue
  // ships no trade names, so these are disease names, not brands.
  "vaccinations.catalog.hib",
  "vaccinations.catalog.hepatitis-a",
  "vaccinations.catalog.hepatitis-b",
  // The AM/PM marker label — the affix abbreviations themselves are the same
  // 12-hour-clock notation across the shipped Latin-script locales.
  "common.period",
  // Clinical abbreviations / SI units — identical across locales.
  "charts.vo2Max",
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
  // The report's SDNN row, named the way the RMSSD row above is.
  "reportSelection.leafHrvSdnn",
  "illness.vital.HRV_RMSSD",
  "settings.sections.sources.metrics.hrvRmssd",
  "measurements.typeVo2Max",
  // "{hours} h {minutes} min": the SI symbols for hour and minute.
  "measurements.durationHoursMinutes",
  "settings.sections.sources.metrics.vo2Max",
  "settings.integrations.withings.plan.items.vo2Max",
  "settings.integrations.oura.scope.items.vo2max",
  // Brand / product / proper nouns.
  "settings.googleHealth",
  "admin.glitchtipDsn",
  "admin.integrationWebPush",
  "admin.offlineGeoEnabled",
  "admin.overview.snapshotOfflineGeoOff",
  "admin.overview.snapshotOfflineGeoOn",
  "admin.webPushVapidTitle",
  "measurements.sourceAppleHealth",
  "measurements.sourceGoogleHealth",
  "measurements.sourceHealthConnect",
  "medications.sourceAppleHealth",
  "settings.ai.providerChain.types.anthropic",
  "settings.ai.providerChain.types.codex",
  "settings.ai.providerSelect.anthropic",
  "settings.sections.export.import.appleHealth.title",
  "settings.sections.sources.sourceLabels.APPLE_HEALTH",
  "settings.sections.sources.sourceLabels.GOOGLE_HEALTH",
  "settings.sections.sources.sourceLabels.HEALTH_CONNECT",
  "settings.appleHealth.title",
  "mood.tag.fastFood",
  // Technical / config labels conventionally kept verbatim.
  "admin.hostMetrics.diskBusyPercent",
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
  // Crisis-resource names: services and US brand names (988 / Crisis Text
  // Line) that stay verbatim.
  "mentalHealth.crisisResource.crisisTextLine.name",
  "mentalHealth.crisisResource.euEmotionalSupport.name",
  "mentalHealth.crisisResource.findahelpline.name",
  "mentalHealth.crisisResource.krisenchat.name",
  "mentalHealth.crisisResource.lifeline988.name",
  "mentalHealth.crisisResource.nummerGegenKummer.name",
  "mentalHealth.crisisResource.telefonSeelsorge.name",
  // Questionnaire items, answers and stems live in code with their sources
  // (`src/lib/mental-health/wording/`), never in a bundle, so no entry is
  // needed for them here.
  // Proper nouns, a URL label and an acronym — the accepted written form in
  // Korean is the Latin original, so these stay identical to en.json.
  "auth.emailPlaceholder",
  "settings.fitbitTag",
  "settings.googleHealthTag",
  "settings.nightscoutUrl",
  "admin.aiServerKey.baseUrlLabel",
  "admin.webPushVapidSubject",
  // Dutch spells these exactly as English does: "In bed" and "capsule(s)" are
  // ordinary Dutch, and the clinical index names and the fatty-acid
  // abbreviations are written in their international form.
  "mood.dayContext.linkedInBed",
  "insights.sleep.stages.inBed",
  "medications.wizard.steps.step3.unit.capsules",
  "doctorReport.glucoseClinical.gmi",
  "insights.bloodGlucose.clinical.advanced.jIndex.label",
  "nutrients.names.dha",
  "nutrients.names.epa",
]);

describe("i18n English-leak guard", () => {
  const en = JSON.parse(readFileSync(EN_PATH, "utf8")) as Record<
    string,
    unknown
  >;
  const enFlat: [string, string][] = [];
  flattenValues(en, "", enFlat);
  const enMap = new Map(enFlat);

  it("actually reads the bundles (non-zero floor)", () => {
    // The walker is the guard's eyes. If `flattenValues` rots — a shape
    // change, a broken recursion — every leak test above it goes green over
    // locales it never read. The bundle carries ~7800 keys; a floor well
    // below that but far above zero fails on rot without failing on
    // ordinary key churn.
    expect(enFlat.length).toBeGreaterThan(3000);
  });

  it.each(LEAK_LOCALES.map((locale) => ({ locale })))(
    "$locale does not echo English for multi-word strings",
    ({ locale }) => {
      const data = JSON.parse(
        readFileSync(join(MESSAGES_DIR, `${locale}.json`), "utf8"),
      ) as Record<string, unknown>;
      const flat: [string, string][] = [];
      flattenValues(data, "", flat);
      // Same non-zero proof per locale — an unreadable or empty bundle must
      // fail loudly, never pass as "no leaks found".
      expect(flat.length).toBeGreaterThan(3000);

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

  it("carries no stale LEGIT_IDENTICAL entry", () => {
    // An allowlist that outlives the key it excused is an allowlist nobody
    // can reason about: the next reader cannot tell which entries are load-
    // bearing. Two were already dead when this assertion was written — one
    // from a key removed long before, one from the duplicated version fields
    // that came off `/admin`. The sibling allowlists in
    // `card-description-length.test.ts` and `account-payload-consumer-guard`
    // carry the same check; this one did not.
    const stale = [...LEGIT_IDENTICAL].filter(
      (key) => typeof enMap.get(key) !== "string",
    );
    expect(
      stale,
      "these keys no longer exist in en.json — drop them from LEGIT_IDENTICAL",
    ).toEqual([]);
  });
});
