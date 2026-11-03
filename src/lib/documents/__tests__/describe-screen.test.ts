import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import {
  runDocumentSummary,
  transcribeDocument,
  documentSummaryBlockedCopy,
} from "@/lib/documents/describe";
import type { AIProvider } from "@/lib/ai/types";
import { locales } from "@/lib/i18n/config";
import { targetLanguageName } from "@/lib/ai/prompts/output-language";

function providerReturning(content: string): AIProvider {
  return {
    type: "local",
    generateCompletion: vi.fn().mockResolvedValue({ content }),
  } as unknown as AIProvider;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runDocumentSummary — screened prose", () => {
  const VIOLATIONS: Record<string, string> = {
    en: "This report suggests you increase to 10 mg next week.",
    de: "Der Bericht empfiehlt, auf 7,5 mg zu erhöhen in der nächsten Woche.",
    fr: "Ce rapport indique d'augmenter votre dose à 2,4 mg la semaine prochaine.",
    es: "Este informe sugiere aumentar su dosis a 2,4 mg la próxima semana.",
    it: "Questo referto suggerisce di aumentare la sua dose a 2,4 mg la prossima settimana.",
    pl: "Ten raport sugeruje, aby zwiększyć dawkę do 2,4 mg w przyszłym tygodniu.",
    ko: "이 보고서는 다음 주에 2.4mg으로 늘려 보라고 권해요.",
    nl: "Dit rapport stelt voor om de dosis volgende week naar 2,4 mg te verhogen.",
    "pt-BR":
      "Este laudo sugere aumentar sua dose para 2,4 mg na próxima semana.",
    ru: "В отчёте предлагается увеличить дозу до 2,4 мг на следующей неделе.",
  };

  for (const locale of locales) {
    it(`reports the violation instead of the prose in ${locale}`, async () => {
      const out = await runDocumentSummary({
        provider: providerReturning(VIOLATIONS[locale]),
        providerType: "local",
        ocrText: "irrelevant",
        locale,
      });
      expect(out.blocked).toBe("dose_prescription");
      expect(out.summary).toBe("");
    });
  }

  it.each(locales)(
    "tells the provider to write summaries in %s",
    async (locale) => {
      const provider = providerReturning("A short descriptive summary.");

      await runDocumentSummary({
        provider,
        providerType: "local",
        ocrText: "irrelevant",
        locale,
      });

      const params = vi.mocked(provider.generateCompletion).mock.calls[0]?.[0];
      expect(params?.system).toContain(
        `Write the summary in ${targetLanguageName(locale)}.`,
      );
    },
  );

  it("passes a genuinely descriptive summary through untouched", async () => {
    const clean =
      "A lab report from a clinic, dated last month, listing routine blood values.";
    const out = await runDocumentSummary({
      provider: providerReturning(clean),
      providerType: "local",
      ocrText: "irrelevant",
      locale: "en",
    });
    expect(out.blocked).toBeNull();
    expect(out.summary).toBe(clean);
  });
});

describe("documentSummaryBlockedCopy", () => {
  it("carries a native German body and rides English elsewhere", () => {
    expect(documentSummaryBlockedCopy("de")).not.toBe(
      documentSummaryBlockedCopy("en"),
    );
    expect(documentSummaryBlockedCopy("fr")).toBe(
      documentSummaryBlockedCopy("en"),
    );
  });
});

describe("transcribeDocument — deliberately NOT screened", () => {
  /**
   * Transcription reproduces the user's OWN document. A discharge letter that
   * says "increase to 10 mg" is the prescriber's instruction; screening it
   * would delete the user's record from their own view. The screen exists to
   * stop the MODEL originating such a claim, not to censor the source.
   */
  it("returns a dose instruction from the source document verbatim", async () => {
    const letter =
      "Plan: increase to 10 mg daily from 1 August. Review in six weeks.";
    const out = await transcribeDocument({
      provider: providerReturning(letter),
      providerType: "local",
    });
    expect(out.text).toBe(letter);
  });

  it("echoes posted OCR text verbatim without a provider round-trip", async () => {
    const letter = "Risque cardiovasculaire à 10 ans : 12%.";
    const provider = providerReturning("should not be called");
    const out = await transcribeDocument({
      provider,
      providerType: "local-ocr",
      ocrText: letter,
    });
    expect(out.text).toBe(letter);
    expect(provider.generateCompletion).not.toHaveBeenCalled();
  });
});
