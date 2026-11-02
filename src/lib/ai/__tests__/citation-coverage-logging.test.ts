import { describe, it, expect, vi } from "vitest";
import {
  detectsNormativeClaim,
  computeCitationCoverage,
  normativeKeywordBank,
} from "../citation-coverage";
import { MEDICAL_REFERENCES } from "../medical-references";
import { locales, type Locale } from "@/lib/i18n/config";

const annotateMock = vi.fn();

vi.mock("@/lib/logging/context", () => ({
  annotate: (fields: { meta?: Record<string, unknown> }) =>
    annotateMock(fields),
  getEvent: () => null,
}));

const knownRefId = MEDICAL_REFERENCES[0].id;

const baseMetricSource = {
  type: "bloodPressure",
  timeRange: "last7days",
  summary: "avg 138/86 across 9 readings",
};

const baseCitation = {
  type: "bloodPressure",
  timeRange: "last7days",
  summary: "avg 138/86 across 9 readings",
};

const baseRationale = {
  dataWindow: "last7days" as const,
  comparedTo: "your 90-day median (128/82)",
  deviation: "+10/+4 mmHg above baseline",
};

/**
 * v1.4.16 — citation-coverage post-validation logging.
 *
 * After the schema parse + cross-citation check pass, the wrapper
 * counts how many recommendations make a normative claim and how
 * many of those carry a referenceId. The result lands as a Wide-Event
 * meta annotation so the admin AI quality dashboard (planned) can
 * track citation-coverage over time.
 *
 * The check is observational only in v1.4.16 — a rec that should cite
 * but doesn't gets logged, never raises a parse error. v1.4.16 phase
 * B5c flips it to required for severity >= "important".
 */

describe("detectsNormativeClaim()", () => {
  it("detects 'target' in the rec text", () => {
    expect(detectsNormativeClaim("Aim for a BP target below 130/80")).toBe(
      true,
    );
  });

  it("detects 'should' in the rec text", () => {
    expect(detectsNormativeClaim("Your BP should stay below 140/90")).toBe(
      true,
    );
  });

  it("detects 'normal range' in the rec text", () => {
    expect(detectsNormativeClaim("Pulse is within the normal range")).toBe(
      true,
    );
  });

  it("detects 'above' in the rec text", () => {
    expect(
      detectsNormativeClaim("Reading is above the recommended ceiling"),
    ).toBe(true);
  });

  it("detects 'below' in the rec text", () => {
    expect(detectsNormativeClaim("Reading is below the lower threshold")).toBe(
      true,
    );
  });

  it("returns false for purely observational text", () => {
    expect(
      detectsNormativeClaim(
        "Your avg7 (78 bpm) is 5 bpm higher than your 90-day median (73 bpm)",
      ),
    ).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(detectsNormativeClaim("TARGET range exceeded")).toBe(true);
    expect(detectsNormativeClaim("Target range exceeded")).toBe(true);
    expect(detectsNormativeClaim("target range exceeded")).toBe(true);
  });
});

