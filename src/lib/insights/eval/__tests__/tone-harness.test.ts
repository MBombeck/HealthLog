import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { requireFloor } from "@/__tests__/helpers/source-files";
import { locales, type Locale } from "@/lib/i18n/config";
import { openingShape } from "@/lib/ai/prompts/shared-contracts";
import {
  instructionLocale,
  outputLanguageDirective,
  targetLanguageName,
} from "@/lib/ai/prompts/output-language";
import type { MetricSignal } from "@/lib/insights/metric-signal";
import {
  getNoKeyBiomarkerStatusText,
  getNoKeyBloodPressureStatusText,
  getNoKeyBmiStatusText,
  getNoKeyGeneralStatusText,
  getNoKeyMedicationComplianceStatusText,
  getNoKeyMetricStatusText,
  getNoKeyMoodStatusText,
  getNoKeyPulseStatusText,
  getNoKeyWeightStatusText,
} from "@/lib/insights/no-key-fallbacks";

import { ASSESSMENT_SURFACES } from "../prompt-surfaces";
import {
  checkFallbackTone,
  checkLocaleIntegrity,
  checkPromptToneContract,
  findUnnegatedMatch,
  formatViolations,
  hasUnnegatedMatch,
} from "../tone-rules";

/**
 * The per-metric tone harness.
 *
 * Runs in the normal suite with no provider, no network and no database: it
 * grades the assembled prompt text and the deterministic fallback text, which
 * is where every tone regression this repo has shipped was first visible.
 *
 * Three regression classes are blocking here:
 *
 *   1. a surface stops leading with meaning (it drops the shared opening
 *      contract, or its user prompt loses the meaning-first instruction),
 *   2. a locale collapses (fr/es/it/pl fall back to the German body, or lose
 *      the reply-language directive),
 *   3. a prompt reintroduces a value-first instruction.
 *
 * A prompt change that legitimately shifts tone updates the rules in the SAME
 * change — which is the review moment the harness exists to force.
 */

/** The four locales that ride the English body plus their own directive. */
const RIDERS: readonly Locale[] = ["fr", "es", "it", "pl"];

describe("tone harness — prompt surfaces", () => {
  describe.each(ASSESSMENT_SURFACES)("$name", (surface) => {
    it.each(locales)(
      "%s leads with meaning and never value-first",
      (locale) => {
        const body = instructionLocale(locale);
        const violations = checkPromptToneContract({
          systemPrompt: surface.system(locale),
          userPrompt: surface.user(locale),
          instructionBody: body,
          openingShapeFragment: openingShape[body],
        });
        expect(
          violations,
          formatViolations(`${surface.name}/${locale}`, violations),
        ).toEqual([]);
      },
    );

    it.each(RIDERS)("%s composes its own language, not German", (locale) => {
      const violations = checkLocaleIntegrity({
        systemPrompt: surface.system(locale),
        directive: outputLanguageDirective(locale),
        languageName: targetLanguageName(locale),
      });
      expect(
        violations,
        formatViolations(`${surface.name}/${locale}`, violations),
      ).toEqual([]);
    });
  });

  /**
   * Coverage guard. A new `get*SystemPrompt` under `src/lib/ai/prompts/` that
   * is not registered in `ASSESSMENT_SURFACES` is a surface nothing above
   * grades — exactly how the biomarker card stayed uncovered while every
   * sibling was pinned. Modules that are not per-metric assessment surfaces
   * are named here explicitly, so exempting one is a visible edit.
   */
  it("every assessment prompt module is registered in the harness", () => {
    const dir = join(process.cwd(), "src/lib/ai/prompts");
    const NON_ASSESSMENT = new Set([
      // Composed INTO the assessment prompts rather than being one.
      "base-system.ts",
      "shared-contracts.ts",
      "output-language.ts",
      "opener-archetype.ts",
      "safety-contracts.ts",
      "interpretation-block.ts",
      "compact-sections.ts",
      // Other AI surfaces with their own contracts and their own coverage.
      "insight-generator.ts",
      "insight-system-prompt.ts",
      "native-prompts.ts",
      "status-batch.ts",
    ]);
    const modules = requireFloor(
      "assessment prompt modules",
      readdirSync(dir).filter(
        (f) =>
          f.endsWith(".ts") &&
          !f.endsWith(".d.ts") &&
          !NON_ASSESSMENT.has(f) &&
          /export function get\w*SystemPrompt/.test(
            readFileSync(join(dir, f), "utf8"),
          ),
      ),
      11,
    );
    const registered = new Set(
      ASSESSMENT_SURFACES.map((s) =>
        `${s.name}.ts`.replace("metric-archetype.ts", "metric-archetypes.ts"),
      ),
    );
    const unregistered = modules.filter((m) => !registered.has(m));
    expect(
      unregistered,
      `assessment prompt modules with no harness entry: ${unregistered.join(", ")}`,
    ).toEqual([]);
  });
});

