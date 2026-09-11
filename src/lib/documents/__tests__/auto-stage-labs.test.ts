import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S8 — auto-stage lab facts after the auto-index job. Pins Marc's sign-off
 * (auto-STAGE, never auto-COMMIT), the double module gate, the reuse of the
 * auto-index consent gate, the "looks like a lab" heuristic, idempotency (a
 * non-STORED or already-staged document is left alone), and the guarded
 * STORED→EXTRACTED transition that makes the S9 cross-link race-safe. No
 * LabResult is ever written here — the facts land PENDING for human review.
 */

vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: vi.fn(),
}));
vi.mock("@/lib/documents/index-document", () => ({
  resolveIndexProvider: vi.fn(),
}));
vi.mock("@/lib/documents/content-index", () => ({
  loadDocumentChatText: vi.fn(),
}));
vi.mock("@/lib/documents/extract", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/documents/extract")
  >("@/lib/documents/extract");
  return { ...actual, runInboundExtraction: vi.fn() };
});
vi.mock("@/lib/documents/store", () => ({
  encryptFactData: vi.fn(() => new Uint8Array([1])),
  encryptFactProvenance: vi.fn(() => new Uint8Array([2])),
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-07-16"),
  reserveBudget: vi.fn(),
  reconcileSpend: vi.fn().mockResolvedValue(undefined),
  resolveDailyCapFor: vi.fn(() => 100_000),
}));
vi.mock("@/lib/ai/ai-budgets", () => ({
  AI_BUDGETS: { ocrExtractText: { temperature: 0, maxTokens: 2000 } },
}));

const updateMany = vi.fn();
const createMany = vi.fn();
const findFirst = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: {
      findFirst: (...a: unknown[]) => findFirst(...a),
    },
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        inboundDocument: { updateMany: (...a: unknown[]) => updateMany(...a) },
        extractedFact: { createMany: (...a: unknown[]) => createMany(...a) },
      }),
  },
}));

import {
  maybeAutoStageLabFacts,
  looksLikeLabDocument,
} from "../auto-stage-labs";
import { isModuleEnabled } from "@/lib/modules/gate";
import { resolveIndexProvider } from "@/lib/documents/index-document";
import { loadDocumentChatText } from "@/lib/documents/content-index";
import { runInboundExtraction } from "@/lib/documents/extract";
import { reserveBudget } from "@/lib/ai/coach/budget";

const mockModule = vi.mocked(isModuleEnabled);
const mockProvider = vi.mocked(resolveIndexProvider);
const mockText = vi.mocked(loadDocumentChatText);
const mockExtract = vi.mocked(runInboundExtraction);
const mockReserve = vi.mocked(reserveBudget);

const LAB_TEXT =
  "Laborbefund. Hämoglobin 14.2 g/dl. Referenzbereich 13-17. LDL 120 mg/dl.";

function eligibleProvider() {
  return {
    chain: [],
    pick: {
      providerType: "anthropic",
      entry: { providerType: "anthropic", instance: {} },
      pdfSupported: true,
    },
    consentOk: true,
    dailyCap: 1000,
  } as unknown as Awaited<ReturnType<typeof resolveIndexProvider>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockModule.mockResolvedValue(true);
  findFirst.mockResolvedValue({
    kind: "OTHER",
    status: "STORED",
    _count: { facts: 0 },
  });
  mockProvider.mockResolvedValue(eligibleProvider());
  mockText.mockResolvedValue({ text: LAB_TEXT, source: "verbatim" });
  mockReserve.mockResolvedValue({
    allowed: true,
    reserved: 10,
    totalAfter: 10,
    owner: "operator",
    operatorAfter: 10,
  } as Awaited<ReturnType<typeof reserveBudget>>);
  mockExtract.mockResolvedValue({
    reportDate: "2026-07-10",
    kind: "OTHER",
    providerType: "anthropic",
    facts: [
      {
        factType: "OBSERVATION",
        confidence: 0.9,
        needsReview: false,
        data: {
          label: "Hämoglobin",
          code: null,
          codeSystem: null,
          value: 14.2,
          valueText: null,
          unit: "g/dl",
          referenceLow: 13,
          referenceHigh: 17,
          effectiveDate: "2026-07-10",
        },
        provenance: {
          sourceText: "Hämoglobin 14.2",
          anchored: true,
          sourceOffset: 0,
          page: 0,
          confidence: 0.9,
        },
      },
    ],
  });
  updateMany.mockResolvedValue({ count: 1 });
  createMany.mockResolvedValue({ count: 1 });
});

describe("looksLikeLabDocument", () => {
  it("matches a lab report with ≥2 signals", () => {
    expect(looksLikeLabDocument(LAB_TEXT)).toBe(true);
  });
  it("rejects prose with at most one incidental signal", () => {
    expect(
      looksLikeLabDocument("Dear patient, please take 500 mg twice daily."),
    ).toBe(false);
  });
});

describe("maybeAutoStageLabFacts", () => {
  it("stages facts PENDING and never commits when gated in", async () => {
    const res = await maybeAutoStageLabFacts("u1", "d1");
    expect(res).toEqual({ staged: true, facts: 1 });
    // Guarded STORED→EXTRACTED, then PENDING facts — no commit path touched.
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "STORED" }),
        data: expect.objectContaining({ status: "EXTRACTED" }),
      }),
    );
    const created = createMany.mock.calls[0]![0] as {
      data: { status: string }[];
    };
    expect(created.data.every((f) => f.status === "PENDING")).toBe(true);
  });

  it("skips (manual path only) when a module is off", async () => {
    mockModule.mockImplementation(async (_u, key) => key !== "labs");
    const res = await maybeAutoStageLabFacts("u1", "d1");
    expect(res).toEqual({ staged: false, reason: "modules-off" });
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("skips when the auto-read consent gate is not eligible", async () => {
    mockProvider.mockResolvedValue({
      ...eligibleProvider(),
      consentOk: false,
    } as Awaited<ReturnType<typeof resolveIndexProvider>>);
    const res = await maybeAutoStageLabFacts("u1", "d1");
    expect(res).toEqual({ staged: false, reason: "not-eligible" });
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("skips a non-lab document (no extraction call spent)", async () => {
    mockText.mockResolvedValue({
      text: "A short personal note with no clinical content.",
      source: "verbatim",
    });
    const res = await maybeAutoStageLabFacts("u1", "d1");
    expect(res).toEqual({ staged: false, reason: "not-lab" });
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("auto-stages a LAB_RESULT-kind document even without keyword signals", async () => {
    findFirst.mockResolvedValue({
      kind: "LAB_RESULT",
      status: "STORED",
      _count: { facts: 0 },
    });
    mockText.mockResolvedValue({
      text: "opaque scan text",
      source: "verbatim",
    });
    const res = await maybeAutoStageLabFacts("u1", "d1");
    expect(res).toEqual({ staged: true, facts: 1 });
  });

  it("is idempotent — a non-STORED / already-staged document is left alone", async () => {
    findFirst.mockResolvedValue({
      kind: "OTHER",
      status: "EXTRACTED",
      _count: { facts: 1 },
    });
    const res = await maybeAutoStageLabFacts("u1", "d1");
    expect(res).toEqual({ staged: false, reason: "already-handled" });
    expect(mockExtract).not.toHaveBeenCalled();
  });

  it("aborts without touching facts when another writer moved the row (race)", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    const res = await maybeAutoStageLabFacts("u1", "d1");
    expect(res).toEqual({ staged: false, reason: "raced" });
    expect(createMany).not.toHaveBeenCalled();
  });
});