describe("computeCitationCoverage()", () => {
  it("counts an empty recommendations[] as zero / zero", () => {
    expect(
      computeCitationCoverage({
        summary: "x",
        recommendations: [],
        citations: [],
        warnings: [],
      }),
    ).toEqual({
      totalRecommendations: 0,
      normativeRecommendations: 0,
      citedNormativeRecommendations: 0,
      uncitedNormativeRecommendationIds: [],
    });
  });

  it("counts a normative rec with referenceId as cited", () => {
    const result = computeCitationCoverage({
      summary: "x",
      recommendations: [
        {
          id: "rec-1",
          text: "Aim for a target below 140/90",
          severity: "important",
          metricSource: baseMetricSource,
          rationale: baseRationale,
          referenceId: knownRefId,
        },
      ],
      citations: [baseCitation],
      warnings: [],
    });
    expect(result.totalRecommendations).toBe(1);
    expect(result.normativeRecommendations).toBe(1);
    expect(result.citedNormativeRecommendations).toBe(1);
    expect(result.uncitedNormativeRecommendationIds).toEqual([]);
  });

  it("flags a normative rec without referenceId as uncited", () => {
    const result = computeCitationCoverage({
      summary: "x",
      recommendations: [
        {
          id: "rec-naked-target",
          text: "Aim for a target below 140/90",
          severity: "important",
          metricSource: baseMetricSource,
          rationale: baseRationale,
        },
      ],
      citations: [baseCitation],
      warnings: [],
    });
    expect(result.normativeRecommendations).toBe(1);
    expect(result.citedNormativeRecommendations).toBe(0);
    expect(result.uncitedNormativeRecommendationIds).toEqual([
      "rec-naked-target",
    ]);
  });

  it("does NOT flag observational recs as uncited", () => {
    const result = computeCitationCoverage({
      summary: "x",
      recommendations: [
        {
          id: "rec-observational",
          text: "Your avg7 (78 bpm) is 5 bpm higher than your 90-day median",
          severity: "info",
          metricSource: baseMetricSource,
          rationale: baseRationale,
        },
      ],
      citations: [baseCitation],
      warnings: [],
    });
    expect(result.normativeRecommendations).toBe(0);
    expect(result.citedNormativeRecommendations).toBe(0);
    expect(result.uncitedNormativeRecommendationIds).toEqual([]);
  });

  it("flags 'above' / 'below' as normative — they imply a threshold", () => {
    // The heuristic intentionally treats "5 mmHg above your 90-day
    // median" as a normative claim because the comparison invokes a
    // baseline threshold; the rec should cite the source of that
    // baseline (or be reworded to drop the threshold language).
    const result = computeCitationCoverage({
      summary: "x",
      recommendations: [
        {
          id: "rec-threshold",
          text: "Your avg7 is 5 mmHg above your 90-day median",
          severity: "info",
          metricSource: baseMetricSource,
          rationale: baseRationale,
        },
      ],
      citations: [baseCitation],
      warnings: [],
    });
    expect(result.normativeRecommendations).toBe(1);
  });

  it("mixes cited / uncited / observational correctly", () => {
    const result = computeCitationCoverage({
      summary: "x",
      recommendations: [
        {
          id: "cited-1",
          text: "Aim for target range 130/80",
          severity: "important",
          metricSource: baseMetricSource,
          rationale: baseRationale,
          referenceId: knownRefId,
        },
        {
          id: "uncited-1",
          text: "Your weight should drop by 2 kg",
          severity: "suggestion",
          metricSource: baseMetricSource,
          rationale: baseRationale,
        },
        {
          id: "observational-1",
          // No normative keyword — pure within-user comparison.
          text: "Your avg7 (78 bpm) is 5 bpm higher than your 90-day median",
          severity: "info",
          metricSource: baseMetricSource,
          rationale: baseRationale,
        },
      ],
      citations: [baseCitation],
      warnings: [],
    });
    expect(result.totalRecommendations).toBe(3);
    expect(result.normativeRecommendations).toBe(2);
    expect(result.citedNormativeRecommendations).toBe(1);
    expect(result.uncitedNormativeRecommendationIds).toEqual(["uncited-1"]);
  });
});

/**
 * The bank used to be English plus German. Recommendations are generated in
 * the reader's language, so for fr / es / it / pl every rec scored
 * non-normative and the annotation reported 0 normative, 0 uncited — a
 * coverage figure indistinguishable from perfect coverage. These pin that the
 * check can still fail in each shipped language.
 */
