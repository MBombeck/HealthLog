/**
 * #1311 — "Read with AI", summarise, suggest and extract on a PDF stored on a
 * server whose CPU cannot run the page renderer, for a provider that only
 * takes images. The renderer gate is closed with `NATIVE_CANVAS=off` and the
 * stored bytes go through the real `prepareVisionInput` / `planInboundReads`
 * and the real reader child; what is asserted is what reaches the provider.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Buffer } from "node:buffer";
import { jsPDF } from "jspdf";

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/ai/capabilities/egress", () => ({
  aiEgressRefusal: vi.fn(async () => null),
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  reconcileSpend: vi.fn(async () => undefined),
  reserveBudget: vi.fn(async (_u: string, tokens: number) => ({
    allowed: true,
    reserved: tokens,
  })),
  OPERATOR_COST_CAP: 200_000,
  USER_PLAN_CAP: 2_000_000,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({})),
  refundRateLimit: vi.fn(async () => undefined),
}));
vi.mock("@/lib/documents/ai-runs/store", () => ({
  settleAiRunBudget: vi.fn(async () => undefined),
}));
vi.mock("@/lib/documents/content-index", () => ({
  upsertContentIndex: vi.fn(async () => ({ tokenCount: 12 })),
}));
vi.mock("@/lib/documents/index-document", () => ({
  recordIndexAttempt: vi.fn(async () => undefined),
}));
vi.mock("@/lib/documents/auto-stage-labs", () => ({
  maybeAutoStageLabFacts: vi.fn(async () => null),
}));
vi.mock("@/lib/documents/store", () => ({
  decryptDocumentContent: vi.fn(),
  encryptFactData: (d: unknown) => d,
  encryptFactProvenance: (p: unknown) => p,
  encryptDocumentSummary: (s: string) => s,
}));

/** What the staging transaction wrote, read back as the document's facts. */
let stagedFacts: unknown[] = [];
let stagedIncomplete: unknown = null;
vi.mock("@/lib/db", () => {
  const tx = {
    $queryRaw: async () => [{ status: "STORED" }],
    extractedFact: {
      count: async () => 0,
      deleteMany: async () => ({ count: 0 }),
    },
    inboundDocument: {
      update: async ({
        data,
      }: {
        data: { facts: { create: unknown[] }; extractionIncomplete?: unknown };
      }) => {
        stagedFacts = data.facts.create;
        stagedIncomplete = data.extractionIncomplete;
        return {};
      },
      findUniqueOrThrow: async () => ({
        id: "doc1",
        status: "EXTRACTED",
        facts: stagedFacts,
      }),
    },
  };
  return {
    prisma: {
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
      inboundDocument: { updateMany: async () => ({ count: 0 }) },
    },
  };
});

import type {
  AIProvider,
  CompletionParams,
  CompletionResult,
} from "@/lib/ai/types";
import { executeDocumentExtract } from "@/lib/documents/ai-runs/extract-run";
import { executeDocumentIndex } from "@/lib/documents/ai-runs/index-run";
import type { DocumentVisionPick } from "@/lib/documents/ai-runs/run-support";
import { executeDocumentSuggest } from "@/lib/documents/ai-runs/suggest-run";
import { executeDocumentSummary } from "@/lib/documents/ai-runs/summary-run";
import { upsertContentIndex } from "@/lib/documents/content-index";
import { recordIndexAttempt } from "@/lib/documents/index-document";
import { __resetNativeCanvasSupportForTests } from "@/lib/documents/native-canvas-support";
import { decryptDocumentContent } from "@/lib/documents/store";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const LAB_LINE = "Haemoglobin 14.2 g/dl 13.5 - 17.5";

/** Page 1 a lab page with a text layer; then `scans` image-only pages. */
function pdfWith(textPages: number, scans: number): Buffer {
  const doc = new jsPDF();
  for (let i = 0; i < textPages + scans; i++) {
    if (i > 0) doc.addPage();
    if (i < textPages) {
      doc.text(LAB_LINE, 10, 15);
      doc.text("Leukocytes 6.1 /nl 4.0 - 10.0", 10, 23);
    } else {
      doc.addImage(`data:image/png;base64,${PNG}`, "PNG", 10, 10, 180, 250);
    }
  }
  return Buffer.from(doc.output("arraybuffer"));
}