describe("tone harness — deterministic fallbacks", () => {
  function signal(over: Partial<MetricSignal>): MetricSignal {
    return {
      metric: "steps",
      unit: "steps",
      current: 8200,
      currentWindowDays: 7,
      baseline: 7800,
      baselineLabel: "your 30-day average",
      delta: 400,
      deltaPct: 5.1,
      spread: 900,
      outsideNormalSwing: false,
      direction: "higher-better",
      n: 21,
      newestDaysAgo: 0,
      ...over,
    } as unknown as MetricSignal;
  }

  /**
   * `expectMeaningFirst: false` on the last case is deliberate and load-bearing:
   * with no baseline and no delta there is NO read the data supports, so the
   * line honestly opens on the value instead of manufacturing a verdict.
   */
  const GROUNDED = [
    {
      name: "steady in range",
      expectMeaningFirst: true,
      build: (l: Locale) =>
        getNoKeyPulseStatusText(l, signal({ outsideNormalSwing: false })),
    },
    {
      name: "drifting the unfavourable way",
      expectMeaningFirst: true,
      build: (l: Locale) =>
        getNoKeyBloodPressureStatusText(
          l,
          signal({
            current: 138,
            baseline: 132,
            delta: 6,
            outsideNormalSwing: true,
            direction: "lower-better",
          }),
        ),
    },
    {
      name: "earned win",
      expectMeaningFirst: true,
      build: (l: Locale) =>
        getNoKeyMetricStatusText(
          l,
          signal({ delta: 2400, outsideNormalSwing: true }),
        ),
    },
    {
      name: "no baseline — no verdict the data supports",
      expectMeaningFirst: false,
      build: (l: Locale) =>
        getNoKeyWeightStatusText(
          l,
          signal({ baseline: null, delta: null, outsideNormalSwing: null }),
        ),
    },
  ] as const;

  describe.each(GROUNDED)("$name", ({ build, expectMeaningFirst }) => {
    it.each(locales)("%s stays in voice", (locale) => {
      const text = build(locale);
      const violations = checkFallbackTone({ text, expectMeaningFirst });
      expect(violations, formatViolations(locale, violations)).toEqual([]);
    });
  });

  /**
   * The no-signal floors. These run when there is nothing to ground against,
   * so they may not imply any read at all — but they still have to open on
   * meaning rather than on a clinical instruction list, which is what they
   * were before this pass.
   */
  const FLOORS: readonly {
    name: string;
    build: (l: Locale) => string;
  }[] = [
    { name: "general", build: (l) => getNoKeyGeneralStatusText(l) },
    {
      name: "biomarker",
      build: (l) => getNoKeyBiomarkerStatusText(l, "Marker"),
    },
    {
      name: "blood-pressure",
      build: (l) => getNoKeyBloodPressureStatusText(l),
    },
    { name: "weight", build: (l) => getNoKeyWeightStatusText(l) },
    { name: "pulse", build: (l) => getNoKeyPulseStatusText(l) },
    { name: "bmi", build: (l) => getNoKeyBmiStatusText(l) },
    { name: "mood", build: (l) => getNoKeyMoodStatusText(l) },
    {
      name: "medication-compliance",
      build: (l) => getNoKeyMedicationComplianceStatusText(l),
    },
  ];

  /**
   * "No assessment is available" in each locale's own words. Keyed per locale
   * rather than `de ? … : /No assessment/`, which is the same de/en binary that
   * let four locales render English bodies unnoticed — under it, a French floor
   * passed this assertion precisely BECAUSE it was still English.
   */
  const NO_READ_SENTINEL: Record<Locale, RegExp> = {
    de: /keine Einschätzung vor/,
    en: /No assessment/,
    fr: /Aucune évaluation/,
    es: /no hay ninguna valoración/,
    it: /non è disponibile alcuna valutazione/,
    pl: /nie ma (?:tu )?żadnej oceny/,
    nl: /geen beoordeling/,
    "pt-BR": /n[aã]o h[áa] (?:uma )?avalia[çc][aã]o/i,
    ko: /평가가 없어요/,
    ru: /оценки нет|нет оценки/i,
  };

  describe.each(FLOORS)("$name floor", ({ build }) => {
    it.each(locales)("%s opens on the read, not on an order", (locale) => {
      const text = build(locale);
      const violations = checkFallbackTone({ text, expectMeaningFirst: true });
      expect(violations, formatViolations(locale, violations)).toEqual([]);

      // The floor states plainly that no assessment is available — it must not
      // dress the absence up as one.
      expect(text).toMatch(NO_READ_SENTINEL[locale]);
    });
  });

  /**
   * The regression this whole pass exists to close: `getLocalizedText` used to
   * return `locale === "de" ? de : en`, so fr/es/it/pl rendered the ENGLISH
   * body on nine metric surfaces. Every tone rule above passed on that text —
   * it was in voice, it just was not the reader's language.
   *
   * Byte-identity against English is therefore the assertion that actually
   * pins it. It holds for both the no-signal floors and the signal-grounded
   * composer, because the composer has its own per-locale sentence templates
   * (the value sentence and the verdict lead), not only per-locale nouns.
   */
  describe.each(RIDERS)("%s renders its own body", (locale) => {
    it.each(FLOORS)("$name floor is not the English text", ({ build }) => {
      expect(build(locale)).not.toEqual(build("en"));
    });

    it.each(GROUNDED)(
      "$name grounded line is not the English text",
      ({ build }) => {
        expect(build(locale)).not.toEqual(build("en"));
      },
    );
  });
});

