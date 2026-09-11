import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Refs #776 — an index attempt that ends without an index must record why.
 *
 * Before this, a failed attempt (raster fail, empty scan, provider error)
 * left its reason only in wide-events: `hasContentIndex=false` was
 * indistinguishable from "never tried". Pins:
 *
 *   - `indexLoadedDocument` (the choke point the job AND the backfill share)
 *     records every attempt on the row: `lastIndexAttemptAt` always,
 *     `lastIndexOutcome` = the failure reason, or null on success.
 *   - The provider path's specific failure (raster-failed /
 *     pdf-needs-anthropic / provider-error / empty-transcription) survives
 *     the local fallback: when local can only say "no text", the recorded
 *     reason is the provider path's more actionable one.
 *   - An empty provider transcription NEVER becomes a "successful" empty
 *     index — it falls through to local instead.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: { updateMany: vi.fn() },
  },
}));
vi.mock("@/lib/documents/ai-route-support", () => ({
  loadOwnedDocument: vi.fn(),
  prepareVisionInput: vi.fn(),
}));
vi.mock("@/lib/documents/content-index", () => ({
  upsertContentIndex: vi.fn().mockResolvedValue({ tokenCount: 5 }),
}));
vi.mock("@/lib/documents/describe", () => ({
  transcribeDocument: vi.fn(),
}));
vi.mock("@/lib/documents/local-extract", () => ({
  localExtractText: vi.fn(),
}));
vi.mock("@/lib/documents/store", () => ({
  decryptDocumentContent: vi.fn(() => Buffer.from([1, 2, 3])),
}));
vi.mock("@/lib/labs/ocr-upload", () => ({
  detectOcrMimeType: vi.fn(() => "application/pdf"),
}));
vi.mock("@/lib/documents/provider-order", () => ({
  resolveDocumentVisionProvider: vi.fn(),
}));
vi.mock("@/lib/documents/document-settings", () => ({
  documentAutoReadEnabled: vi.fn(),
}));
vi.mock("@/lib/ai/consent-guard", () => ({
  isExternalDocumentEgress: (providerType: string) => providerType !== "local",
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-08-13"),
  reserveBudget: vi.fn(),
  reconcileSpend: vi.fn().mockResolvedValue(undefined),
  resolveDailyCap: vi.fn(() => 1000),
  resolveCostOwner: vi.fn(() => "operator" as const),
}));
vi.mock("@/lib/ai/ai-budgets", () => ({
  AI_BUDGETS: { documentTranscribe: { temperature: 0, maxTokens: 4000 } },
}));

import { indexDocumentContent, recordIndexAttempt } from "../index-document";
import { prisma } from "@/lib/db";
import {
  loadOwnedDocument,
  prepareVisionInput,
} from "@/lib/documents/ai-route-support";
import { upsertContentIndex } from "@/lib/documents/content-index";
import { transcribeDocument } from "@/lib/documents/describe";
import { documentAutoReadEnabled } from "@/lib/documents/document-settings";
import { localExtractText } from "@/lib/documents/local-extract";
import { resolveDocumentVisionProvider } from "@/lib/documents/provider-order";
import { reserveBudget } from "@/lib/ai/coach/budget";

const DOC = {
  id: "doc-1",
  kind: "OTHER",
  contentEncrypted: new Uint8Array([1, 2, 3]),
  contentCodec: "binary2",
  mimeType: "application/pdf",
  status: "STORED",
};

const PICK = {
  chain: [{ providerType: "anthropic", instance: {} }],
  pick: {
    entry: { providerType: "anthropic", instance: {} },
    providerType: "anthropic",
    pdfSupported: true,
  },
};

function visionOk() {
  vi.mocked(prepareVisionInput).mockResolvedValue({
    ok: true,
    images: [],
    documents: [{ mediaType: "application/pdf", dataBase64: "AA==" }],
  } as never);
}

function localEmpty() {
  vi.mocked(localExtractText).mockResolvedValue({
    ok: false,
    reason: "empty",
  } as never);
}

function lastRecordedOutcome(): unknown {
  const calls = vi.mocked(prisma.inboundDocument.updateMany).mock.calls;
  const withOutcome = calls.filter(
    ([arg]) => arg.data && "lastIndexOutcome" in (arg.data as object),
  );
  const last = withOutcome[withOutcome.length - 1];
  return last ? (last[0].data as { lastIndexOutcome: unknown }) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadOwnedDocument).mockResolvedValue(DOC as never);
  vi.mocked(documentAutoReadEnabled).mockResolvedValue(true);
  vi.mocked(resolveDocumentVisionProvider).mockResolvedValue(PICK as never);
  vi.mocked(reserveBudget).mockResolvedValue({
    allowed: true,
    reserved: 1,
  } as never);
  vi.mocked(localExtractText).mockResolvedValue({
    ok: true,
    text: "glucose fasting creatinine values report",
    source: "local-pdf",
  } as never);
  vi.mocked(prisma.inboundDocument.updateMany).mockResolvedValue({
    count: 1,
  } as never);
});

