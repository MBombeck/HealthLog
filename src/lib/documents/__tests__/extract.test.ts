/**
 * v1.25 — extraction mapping safety tests.
 *
 * The mapping is the safety boundary: it must reproduce STATED facts only and
 * never let a code, value, or status leak across resource types or past the
 * confidence gate. These tests pin "extract, never interpret" at the unit
 * level with a canned provider response (no network).
 */
import { describe, expect, it, vi } from "vitest";

// Every read re-checks the wire; it is open here.
vi.mock("@/lib/ai/capabilities/egress", () => ({
  aiEgressRefusal: async () => null,
}));

import {
  runInboundExtraction,
  type RunInboundExtractionArgs,
} from "@/lib/documents/extract";
import { OcrExtractError } from "@/lib/documents/ocr-read";
import type { AIProvider } from "@/lib/ai/types";
import type {
  ConditionFactData,
  MedicationStatementFactData,
  ObservationFactData,
} from "@/lib/validations/inbound-documents";

/** A provider that returns one canned completion regardless of params. */
function fakeProvider(content: string): AIProvider {
  return {
    // Only `generateCompletion` is exercised by the extractor.
    generateCompletion: async () => ({ content }),
  } as unknown as AIProvider;
}

/** One read: of `ocrText` when given (text mode), else of an attached image. */
function oneRead(
  provider: AIProvider,
  ocrText?: string,
): RunInboundExtractionArgs {
  return ocrText === undefined
    ? {
        userId: "u1",
        provider,
        providerType: "mock",
        mode: "vision",
        chunks: [{ images: [], pages: [] }],
      }
    : {
        userId: "u1",
        provider,
        providerType: "mock",
        mode: "text",
        chunks: [{ text: ocrText, pages: [] }],
        ocrText,
      };
}