/** A provider that records every call and answers with `answer`. */
function recording(calls: CompletionParams[], answer: string): AIProvider {
  return {
    generateCompletion: async (
      params: CompletionParams,
    ): Promise<CompletionResult> => {
      calls.push(params);
      return {
        content: answer,
        tokensUsed: 100,
        model: "m",
        providerType: "codex",
        finishReason: "stop",
      };
    },
  } as unknown as AIProvider;
}

function pick(provider: AIProvider, pdfSupported = false): DocumentVisionPick {
  return {
    entry: { instance: provider, providerType: "codex" },
    providerType: "codex",
    pdfSupported,
  } as unknown as DocumentVisionPick;
}

const document = {
  id: "doc1",
  kind: "LAB_RESULT",
  contentEncrypted: new Uint8Array([1]),
  contentCodec: "binary2",
  mimeType: "application/pdf",
  status: "STORED",
  aiReadDeferred: false,
};
const budget = {
  reserved: 1500,
  owner: "user" as const,
  dateKey: "2026-11-03",
};
const origin = { ipAddress: null, worker: true };

const FACTS = JSON.stringify({
  reportDate: "2026-10-30",
  kind: "OTHER",
  facts: [
    {
      type: "OBSERVATION",
      label: "Haemoglobin",
      code: null,
      codeSystem: null,
      clinicalStatus: null,
      verificationStatus: null,
      value: 14.2,
      valueText: null,
      unit: "g/dl",
      referenceText: "13.5 - 17.5",
      referenceLow: 13.5,
      referenceHigh: 17.5,
      dose: null,
      medicationStatus: null,
      effectiveDate: null,
      sourceText: LAB_LINE,
      page: 0,
      confidence: 0.95,
    },
  ],
});

/** Everything a call carried, as one string. */
const wire = (params: CompletionParams) => JSON.stringify(params);

function stored(bytes: Buffer) {
  vi.mocked(decryptDocumentContent).mockReturnValue(bytes as never);
}

beforeEach(() => {
  stagedFacts = [];
  stagedIncomplete = null;
  vi.mocked(upsertContentIndex).mockClear();
  vi.mocked(recordIndexAttempt).mockClear();
});