describe("tone harness — the rules themselves", () => {
  it("catches an un-negated value-first instruction", () => {
    expect(
      hasUnnegatedMatch(
        "Write 2 to 4 calm sentences: state the current value and how it sits.",
        /state the current value/i,
      ),
    ).toBe(true);
  });

  it("does not fire on the prompts that BAN the value-first opener", () => {
    expect(
      hasUnnegatedMatch(
        "Lead per the OPENER HINT — do NOT always open with the number.",
        /(?:open|lead|start|begin)(?:s|ing)? with the (?:number|value|reading|figure)/i,
      ),
    ).toBe(false);
    expect(
      hasUnnegatedMatch(
        "bring in ONE concrete number right after as support; never lead with the value.",
        /(?:open|lead|start|begin)(?:s|ing)? with the (?:number|value|reading|figure)/i,
      ),
    ).toBe(false);
  });

  it("reports the offending excerpt so a red run reads as a diff", () => {
    const hit = findUnnegatedMatch(
      "…in plain language: state the current value and how it sits against…",
      /state the current value/i,
    );
    expect(hit).toContain("state the current value");
  });

  it("flags a value-led fallback opener", () => {
    const violations = checkFallbackTone({
      text: "Your resting pulse is 61 bpm right now. That is your usual range.",
      expectMeaningFirst: true,
    });
    expect(violations.map((v) => v.rule)).toContain(
      "fallback-leads-with-meaning",
    );
  });

  it("flags false cheer and exclamation in a fallback", () => {
    const violations = checkFallbackTone({
      text: "Steady and much as usual. Great job, keep it up!",
      expectMeaningFirst: true,
    });
    const rules = violations.map((v) => v.rule);
    expect(rules).toContain("fallback-no-false-cheer");
    expect(rules).toContain("fallback-no-exclamation");
  });

  it("flags a German body leak on a rider locale", () => {
    const violations = checkLocaleIntegrity({
      systemPrompt:
        "DEINE DATENGRUNDLAGE (graded snapshot): … AUSGABEFORMAT: Antworte ausschließlich mit JSON.",
      directive: "OUTPUT LANGUAGE: Réponds en français.",
      languageName: "French",
    });
    expect(violations.map((v) => v.rule)).toContain(
      "locale-no-german-body-leak",
    );
  });
});
