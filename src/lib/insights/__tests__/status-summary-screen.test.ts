import { describe, it, expect } from "vitest";

import { finalizeStatusSummary } from "@/lib/insights/status-shared";
import { locales } from "@/lib/i18n/config";

/**
 * The status-card chokepoint. Before this existed the only transform between a
 * provider and a persisted assessment was whitespace normalisation, so a dose
 * imperative on the Weight card persisted as the day's cached assessment while
 * the identical sentence in the Coach was caught and replaced.
 *
 * The WITHHOLD policy itself is asserted by the caller's `ok: false` branch —
 * here we pin that the chokepoint reports the violation instead of returning
 * text, and that clean prose survives byte-for-byte.
 */

const DOSE_VIOLATION: Record<string, string> = {
  en: '{"summary":"Consider increasing to 10 mg next week."}',
  de: '{"summary":"Erhöhe auf 7,5 mg in der nächsten Woche."}',
  fr: '{"summary":"Augmentez votre dose à 2,4 mg la semaine prochaine."}',
  es: '{"summary":"Aumente su dosis a 2,4 mg la próxima semana."}',
  it: '{"summary":"Aumenti la sua dose a 2,4 mg la prossima settimana."}',
  pl: '{"summary":"Proszę zwiększyć dawkę do 2,4 mg w przyszłym tygodniu."}',
  ko: '{"summary":"다음 주에 2.4mg으로 늘려 보세요."}',
  nl: '{"summary":"Verhoog je dosis volgende week naar 2,4 mg."}',
  ru: '{"summary":"Подумайте об увеличении дозы до 10 мг на следующей неделе."}',
  "pt-BR": '{"summary":"Aumente sua dose para 2,4 mg na próxima semana."}',
};

const CAUSAL_VIOLATION: Record<string, string> = {
  en: '{"summary":"Your weight fell because you slept more."}',
  de: '{"summary":"Dein Gewicht sank wegen des Schlafs."}',
  fr: '{"summary":"Votre poids a baissé parce que vous avez mieux dormi."}',
  es: '{"summary":"Su peso bajó porque durmió más."}',
  it: '{"summary":"Il suo peso è calato perché ha dormito di più."}',
  pl: '{"summary":"Waga spadła, ponieważ spał Pan więcej."}',
  ko: '{"summary":"수면 때문에 체중이 줄었어요."}',
  nl: '{"summary":"Je gewicht daalde omdat je meer sliep."}',
  ru: '{"summary":"Ваш вес снизился, потому что вы больше спали."}',
  "pt-BR": '{"summary":"Seu peso caiu porque você dormiu mais."}',
};

const CLEAN: Record<string, string> = {
  en: '{"summary":"Your weight is averaging 82 kg this week, steady against last month."}',
  de: '{"summary":"Dein Gewicht liegt diese Woche im Schnitt bei 82 kg, stabil gegenüber dem Vormonat."}',
  fr: '{"summary":"Votre poids est en moyenne de 82 kg cette semaine, stable par rapport au mois dernier."}',
  es: '{"summary":"Su peso promedia 82 kg esta semana, estable frente al mes pasado."}',
  it: '{"summary":"Il suo peso è in media di 82 kg questa settimana, stabile rispetto al mese scorso."}',
  pl: '{"summary":"Waga wynosi średnio 82 kg w tym tygodniu, stabilnie wobec zeszłego miesiąca."}',
  ko: '{"summary":"이번 주 체중은 평균 82kg으로, 지난달과 비슷해요."}',
  nl: '{"summary":"Je gewicht ligt deze week gemiddeld op 82 kg, stabiel ten opzichte van vorige maand."}',
  ru: '{"summary":"Ваш вес на этой неделе в среднем 82 кг, стабильно к прошлому месяцу."}',
  "pt-BR":
    '{"summary":"Seu peso está em média em 82 kg nesta semana, estável em relação ao mês passado."}',
};

describe("finalizeStatusSummary — dose prescriptions are withheld", () => {
  for (const locale of locales) {
    it(`reports a violation instead of text in ${locale}`, () => {
      const out = finalizeStatusSummary(DOSE_VIOLATION[locale], locale);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe("dose_prescription");
    });
  }
});

describe("finalizeStatusSummary — causal claims are withheld", () => {
  /**
   * Status cards are the `insights` surface GROUND RULE 12 declares, so unlike
   * the Coach they DO enforce the no-causation contract.
   */
  for (const locale of locales) {
    it(`reports a causal claim in ${locale}`, () => {
      const out = finalizeStatusSummary(CAUSAL_VIOLATION[locale], locale);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe("causal_claim");
    });
  }
});

describe("finalizeStatusSummary — clean assessments pass untouched", () => {
  for (const locale of locales) {
    it(`returns the parsed summary verbatim in ${locale}`, () => {
      const out = finalizeStatusSummary(CLEAN[locale], locale);
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.text).toBe(
          JSON.parse(CLEAN[locale]).summary as unknown as string,
        );
      }
    });
  }

  it("still parses a bare-prose reply that ignores the JSON envelope", () => {
    const out = finalizeStatusSummary(
      "Your resting pulse is averaging 58 bpm, in line with your baseline.",
      "en",
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.text).toContain("58 bpm");
  });

  it("treats an empty completion as empty text, not a violation", () => {
    const out = finalizeStatusSummary("", "en");
    expect(out.ok).toBe(true);
  });
});

/**
 * HealthLog#608 — a truncated `{ "summary": "…` (unclosed, no `}`) used to fall
 * through the parser and render raw (braces, `"summary"`, quotes, literal `\n`)
 * in the resting-pulse Assessment card. It must now resolve to the withhold
 * state so the caller serves its deterministic stub, never the raw envelope.
 */
describe("finalizeStatusSummary — malformed structured output is withheld", () => {
  const TRUNCATED =
    '{ "summary": "Your resting pulse has been running lower than the last check';

  it("withholds a truncated envelope instead of surfacing raw JSON", () => {
    const out = finalizeStatusSummary(TRUNCATED, "en");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("unparseable_output");
    // Nothing about the raw envelope can leak on the ok:false branch.
    if (out.ok) {
      expect(out.text).not.toContain('"summary"');
      expect(out.text).not.toContain("{");
    }
  });

  it("withholds a summary-less object", () => {
    const out = finalizeStatusSummary("{}", "en");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("unparseable_output");
  });

  it("still renders a valid object summary", () => {
    const out = finalizeStatusSummary('{"summary":"Steady at 58 bpm."}', "en");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.text).toBe("Steady at 58 bpm.");
  });
});