describe("normative-claim detection across the shipped locales", () => {
  /** One unambiguously normative sentence per shipped locale. */
  const NORMATIVE_SENTENCE: Record<Locale, string> = {
    en: "Your systolic should stay below the target of 130 mmHg.",
    de: "Ihr systolischer Wert sollte unter dem Zielwert von 130 mmHg bleiben.",
    fr: "Votre systolique devrait rester en dessous de l’objectif de 130 mmHg.",
    es: "Su sistólica debería mantenerse por debajo del objetivo de 130 mmHg.",
    it: "La sistolica dovrebbe restare al di sotto dell’obiettivo di 130 mmHg.",
    pl: "Ciśnienie skurczowe powinno pozostać poniżej celu 130 mmHg.",
    nl: "Je bovendruk zou onder de streefwaarde van 130 mmHg moeten blijven.",
    ko: "수축기 혈압은 목표인 130 mmHg 아래로 유지해야 해요.",
    "pt-BR": "Sua sistólica deveria ficar abaixo da meta de 130 mmHg.",
    ru: "Ваше систолическое должно оставаться ниже целевого уровня 130 мм рт. ст.",
  };

  /**
   * The same observation phrased WITHOUT a normative claim — a pure
   * within-user comparison. Pins that the locale banks widened detection
   * rather than making every sentence match.
   */
  const OBSERVATIONAL_SENTENCE: Record<Locale, string> = {
    en: "Your 7-day average is 4 mmHg higher than your 90-day median.",
    de: "Ihr 7-Tage-Mittel liegt 4 mmHg höher als Ihr 90-Tage-Median.",
    fr: "Votre moyenne sur 7 jours dépasse de 4 mmHg votre médiane sur 90 jours.",
    es: "Su media de 7 días excede en 4 mmHg su mediana de 90 días.",
    it: "La media a 7 giorni supera di 4 mmHg la mediana a 90 giorni.",
    pl: "Twoja średnia z 7 dni przekracza medianę z 90 dni o 4 mmHg.",
    nl: "Je 7-daagse gemiddelde ligt 4 mmHg hoger dan je 90-daagse mediaan.",
    ko: "7일 평균이 90일 중앙값보다 4 mmHg 더 커요.",
    "pt-BR":
      "Sua média de 7 dias está 4 mmHg mais alta que a sua mediana de 90 dias.",
    ru: "Среднее за 7 дней — 128 мм рт. ст., медиана за 90 дней — 124.",
  };

  it.each(locales)("carries a non-empty keyword bank for %s", (locale) => {
    expect(normativeKeywordBank()[locale].length).toBeGreaterThan(0);
  });

  it.each(locales)("detects a normative recommendation in %s", (locale) => {
    expect(detectsNormativeClaim(NORMATIVE_SENTENCE[locale], locale)).toBe(
      true,
    );
  });

  it.each(locales)("leaves an observational %s sentence alone", (locale) => {
    expect(detectsNormativeClaim(OBSERVATIONAL_SENTENCE[locale], locale)).toBe(
      false,
    );
  });

  it.each(locales)(
    "counts an uncited normative %s rec as uncited, not as absent",
    (locale) => {
      const result = computeCitationCoverage(
        {
          recommendations: [
            { id: "uncited-1", text: NORMATIVE_SENTENCE[locale] },
            { id: "observational-1", text: OBSERVATIONAL_SENTENCE[locale] },
          ],
        },
        locale,
      );
      expect(result.totalRecommendations).toBe(2);
      expect(result.normativeRecommendations).toBe(1);
      expect(result.citedNormativeRecommendations).toBe(0);
      expect(result.uncitedNormativeRecommendationIds).toEqual(["uncited-1"]);
    },
  );

  it("still grades an English reply served to a non-English reader", () => {
    // A fallback provider ignores the language directive; the EN bank runs
    // alongside the reader's for exactly this case.
    expect(
      detectsNormativeClaim("Your systolic should stay below 130 mmHg.", "pl"),
    ).toBe(true);
  });

  it("does not fire on the everyday Italian 'soprattutto'", () => {
    // The comparative is banked as "al di sopra", not a bare "sopra", so an
    // ordinary intensifier cannot inflate the normative count.
    expect(
      detectsNormativeClaim(
        "Soprattutto la sera i valori restano stabili.",
        "it",
      ),
    ).toBe(false);
  });
});
