import { describe, expect, it, vi } from "vitest";

// Every read re-checks the wire; it is open here.
vi.mock("@/lib/ai/capabilities/egress", () => ({
  aiEgressRefusal: async () => null,
}));

import type { AIProvider } from "@/lib/ai/types";
import {
  parseSimpleAntigravityExtraction,
  runAntigravityTextExtraction,
} from "@/lib/documents/antigravity-extract";
import {
  TEXT_LAYER_FALLBACK_TIMEOUT_MS,
  type OcrChunk,
} from "@/lib/documents/ocr-read";
import type { ObservationFactData } from "@/lib/validations/inbound-documents";

function fakeProvider(jsonContent: string): AIProvider {
  return {
    type: "antigravity",
    supportsTools: false,
    generateCompletion: vi.fn().mockResolvedValue({
      content: jsonContent,
      finishReason: "stop",
      tokensUsed: 150,
      cachedInputTokens: 0,
    }),
    generateCompletionStream: vi.fn(),
  };
}

describe("parseSimpleAntigravityExtraction", () => {
  it("parses valid envelope with results array", () => {
    const raw = {
      reportDate: "2026-11-15",
      results: [
        {
          label: "Glukoza",
          value: 95.0,
          unit: "mg/dl",
          referenceRange: "70 - 99",
        },
      ],
    };
    const parsed = parseSimpleAntigravityExtraction(raw);
    expect(parsed).toEqual({
      reportDate: "2026-11-15",
      kind: null,
      results: [
        {
          label: "Glukoza",
          value: 95.0,
          unit: "mg/dl",
          referenceRange: "70 - 99",
        },
      ],
    });
  });

  it("reads the document kind and drops a kind it does not know", () => {
    const known = parseSimpleAntigravityExtraction({
      reportDate: null,
      kind: "DISCHARGE_LETTER",
      results: [],
    });
    expect(known?.kind).toBe("DISCHARGE_LETTER");
    const unknown = parseSimpleAntigravityExtraction({
      reportDate: null,
      kind: "LAB_CARD",
      results: [],
    });
    expect(unknown?.kind).toBeNull();
  });

  it("accepts 'facts' key as alternative to 'results'", () => {
    const raw = {
      reportDate: "2026-11-15",
      facts: [
        {
          label: "TSH",
          value: "2.1",
          unit: "mIU/l",
          referenceRange: "0.27 - 4.2",
        },
      ],
    };
    const parsed = parseSimpleAntigravityExtraction(raw);
    expect(parsed?.results).toHaveLength(1);
    expect(parsed?.results[0].label).toBe("TSH");
  });

  it("accepts top-level array directly", () => {
    const raw = [{ label: "Morfologia", value: 14.2, unit: "g/dl" }];
    const parsed = parseSimpleAntigravityExtraction(raw);
    expect(parsed?.reportDate).toBeNull();
    expect(parsed?.results).toHaveLength(1);
  });

  it("returns null for non-objects or empty input", () => {
    expect(parseSimpleAntigravityExtraction(null)).toBeNull();
    expect(parseSimpleAntigravityExtraction(undefined)).toBeNull();
    expect(parseSimpleAntigravityExtraction("string")).toBeNull();
  });
});