describe("runInboundExtraction — stated-status-only mapping", () => {
  it("keeps a stated ICD-10 code on a Condition and drops a mismatched system", async () => {
    const provider = fakeProvider(
      JSON.stringify({
        reportDate: "2026-01-02",
        kind: "DOCTOR_REPORT",
        facts: [
          {
            type: "CONDITION",
            label: "Type 2 diabetes mellitus",
            code: "E11.9",
            codeSystem: "ICD10",
            clinicalStatus: "active",
            verificationStatus: "confirmed",
            effectiveDate: "2025-12-01",
            confidence: 0.9,
            sourceText: "Dx: Type 2 diabetes mellitus (E11.9)",
          },
          {
            type: "CONDITION",
            label: "Some finding",
            code: "12345-6",
            codeSystem: "LOINC", // wrong system for a Condition → dropped
            confidence: 0.9,
            sourceText: "finding",
          },
        ],
      }),
    );

    const result = await runInboundExtraction(oneRead(provider));

    expect(result.reportDate).toBe("2026-01-02");
    expect(result.facts).toHaveLength(2);

    const first = result.facts[0]!.data as ConditionFactData;
    expect(first.code).toBe("E11.9");
    expect(first.codeSystem).toBe("ICD10");
    expect(first.clinicalStatus).toBe("active");
    expect(first.onsetDate).toBe("2025-12-01");

    const second = result.facts[1]!.data as ConditionFactData;
    expect(second.code).toBeNull();
    expect(second.codeSystem).toBeNull();
  });

  it("never sets both value and valueText on an Observation and never range-flags", async () => {
    const provider = fakeProvider(
      JSON.stringify({
        reportDate: null,
        facts: [
          {
            type: "OBSERVATION",
            label: "Glucose",
            code: "2345-7",
            codeSystem: "LOINC",
            value: 95,
            valueText: "normal", // model sent both → numeric wins, text dropped
            unit: "mg/dL",
            referenceLow: 70,
            referenceHigh: 100,
            effectiveDate: "2026-01-02",
            confidence: 0.95,
            sourceText: "Glucose 95 mg/dL (70-100)",
          },
        ],
      }),
    );

    const result = await runInboundExtraction(oneRead(provider));
    const obs = result.facts[0]!.data as ObservationFactData;
    expect(obs.value).toBe(95);
    expect(obs.valueText).toBeNull();
    expect(obs.code).toBe("2345-7");
    // Reference bounds ride along as stated — but no flag/severity is computed.
    expect(obs.referenceLow).toBe(70);
    expect(obs.referenceHigh).toBe(100);
    expect(obs).not.toHaveProperty("rangeStatus");
    expect(obs).not.toHaveProperty("flag");
  });

  it("routes a stated RxNorm code onto the medication and gates low confidence", async () => {
    const provider = fakeProvider(
      JSON.stringify({
        facts: [
          {
            type: "MEDICATION_STATEMENT",
            label: "Metformin",
            code: "6809",
            codeSystem: "RXNORM",
            dose: "500 mg",
            medicationStatus: "ongoing",
            confidence: 0.3, // below the floor → needsReview
            sourceText: "Metformin 500 mg",
          },
        ],
      }),
    );

    const result = await runInboundExtraction(oneRead(provider));
    const fact = result.facts[0]!;
    expect(fact.needsReview).toBe(true);
    const med = fact.data as MedicationStatementFactData;
    expect(med.rxNormCode).toBe("6809");
    expect(med.atcCode).toBeNull();
    expect(med.dose).toBe("500 mg");
    expect(med.statusStated).toBe("ongoing");
  });

  it("stores the document's real span, not the model's echo of it", async () => {
    // The OCR text says "Hämoglobin    14.2 g/dL"; the model echoes a tidied
    // rendering of it. The stored provenance must be the document's characters.
    const ocrText = "Labor 2026-01-02\nHämoglobin    14.2 g/dL   (13.5-17.5)";
    const provider = fakeProvider(
      JSON.stringify({
        facts: [
          {
            type: "OBSERVATION",
            label: "Hämoglobin",
            value: 14.2,
            unit: "g/dL",
            confidence: 0.9,
            sourceText: "Hämoglobin 14.2 g/dL (13.5-17.5)",
          },
        ],
      }),
    );

    const result = await runInboundExtraction(oneRead(provider, ocrText));
    const { provenance } = result.facts[0]!;
    expect(provenance.anchored).toBe(true);
    expect(provenance.sourceText).toBe("Hämoglobin    14.2 g/dL   (13.5-17.5)");
    expect(
      ocrText.slice(
        provenance.sourceOffset!,
        provenance.sourceOffset! + provenance.sourceText.length,
      ),
    ).toBe(provenance.sourceText);
  });

  it("marks a fact unanchored rather than storing a quote it cannot locate", async () => {
    const ocrText = "Labor 2026-01-02\nHämoglobin 14.2 g/dL";
    const provider = fakeProvider(
      JSON.stringify({
        facts: [
          {
            type: "OBSERVATION",
            label: "Hämoglobin",
            value: 14.2,
            unit: "g/dL",
            confidence: 0.9,
            // A quote the document never carried.
            sourceText: "Haemoglobin was measured at 14.2 and is normal",
          },
        ],
      }),
    );

    const result = await runInboundExtraction(oneRead(provider, ocrText));
    const { provenance } = result.facts[0]!;
    expect(provenance.anchored).toBe(false);
    expect(provenance.sourceText).toBe("");
    expect(provenance.sourceOffset).toBeNull();
    // The fact itself still stages — only its provenance claim is withheld.
    expect(result.facts).toHaveLength(1);
  });

  it("marks vision-mode facts unanchored — there is no extracted text to verify", async () => {
    const provider = fakeProvider(
      JSON.stringify({
        facts: [
          {
            type: "CONDITION",
            label: "Type 2 diabetes mellitus",
            confidence: 0.9,
            sourceText: "Dx: Type 2 diabetes mellitus",
          },
        ],
      }),
    );

    const result = await runInboundExtraction(oneRead(provider));
    const { provenance } = result.facts[0]!;
    expect(provenance.anchored).toBe(false);
    expect(provenance.sourceText).toBe("");
  });

  it("throws an unparseable OcrExtractError on output that is not the schema", async () => {
    const provider = fakeProvider("not json at all");
    const err = await runInboundExtraction(oneRead(provider)).catch((e) => e);
    expect(err).toBeInstanceOf(OcrExtractError);
    expect((err as OcrExtractError).reason).toBe("unparseable");
  });
});
