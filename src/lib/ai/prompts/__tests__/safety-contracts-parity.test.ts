import { describe, it, expect } from "vitest";

import {
  GROUND_RULE_KEYS,
  SAFETY_CONTRACT_LOCALES,
  loadSafetyContracts,
} from "../safety-contracts";

/**
 * v1.4.25 W14c — safety-contract matrix parity guards.
 *
 * Complements the W9d `i18n-locale-integrity.test.ts` for the YAML
 * matrix:
 *
 *   1. Every EN ground rule has a non-empty translation in every other
 *      locale. A missing translation is a translator gap that must
 *      block release.
 *   2. No non-EN locale carries a value identical to its EN counterpart
 *      (verbatim-EN in a non-EN body = placeholder bug). Brand names
 *      and contract enums are exempt — they're SUPPOSED to stay
 *      EN-identical (rule 3 below).
 *   3. Every sentinel literal is IDENTICAL across all six locales —
 *      these are parser-contract markers, not translatable copy.
 *   4. Every GLP-1 brand name appears IDENTICALLY across all six
 *      locales — international brand registry, never translate.
 *   5. Every JSON contract enum value (severity, sourceWindow, etc) is
 *      IDENTICAL across all six locales — these are parser keys.
 *   6. Every locale exports a non-empty `defer_to_clinician_phrases`
 *      list (the refusal-probe needs at least one match per locale).
 *   7. Every locale's `out_of_scope_refusal.summary` is non-empty.
 *   8. The PROMPT_VERSION ratchet is not gated on this file — additive
 *      ratchets (adding a new GROUND RULE) get a separate landing.
 */

describe("safety-contracts parity — every EN rule translated", () => {
  for (const locale of SAFETY_CONTRACT_LOCALES) {
    for (const key of GROUND_RULE_KEYS) {
      it(`${locale}/${key} has a non-empty body`, () => {
        const matrix = loadSafetyContracts(locale);
        const rule = matrix.ground_rules[key];
        const body = locale === "en" ? rule.en : rule.locale;
        expect(body, `${locale}/${key} body`).toBeDefined();
        expect(body!.trim().length).toBeGreaterThan(0);
      });
    }
  }
});

describe("safety-contracts parity — non-EN bodies are not verbatim-EN", () => {
  // Brand names + contract enums + sentinel literals legitimately stay
  // EN-identical inside each locale's rule body. Compare only the
  // `locale` field of each non-EN rule against the `.en` field of the
  // same rule and assert they differ. This catches the "translator
  // forgot to fill in the row" placeholder bug.
  const en = loadSafetyContracts("en");
  for (const locale of SAFETY_CONTRACT_LOCALES) {
    if (locale === "en") continue;
    for (const key of GROUND_RULE_KEYS) {
      it(`${locale}/${key} is translated (not verbatim EN)`, () => {
        const m = loadSafetyContracts(locale);
        const enBody = en.ground_rules[key].en;
        const localeBody = m.ground_rules[key].locale;
        expect(enBody).toBeDefined();
        expect(localeBody).toBeDefined();
        expect(localeBody!.trim()).not.toBe(enBody!.trim());
      });
    }
  }
});

describe("safety-contracts parity — sentinel literals identical across locales", () => {
  const enSentinels = loadSafetyContracts("en").sentinel_literals;
  for (const locale of SAFETY_CONTRACT_LOCALES) {
    if (locale === "en") continue;
    it(`${locale} sentinel_literals match EN exactly`, () => {
      const localeSentinels = loadSafetyContracts(locale).sentinel_literals;
      expect(localeSentinels).toEqual(enSentinels);
    });
  }
});

describe("safety-contracts parity — GLP-1 brand list identical across locales", () => {
  const enBrands = loadSafetyContracts("en").glp1_brand_list;
  for (const locale of SAFETY_CONTRACT_LOCALES) {
    if (locale === "en") continue;
    it(`${locale} glp1_brand_list matches EN exactly`, () => {
      const localeBrands = loadSafetyContracts(locale).glp1_brand_list;
      expect(localeBrands).toEqual(enBrands);
    });
  }
});

describe("safety-contracts parity — contract enums identical across locales", () => {
  const enEnums = loadSafetyContracts("en").contract_enums;
  for (const locale of SAFETY_CONTRACT_LOCALES) {
    if (locale === "en") continue;
    it(`${locale} contract_enums match EN exactly`, () => {
      const localeEnums = loadSafetyContracts(locale).contract_enums;
      expect(localeEnums).toEqual(enEnums);
    });
  }
});

describe("safety-contracts parity — defer-to-clinician phrase list non-empty", () => {
  for (const locale of SAFETY_CONTRACT_LOCALES) {
    it(`${locale} defer_to_clinician_phrases has at least one entry`, () => {
      const phrases = loadSafetyContracts(locale).defer_to_clinician_phrases;
      expect(phrases.length).toBeGreaterThan(0);
      for (const phrase of phrases) {
        expect(phrase.trim().length).toBeGreaterThan(0);
      }
    });
  }
});

describe("safety-contracts parity — out-of-scope refusal summary non-empty", () => {
  for (const locale of SAFETY_CONTRACT_LOCALES) {
    it(`${locale} out_of_scope_refusal.summary is non-empty`, () => {
      const summary = loadSafetyContracts(locale).out_of_scope_refusal.summary;
      expect(summary.trim().length).toBeGreaterThan(0);
    });
  }
});

describe("safety-contracts parity — every parser_critical rule must_contain tokens survive", () => {
  // The refusal-probe test asserts each rule body carries its
  // `must_contain` tokens, but only via the locale-specific body in
  // that file. Here we additionally guarantee that for every locale's
  // matrix the parser-critical rules expose at least one token in
  // `must_contain` (a defence-in-depth check — a rule that loses its
  // must_contain pin would silently bypass the refusal-probe).
  for (const locale of SAFETY_CONTRACT_LOCALES) {
    const matrix = loadSafetyContracts(locale);
    for (const key of GROUND_RULE_KEYS) {
      const rule = matrix.ground_rules[key];
      if (!rule.parser_critical) continue;
      it(`${locale}/${key} (parser_critical) declares must_contain tokens`, () => {
        expect(rule.must_contain).toBeDefined();
        expect((rule.must_contain ?? []).length).toBeGreaterThan(0);
      });
    }
  }
});

describe("safety-contracts parity — reply-language directive non-empty", () => {
  for (const locale of SAFETY_CONTRACT_LOCALES) {
    it(`${locale} reply_language_directive is non-empty`, () => {
      const directive = loadSafetyContracts(locale).reply_language_directive;
      expect(directive.trim().length).toBeGreaterThan(10);
    });
  }
});