describe("runAntigravityTextExtraction", () => {
  it("extracts observations, normalises decimal commas, and parses reference ranges", async () => {
    const provider = fakeProvider(
      JSON.stringify({
        reportDate: "2026-11-15",
        results: [
          {
            label: "Glukoza",
            value: "95,5",
            unit: "mg/dl",
            referenceRange: "70 - 99",
          },
          {
            label: "Borelioza IgG",
            value: "negatywny",
            unit: null,
            referenceRange: "negatywny",
          },
        ],
      }),
    );

    const chunk: OcrChunk = {
      text: "Data: 2026-11-15\nGlukoza: 95,5 mg/dl (70 - 99)\nBorelioza IgG: negatywny",
      pages: [1],
    };

    const result = await runAntigravityTextExtraction({
      userId: "user-1",
      provider,
      providerType: "antigravity",
      chunks: [chunk],
      ocrText: chunk.text ?? "",
      meter: { spent: 0, cached: 0 },
    });

    expect(result.reportDate).toBe("2026-11-15");
    expect(result.facts).toHaveLength(2);

    const glucose = result.facts[0];
    expect(glucose.factType).toBe("OBSERVATION");
    expect((glucose.data as ObservationFactData).label).toBe("Glukoza");
    expect((glucose.data as ObservationFactData).value).toBe(95.5);
    expect((glucose.data as ObservationFactData).valueText).toBeNull();
    expect((glucose.data as ObservationFactData).unit).toBe("mg/dl");
    expect((glucose.data as ObservationFactData).referenceLow).toBe(70);
    expect((glucose.data as ObservationFactData).referenceHigh).toBe(99);
    expect(glucose.provenance.anchored).toBe(true);

    const borrelia = result.facts[1];
    expect(borrelia.factType).toBe("OBSERVATION");
    expect((borrelia.data as ObservationFactData).value).toBeNull();
    expect((borrelia.data as ObservationFactData).valueText).toBe("negatywny");

    // Check completion was called with the 240 s fallback timeout
    const call = vi.mocked(provider.generateCompletion).mock.calls[0][0];
    expect(call.timeoutMs).toBe(TEXT_LAYER_FALLBACK_TIMEOUT_MS);
    expect(call.timeoutMs).toBe(240_000);
  });

  it("handles markdown code fence wrapping in JSON response", async () => {
    const rawJson = JSON.stringify({
      reportDate: "2026-11-15",
      results: [
        {
          label: "Hemoglobina",
          value: 14.5,
          unit: "g/dl",
          referenceRange: "12 - 16",
        },
      ],
    });

    const provider = fakeProvider(`\`\`\`json\n${rawJson}\n\`\`\``);

    const chunk: OcrChunk = {
      text: "Hemoglobina 14.5 g/dl (12 - 16)",
      pages: [1],
    };

    const result = await runAntigravityTextExtraction({
      userId: "user-1",
      provider,
      providerType: "antigravity",
      chunks: [chunk],
      ocrText: chunk.text ?? "",
    });

    expect(result.facts).toHaveLength(1);
    expect((result.facts[0].data as ObservationFactData).label).toBe(
      "Hemoglobina",
    );
    expect((result.facts[0].data as ObservationFactData).value).toBe(14.5);
  });

  it("requires human review with valid label anchor and unverified numeric value", async () => {
    const rawJson = JSON.stringify({
      reportDate: "2026-11-15",
      results: [
        {
          label: "Glukoza",
          value: 999.9,
          unit: "mg/dl",
          confidence: 0.95,
        },
      ],
    });

    const provider = fakeProvider(rawJson);
    const chunk: OcrChunk = {
      text: "Data: 2026-11-15\nGlukoza: nieoznaczona w materiale\nKomentarz: brak",
      pages: [1],
    };

    const result = await runAntigravityTextExtraction({
      userId: "user-1",
      provider,
      providerType: "antigravity",
      chunks: [chunk],
      ocrText: chunk.text ?? "",
    });

    expect(result.facts).toHaveLength(1);
    const fact = result.facts[0];
    expect((fact.data as ObservationFactData).label).toBe("Glukoza");
    expect((fact.data as ObservationFactData).value).toBe(999.9);
    // Anchor for the label itself is valid
    expect(fact.provenance.anchored).toBe(true);
    // But unverified numeric value must explicitly require review
    expect(fact.needsReview).toBe(true);
  });

  it("avoids treating absent confidence as high and preserves unknown unit guard", async () => {
    const rawJson = JSON.stringify({
      reportDate: "2026-11-15",
      results: [
        {
          label: "Glukoza",
          value: 95.5,
          unit: "(calc)",
          // confidence omitted
        },
      ],
    });

    const provider = fakeProvider(rawJson);
    const chunk: OcrChunk = {
      text: "Glukoza: 95.5 (calc)",
      pages: [1],
    };

    const result = await runAntigravityTextExtraction({
      userId: "user-1",
      provider,
      providerType: "antigravity",
      chunks: [chunk],
      ocrText: chunk.text ?? "",
    });

    expect(result.facts).toHaveLength(1);
    const fact = result.facts[0];
    // Absent confidence is not treated as high (0.5 < floor 0.6)
    expect(fact.confidence).toBeLessThan(0.6);
    // Unknown unit (calc-only note) and absent confidence both require review
    expect(fact.needsReview).toBe(true);
    expect((fact.data as ObservationFactData).unit).toBeNull();
  });
});
