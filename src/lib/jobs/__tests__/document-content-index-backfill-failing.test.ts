/**
 * #1279 — the content-index backfill against a provider that fails every
 * call (a model that reasons and never answers). Its cap counted indexed
 * documents only, so a provider that never answered never reached it, and
 * the walk transcribed every un-indexed document in turn until the job's
 * time ran out. It now stops after a few failures in a row, counts calls
 * against the cap, and charges what the failed replies reported spending.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const transcribeDocument = vi.fn();
const reconcileSpend = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: {
      findMany: (...a: unknown[]) => findMany(...a),
      findFirst: async (args: { where: { id: string } }) => ({
        id: args.where.id,
        kind: "OTHER",
        contentEncrypted: new Uint8Array([1, 2, 3]),
        contentCodec: "binary2",
        mimeType: "image/png",
        status: "STORED",
      }),
    },
    documentContentIndex: {
      upsert: async () => ({}),
      findMany: async () => [],
      update: async () => ({}),
    },
  },
}));
vi.mock("@/lib/documents/store", () => ({
  decryptDocumentContent: () => Buffer.from([1, 2, 3]),
}));
vi.mock("@/lib/labs/ocr-upload", () => ({
  detectOcrMimeType: () => "image/png",
}));
vi.mock("@/lib/documents/rasterize-pdf", () => ({ rasterizePdf: vi.fn() }));
vi.mock("@/lib/documents/describe", () => ({
  transcribeDocument: (...a: unknown[]) => transcribeDocument(...a),
  DocumentDescribeError: class DocumentDescribeError extends Error {},
}));
vi.mock("@/lib/documents/content-index", () => ({
  upsertContentIndex: async () => ({ tokenCount: 3 }),
  CONTENT_TOKENIZER_VERSION: "1",
  decryptIndexText: () => "decrypted index text",
  tokeniseAndHash: () => ["hash-a"],
}));
vi.mock("@/lib/documents/provider-order", () => ({
  resolveDocumentVisionProvider: async () => ({
    chain: [{ providerType: "openai-compatible", instance: {} }],
    withheld: null,
    pick: {
      entry: { providerType: "openai-compatible", instance: {} },
      providerType: "openai-compatible",
      pdfSupported: true,
    },
  }),
}));
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForJob: async () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  }),
  aiCapabilityForRecord: vi.fn(),
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: () => "2026-10-24",
  reserveBudget: async () => ({ allowed: true, reserved: 3000, owner: "user" }),
  reconcileSpend: (...a: unknown[]) => reconcileSpend(...a),
  resolveDailyCap: () => 1_000_000,
  resolveDailyCapFor: () => 1_000_000,
  resolveCostOwner: () => "user",
}));
vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: vi.fn() }));
vi.mock("@/lib/ai/capabilities/egress", () => ({
  aiEgressRefusal: vi.fn().mockResolvedValue(null),
}));

import {
  BACKFILL_FAILURES_IN_A_ROW,
  runContentIndexBackfillForUser,
} from "../document-content-index-backfill";

/** 120 un-indexed images, served 50 to a page like the real walk asks. */
function seedDocuments(count: number) {
  const ids = Array.from({ length: count }, (_, i) => ({
    id: `d${String(i).padStart(4, "0")}`,
  }));
  findMany.mockImplementation(
    async (args: { take: number; cursor?: { id: string } }) => {
      const start = args.cursor
        ? ids.findIndex((d) => d.id === args.cursor!.id) + 1
        : 0;
      return ids.slice(start, start + args.take);
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  reconcileSpend.mockResolvedValue(undefined);
});

describe("#1279: the content-index backfill and a provider that never answers", () => {
  it("stops after a few failures in a row instead of walking every document", async () => {
    seedDocuments(120);
    transcribeDocument.mockRejectedValue(
      Object.assign(new Error("returned empty content"), {
        httpStatus: 0,
        kind: "reasoning_only",
        tokensUsed: 2700,
      }),
    );

    const result = await runContentIndexBackfillForUser("user-1");

    expect(transcribeDocument).toHaveBeenCalledTimes(
      BACKFILL_FAILURES_IN_A_ROW,
    );
    expect(result).toMatchObject({
      indexed: 0,
      failed: BACKFILL_FAILURES_IN_A_ROW,
      reason: "provider-failing",
    });
    // What each failed reply reported spending stays on the day's ledger.
    for (const call of reconcileSpend.mock.calls) {
      expect(call[2]).toBe(2700);
    }
  });

  it("keeps walking past one document the model cannot read", async () => {
    seedDocuments(5);
    transcribeDocument
      .mockRejectedValueOnce(new Error("unreadable"))
      .mockResolvedValue({ text: "glucose 90" });

    const result = await runContentIndexBackfillForUser("user-1");

    expect(transcribeDocument).toHaveBeenCalledTimes(5);
    expect(result).toMatchObject({ indexed: 4, failed: 1, reason: "ok" });
  });
});
