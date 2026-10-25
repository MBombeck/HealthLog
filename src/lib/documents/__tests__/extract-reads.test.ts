/**
 * The document extraction over several reads: how a long document's facts
 * are planned, validated, merged and capped, and what a cut answer leaves.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/capabilities/egress", () => ({
  aiEgressRefusal: async () => null,
}));

import type { AIProvider, CompletionResult } from "@/lib/ai/types";
import {
  INBOUND_TEXT_READ_CHARS,
  planInboundTextReads,
  runInboundExtraction,
} from "@/lib/documents/extract";
import { OCR_MAX_PAGES } from "@/lib/documents/ocr-plan";
import { OcrExtractError, type OcrChunk } from "@/lib/documents/ocr-read";
import {
  INBOUND_MAX_FACTS,
  type ObservationFactData,
} from "@/lib/validations/inbound-documents";
import { OCR_MAX_ROWS } from "@/lib/validations/labs-ocr";

function observation(label: string, value: number) {
  return {
    type: "OBSERVATION",
    label,
    value,
    unit: "mg/dl",
    confidence: 0.9,
    sourceText: `${label} ${value}`,
  };
}

/** A provider that answers each call with the next of `replies`. */
function scripted(
  replies: Array<Partial<CompletionResult> & { content: string }>,
): AIProvider & { calls: number } {
  const provider = {
    calls: 0,
    generateCompletion: async () => {
      const reply = replies[Math.min(provider.calls, replies.length - 1)];
      provider.calls += 1;
      return { tokensUsed: 100, model: "m", providerType: "local", ...reply };
    },
  };
  return provider as unknown as AIProvider & { calls: number };
}

function reads(count: number): OcrChunk[] {
  return Array.from({ length: count }, (_, i) => ({
    text: `part ${i + 1}`,
    pages: [],
  }));
}

function run(provider: AIProvider, chunks: OcrChunk[]) {
  return runInboundExtraction({
    userId: "u1",
    provider,
    providerType: "local",
    mode: "text",
    chunks,
  });
}

describe("runInboundExtraction over several reads", () => {
  it("drops a malformed fact on its own and stages the rest", async () => {
    const provider = scripted([
      {
        content: JSON.stringify({
          facts: [
            observation("Hb", 14),
            { type: "LAB_PANEL", label: "not a fact type" },
            observation("Ferritin", 80),
          ],
        }),
      },
    ]);
    const result = await run(provider, reads(1));
    expect(
      result.facts.map((f) => (f.data as ObservationFactData).label),
    ).toEqual(["Hb", "Ferritin"]);
  });

  it("stages more facts than a letter holds when a report runs to them, and merges a fact two reads list", async () => {
    const perRead = 90;
    const replies = [0, 1, 2].map((r) => ({
      content: JSON.stringify({
        reportDate: "2026-09-30",
        facts: [
          // The first fact repeats across reads, as a header row would.
          observation("Summary", 1),
          ...Array.from({ length: perRead }, (_, i) =>
            observation(`Analyt ${r}-${i}`, i),
          ),
        ],
      }),
    }));
    const result = await run(scripted(replies), reads(3));
    expect(result.facts).toHaveLength(3 * perRead + 1);
    expect(result.incomplete).toBe(false);
  });

  it("keeps a value two reads list for different report dates, and merges it on the same date", async () => {
    const page = (reportDate: string | null) => ({
      content: JSON.stringify({ reportDate, facts: [observation("Hb", 14)] }),
    });
    // Two reports of different days, one value each with no date of its own.
    const twoDays = await run(
      scripted([page("2026-09-01"), page("2026-09-30")]),
      reads(2),
    );
    expect(twoDays.facts).toHaveLength(2);
    // A page without a date reads under the report's, as the lab scan does.
    const sameDay = await run(
      scripted([page("2026-09-01"), page(null)]),
      reads(2),
    );
    expect(sameDay.facts).toHaveLength(1);
  });

  it("keeps the lab scan's row cap, and says when a report holds more", async () => {
    expect(INBOUND_MAX_FACTS).toBe(OCR_MAX_ROWS);
    const reply = (r: number) => ({
      content: JSON.stringify({
        facts: Array.from({ length: 150 }, (_, i) =>
          observation(`Analyt ${r}-${i}`, i),
        ),
      }),
    });
    const result = await run(
      scripted([reply(0), reply(1), reply(2)]),
      reads(3),
    );
    expect(result.facts).toHaveLength(INBOUND_MAX_FACTS);
    expect(result.incomplete).toBe(true);
  });

  it("keeps the complete facts of an answer cut at the output limit, and marks the extraction incomplete", async () => {
    const full = JSON.stringify({
      facts: [observation("Hb", 14), observation("Ferritin", 80)],
    });
    const cut = full.slice(0, full.indexOf('"Ferritin"') + 4);
    const result = await run(
      scripted([{ content: cut, finishReason: "length" }]),
      reads(1),
    );
    expect(
      result.facts.map((f) => (f.data as ObservationFactData).label),
    ).toEqual(["Hb"]);
    expect(result.incomplete).toBe(true);
  });

  it("does not retry a cut answer, and names the output limit when no fact closed", async () => {
    const provider = scripted([
      { content: '{ "facts": [ { "type": "OBSERV', finishReason: "length" },
    ]);
    const err = await run(provider, reads(1)).catch((e) => e);
    expect(err).toBeInstanceOf(OcrExtractError);
    expect((err as OcrExtractError).reason).toBe("output_limit");
    expect(provider.calls).toBe(1);
  });

  it("keeps the facts of the reads before a later read failed outright", async () => {
    let calls = 0;
    const provider = {
      generateCompletion: async () => {
        calls += 1;
        if (calls > 1) throw new Error("upstream 503");
        return {
          content: JSON.stringify({ facts: [observation("Hb", 14)] }),
          tokensUsed: 10,
          model: "m",
          providerType: "local",
        };
      },
    } as unknown as AIProvider;
    const result = await run(provider, reads(3));
    expect(result.facts).toHaveLength(1);
    expect(result.incomplete).toBe(true);
  });

  it("files a fact read from one rendered page under that page", async () => {
    const result = await runInboundExtraction({
      userId: "u1",
      provider: scripted([
        { content: JSON.stringify({ facts: [observation("Hb", 14)] }) },
      ]),
      providerType: "local",
      mode: "vision",
      chunks: [{ images: [], documents: [], pages: [3] }],
      totalPages: 4,
    });
    expect(result.facts[0].provenance.page).toBe(2);
  });
});

