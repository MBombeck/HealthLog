/**
 * A long lab report through the document extraction (Documents → a document →
 * Extract lab values), against a provider that behaves like a model with an
 * output ceiling: it transcribes every line it was given and stops at
 * `maxTokens`, reporting `finishReason: "length"`.
 *
 * The lab scan learned to read such a report in parts; the document
 * extraction kept sending the whole text in one call, so the answer was cut,
 * the JSON did not parse, and the read failed as "Couldn't read the document.
 * Try a clearer copy." These cases hold the document path to the same reads.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/lib/documents/ai-route-support", () => ({
  refundDocumentAiSlot: vi.fn(async () => undefined),
}));
vi.mock("@/lib/documents/store", () => ({
  decryptDocumentContent: vi.fn(),
  encryptFactData: (d: unknown) => d,
  encryptFactProvenance: (p: unknown) => p,
}));

/** What the staging transaction wrote, read back as the document's facts. */
let stagedFacts: unknown[] = [];
vi.mock("@/lib/db", () => {
  const tx = {
    $queryRaw: async () => [{ status: "STORED" }],
    extractedFact: {
      count: async () => 0,
      deleteMany: async () => ({ count: 0 }),
    },
    inboundDocument: {
      update: async ({ data }: { data: { facts: { create: unknown[] } } }) => {
        stagedFacts = data.facts.create;
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
    },
  };
});

import {
  DOCUMENT_TEXT_FENCE_END,
  DOCUMENT_TEXT_FENCE_START,
} from "@/lib/ai/coach/data-fence";
import type {
  AIProvider,
  CompletionParams,
  CompletionResult,
} from "@/lib/ai/types";
import { executeDocumentExtract } from "@/lib/documents/ai-runs/extract-run";
import type { DocumentTextPick } from "@/lib/documents/ai-runs/run-support";

/** A lab line as a report's text layer carries it. */
function reportLine(i: number): string {
  return `Analyt ${String(i).padStart(3, "0")}    ${(i % 17) + 1},${i % 10}    mg/dl    ${i % 5} - ${(i % 5) + 20}`;
}

/** A multi-page lab report: one reading per line. */
function longReport(lines: number): string {
  return Array.from({ length: lines }, (_, i) => reportLine(i + 1)).join("\n");
}

/** The fenced document text of a completion's user turn. */
function fencedText(params: CompletionParams): string {
  const user = params.messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
  const start = user.indexOf(DOCUMENT_TEXT_FENCE_START);
  const end = user.lastIndexOf(DOCUMENT_TEXT_FENCE_END);
  if (start < 0 || end < 0) return "";
  return user.slice(start + DOCUMENT_TEXT_FENCE_START.length, end);
}

/** About four characters to a token, as for the European text of a report. */
const CHARS_PER_TOKEN = 4;

/**
 * A model that transcribes every report line it is given into one fact and
 * stops at the call's output ceiling, mid-fact if that is where it falls.
 */
function ceilingModel(calls: CompletionParams[]): AIProvider {
  return {
    generateCompletion: async (
      params: CompletionParams,
    ): Promise<CompletionResult> => {
      calls.push(params);
      const facts = fencedText(params)
        .split("\n")
        .filter((l) => l.startsWith("Analyt "))
        .map((line) => {
          const [label, value, unit] = line.split(/\s{4}/);
          return {
            type: "OBSERVATION",
            label,
            code: null,
            codeSystem: null,
            clinicalStatus: null,
            verificationStatus: null,
            value: Number(value.replace(",", ".")),
            valueText: null,
            unit,
            referenceText: null,
            referenceLow: null,
            referenceHigh: null,
            dose: null,
            medicationStatus: null,
            effectiveDate: "2026-09-30",
            sourceText: line,
            page: null,
            confidence: 0.95,
          };
        });
      const json = JSON.stringify(
        { reportDate: "2026-09-30", kind: "OTHER", facts },
        null,
        1,
      );
      const ceiling = (params.maxTokens ?? 0) * CHARS_PER_TOKEN;
      const cut = json.length > ceiling;
      return {
        content: cut ? json.slice(0, ceiling) : json,
        tokensUsed: Math.ceil(Math.min(json.length, ceiling) / CHARS_PER_TOKEN),
        model: "ceiling-model",
        providerType: "local",
        finishReason: cut ? "length" : "stop",
      };
    },
  } as unknown as AIProvider;
}

/** A model whose every answer stops at the ceiling before one fact closes. */
function alwaysCutModel(): AIProvider {
  return {
    generateCompletion: async (): Promise<CompletionResult> => ({
      content:
        '{ "reportDate": "2026-09-30", "kind": "OTHER", "facts": [ { "type": "OBSERVATION", "label": "Analyt 001", "val',
      tokensUsed: 8000,
      model: "cut-model",
      providerType: "local",
      finishReason: "length",
    }),
  } as unknown as AIProvider;
}

function pick(provider: AIProvider): DocumentTextPick {
  return {
    entry: { instance: provider, providerType: "local" },
    providerType: "local",
  } as unknown as DocumentTextPick;
}

const document = {
  id: "doc1",
  kind: "LAB_RESULT",
  contentEncrypted: new Uint8Array(),
  contentCodec: "none",
  mimeType: "application/pdf",
  status: "STORED",
  aiReadDeferred: false,
};

const budget = {
  reserved: 1500,
  owner: "user" as const,
  dateKey: "2026-10-24",
};

function extract(provider: AIProvider, text: string) {
  return executeDocumentExtract({
    userId: "u1",
    document,
    input: { mode: "stored", text, pick: pick(provider), budget },
    origin: { ipAddress: null, worker: true },
  });
}

beforeEach(() => {
  stagedFacts = [];
});

describe("document extraction of a long lab report", () => {
  it("reads a report whose answer outgrows one call's output ceiling, and stages every reading", async () => {
    const calls: CompletionParams[] = [];
    const lines = 150;
    const outcome = await extract(ceilingModel(calls), longReport(lines));

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    // More readings than the old per-document fact cap (120), all staged.
    expect(stagedFacts).toHaveLength(lines);
    // No call was cut: the report went out in parts that each fit.
    expect(calls.length).toBeGreaterThan(1);
  });

  it("answers a read cut before a single fact closed as the output limit, not as an unreadable copy", async () => {
    const outcome = await extract(alwaysCutModel(), longReport(10));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errorCode).toBe("documents.inbound.outputLimit");
    expect(outcome.status).toBe(422);
    expect(outcome.message).not.toMatch(/clearer copy/i);
  });
});