describe("recordIndexAttempt — the row-level writer", () => {
  it("records a failure reason with the attempt instant, owner-scoped", async () => {
    await recordIndexAttempt("user-1", "doc-1", {
      indexed: false,
      reason: "local-empty",
    });
    expect(prisma.inboundDocument.updateMany).toHaveBeenCalledWith({
      where: { id: "doc-1", userId: "user-1", deletedAt: null },
      data: {
        lastIndexAttemptAt: expect.any(Date),
        lastIndexOutcome: "local-empty",
      },
    });
  });

  it("clears the outcome on a successful attempt (the index row is the success signal)", async () => {
    await recordIndexAttempt("user-1", "doc-1", {
      indexed: true,
      source: "vision",
      tokenCount: 5,
    });
    expect(prisma.inboundDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastIndexOutcome: null }),
      }),
    );
  });

  it("writes nothing for not-found (no row to explain) and never throws", async () => {
    await recordIndexAttempt("user-1", "missing", {
      indexed: false,
      reason: "not-found",
    });
    expect(prisma.inboundDocument.updateMany).not.toHaveBeenCalled();

    vi.mocked(prisma.inboundDocument.updateMany).mockRejectedValueOnce(
      new Error("db down"),
    );
    await expect(
      recordIndexAttempt("user-1", "doc-1", {
        indexed: false,
        reason: "local-empty",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("indexDocumentContent — the attempt record at the choke point", () => {
  it("records the outcome on failure (job + backfill share this path)", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue({
      chain: [],
      pick: null,
    } as never);
    localEmpty();

    await indexDocumentContent("user-1", "doc-1");
    expect(lastRecordedOutcome()).toMatchObject({
      lastIndexOutcome: "local-empty",
    });
  });

  it("records a cleared outcome on success", async () => {
    visionOk();
    vi.mocked(transcribeDocument).mockResolvedValue({
      text: "haemoglobin 14.2 cholesterol 190",
    } as never);

    await indexDocumentContent("user-1", "doc-1");
    expect(lastRecordedOutcome()).toMatchObject({ lastIndexOutcome: null });
  });
});

describe("indexDocumentContent — the provider path's reason survives the local fallback", () => {
  it("provider-error: the provider threw and local had no text", async () => {
    visionOk();
    vi.mocked(transcribeDocument).mockRejectedValueOnce(new Error("boom"));
    localEmpty();

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toEqual({ indexed: false, reason: "provider-error" });
  });

  it("raster-failed: the PDF could not be rendered and local had no text", async () => {
    vi.mocked(prepareVisionInput).mockResolvedValue({
      ok: false,
      reason: "rasterFailed",
    } as never);
    localEmpty();

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toEqual({ indexed: false, reason: "raster-failed" });
  });

  it("pdf-needs-anthropic: the provider cannot read PDFs and local had no text", async () => {
    vi.mocked(prepareVisionInput).mockResolvedValue({
      ok: false,
      reason: "pdfNeedsAnthropic",
    } as never);
    localEmpty();

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toEqual({ indexed: false, reason: "pdf-needs-anthropic" });
  });

  it("a plain local failure keeps its own reason when the provider path had none", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue({
      chain: [],
      pick: null,
    } as never);
    localEmpty();

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toEqual({ indexed: false, reason: "local-empty" });
  });
});

describe("indexDocumentContent — the empty-transcription guard", () => {
  it("an empty provider answer NEVER becomes a successful empty index", async () => {
    visionOk();
    vi.mocked(transcribeDocument).mockResolvedValue({ text: "   " } as never);
    localEmpty();

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toEqual({
      indexed: false,
      reason: "empty-transcription",
    });
    expect(upsertContentIndex).not.toHaveBeenCalled();
  });

  it("an empty provider answer still lands the LOCAL text when there is one", async () => {
    visionOk();
    vi.mocked(transcribeDocument).mockResolvedValue({ text: "" } as never);

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toMatchObject({ indexed: true, source: "local-pdf" });
    expect(upsertContentIndex).toHaveBeenCalledWith(
      expect.objectContaining({ source: "local-pdf" }),
    );
  });
});