describe("planInboundTextReads", () => {
  const line = (i: number) => `Analyt ${i}    ${i},0    mg/dl    1 - 9`;
  const text = (lines: number) =>
    Array.from({ length: lines }, (_, i) => line(i)).join("\n");

  it("reads a short text as one read", () => {
    const plan = planInboundTextReads(text(10), undefined);
    expect(plan.args.chunks).toHaveLength(1);
    expect(plan.partial).toBe(false);
  });

  it("splits a long text at line boundaries into reads no longer than one read carries", () => {
    const whole = text(400);
    const plan = planInboundTextReads(whole, undefined);
    expect(plan.args.chunks.length).toBeGreaterThan(1);
    for (const chunk of plan.args.chunks) {
      expect(chunk.text!.length).toBeLessThanOrEqual(INBOUND_TEXT_READ_CHARS);
    }
    expect(plan.args.chunks.map((c) => c.text).join("\n")).toBe(whole);
    expect(plan.args.ocrText).toBe(whole);
    expect(plan.partial).toBe(false);
  });

  it("grows the parts when the deadline allows few reads, and reads from the start past twice the size", () => {
    const schedule = (calls: number) => ({
      maxModelCalls: () => calls,
      arm: async () => undefined,
    });
    // Two reads' worth of calls: the parts grow to hold the text.
    const grown = planInboundTextReads(text(200), schedule(4));
    expect(grown.args.chunks).toHaveLength(2);
    expect(grown.partial).toBe(false);
    for (const chunk of grown.args.chunks) {
      expect(chunk.text!.length).toBeGreaterThan(INBOUND_TEXT_READ_CHARS);
    }
    // Far more text than two reads can carry: the first parts, said so.
    const capped = planInboundTextReads(text(2000), schedule(4));
    expect(capped.args.chunks).toHaveLength(2);
    expect(capped.partial).toBe(true);
  });

  it("caps the reads of a run with no deadline", () => {
    const plan = planInboundTextReads(text(4000), undefined);
    expect(plan.args.chunks.length).toBe(OCR_MAX_PAGES);
    expect(plan.partial).toBe(true);
  });
});