describe("on a server that cannot render PDF pages", () => {
  beforeAll(() => {
    process.env.NATIVE_CANVAS = "off";
    __resetNativeCanvasSupportForTests();
  });
  afterAll(() => {
    delete process.env.NATIVE_CANVAS;
    __resetNativeCanvasSupportForTests();
  });

  describe("extract", () => {
    it("reads the text layer, sends the provider text and no image, and stages an anchored fact", async () => {
      stored(pdfWith(1, 0));
      const calls: CompletionParams[] = [];
      const outcome = await executeDocumentExtract({
        userId: "u1",
        document,
        input: { mode: "vision", pick: pick(recording(calls, FACTS)), budget },
        origin,
      });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      expect(calls).toHaveLength(1);
      expect(wire(calls[0])).toContain(LAB_LINE);
      expect(wire(calls[0])).not.toContain("image/jpeg");
      expect(wire(calls[0])).not.toContain("application/pdf");
      expect(stagedFacts).toHaveLength(1);
      expect(JSON.stringify(stagedFacts)).toContain('"anchored":true');
      expect(stagedIncomplete).toBe(false);
    }, 30_000);

    it("marks the extraction incomplete when pages of the PDF are scans", async () => {
      stored(pdfWith(1, 2));
      const outcome = await executeDocumentExtract({
        userId: "u1",
        document,
        input: { mode: "vision", pick: pick(recording([], FACTS)), budget },
        origin,
      });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      expect(stagedIncomplete).toBe(true);
    }, 30_000);

    it("answers a scan with pdfRendererUnavailable and calls no provider", async () => {
      stored(pdfWith(0, 1));
      const calls: CompletionParams[] = [];
      const outcome = await executeDocumentExtract({
        userId: "u1",
        document,
        input: { mode: "vision", pick: pick(recording(calls, FACTS)), budget },
        origin,
      });
      expect(outcome).toMatchObject({
        ok: false,
        status: 422,
        errorCode: "documents.inbound.pdfRendererUnavailable",
      });
      expect(calls).toHaveLength(0);
    }, 30_000);

    it("sends the PDF whole to a provider that takes PDFs", async () => {
      stored(pdfWith(0, 1));
      const calls: CompletionParams[] = [];
      const outcome = await executeDocumentExtract({
        userId: "u1",
        document,
        input: {
          mode: "vision",
          pick: pick(recording(calls, FACTS), true),
          budget,
        },
        origin,
      });
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      expect(wire(calls[0])).toContain("application/pdf");
    }, 30_000);
  });

  it("suggest sends the provider the text layer", async () => {
    stored(pdfWith(1, 0));
    const calls: CompletionParams[] = [];
    const outcome = await executeDocumentSuggest({
      userId: "u1",
      document,
      input: {
        mode: "vision",
        pick: pick(
          recording(
            calls,
            '{"title":"Blood count","kind":"LAB_RESULT","documentDate":null}',
          ),
        ),
        budget,
      },
      origin,
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(wire(calls[0])).toContain(LAB_LINE);
    expect(wire(calls[0])).not.toContain("image/jpeg");
  }, 30_000);

  it("suggest answers a scan with pdfRendererUnavailable", async () => {
    stored(pdfWith(0, 1));
    const outcome = await executeDocumentSuggest({
      userId: "u1",
      document,
      input: { mode: "vision", pick: pick(recording([], "{}")), budget },
      origin,
    });
    expect(outcome).toMatchObject({
      ok: false,
      errorCode: "documents.inbound.pdfRendererUnavailable",
    });
  }, 30_000);

  it("summary sends the provider the text layer", async () => {
    stored(pdfWith(1, 0));
    const calls: CompletionParams[] = [];
    const outcome = await executeDocumentSummary({
      userId: "u1",
      document,
      input: {
        mode: "vision",
        pick: pick(recording(calls, "A blood count from October.")),
        budget,
      },
      output: "summary",
      locale: "en",
      persist: null,
      origin,
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(wire(calls[0])).toContain(LAB_LINE);
    expect(wire(calls[0])).not.toContain("image/jpeg");
  }, 30_000);

  it("Read with AI indexes the text layer locally, with no provider call", async () => {
    stored(pdfWith(1, 0));
    const calls: CompletionParams[] = [];
    const outcome = await executeDocumentIndex({
      userId: "u1",
      document,
      input: { mode: "vision", pick: pick(recording(calls, "x")), budget },
      origin,
    });
    expect(outcome).toMatchObject({ ok: true, data: { indexed: true } });
    expect(calls).toHaveLength(0);
    expect(upsertContentIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "local-pdf",
        text: expect.stringContaining(LAB_LINE),
      }),
    );
  }, 30_000);

  it("Read with AI answers a scan with pdfRendererUnavailable and records why", async () => {
    stored(pdfWith(0, 1));
    const outcome = await executeDocumentIndex({
      userId: "u1",
      document,
      input: { mode: "vision", pick: pick(recording([], "x")), budget },
      origin,
    });
    expect(outcome).toMatchObject({
      ok: false,
      status: 422,
      errorCode: "documents.inbound.pdfRendererUnavailable",
    });
    expect(recordIndexAttempt).toHaveBeenCalledWith("u1", "doc1", {
      indexed: false,
      reason: "pdf-needs-anthropic",
    });
  }, 30_000);
});

describe("on a server that renders PDF pages", () => {
  beforeAll(() => {
    process.env.NATIVE_CANVAS = "on";
    __resetNativeCanvasSupportForTests();
  });
  afterAll(() => {
    delete process.env.NATIVE_CANVAS;
    __resetNativeCanvasSupportForTests();
  });

  it("extract sends the rendered page as an image, as before", async () => {
    stored(pdfWith(1, 0));
    const calls: CompletionParams[] = [];
    const outcome = await executeDocumentExtract({
      userId: "u1",
      document,
      input: { mode: "vision", pick: pick(recording(calls, FACTS)), budget },
      origin,
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(wire(calls[0])).toContain("image/jpeg");
  }, 60_000);

  it("extract reports a PDF that will not render as a render failure", async () => {
    stored(Buffer.from("%PDF-1.4\nnot a pdf"));
    const outcome = await executeDocumentExtract({
      userId: "u1",
      document,
      input: { mode: "vision", pick: pick(recording([], FACTS)), budget },
      origin,
    });
    expect(outcome).toMatchObject({
      ok: false,
      status: 422,
      errorCode: "documents.inbound.extractFailed",
      message: "The PDF pages couldn't be rendered for scanning.",
    });
  }, 60_000);
});
