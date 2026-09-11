import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The AI-first / local-fallback content-index decision tree. Pins: the DOCUMENT
 * provider order drives the pick; a LOCAL pick is always eligible; an EXTERNAL
 * pick is eligible only when the `documentsAutoAiRead` toggle is ON (OFF → the
 * job stays strictly local, never egresses on upload); a text-layer PDF the
 * provider cannot read falls through to local; no provider / budget-out /
 * provider error all fall through to the free local path; decrypt + not-found
 * fail closed. No plaintext is asserted at the upsert boundary (source +
 * ciphertext path is the content-index module's concern, mocked here).
 */

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
// Use the real egress classification — only "local" is non-egress.
vi.mock("@/lib/ai/consent-guard", () => ({
  isExternalDocumentEgress: (providerType: string) => providerType !== "local",
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-07-07"),
  reserveBudget: vi.fn(),
  reconcileSpend: vi.fn().mockResolvedValue(undefined),
  resolveDailyCap: vi.fn(() => 1000),
  resolveDailyCapFor: vi.fn(() => 1000),
  resolveCostOwner: vi.fn(() => "operator" as const),
}));
vi.mock("@/lib/ai/ai-budgets", () => ({
  AI_BUDGETS: { documentTranscribe: { temperature: 0, maxTokens: 4000 } },
}));

import { indexDocumentContent } from "../index-document";
import {
  loadOwnedDocument,
  prepareVisionInput,
} from "@/lib/documents/ai-route-support";
import { upsertContentIndex } from "@/lib/documents/content-index";
import { transcribeDocument } from "@/lib/documents/describe";
import { documentAutoReadEnabled } from "@/lib/documents/document-settings";
import { localExtractText } from "@/lib/documents/local-extract";
import { decryptDocumentContent } from "@/lib/documents/store";
import { resolveDocumentVisionProvider } from "@/lib/documents/provider-order";
import { reserveBudget, reconcileSpend } from "@/lib/ai/coach/budget";

const DOC = {
  id: "doc-1",
  kind: "OTHER",
  contentEncrypted: new Uint8Array([1, 2, 3]),
  contentCodec: "binary2",
  mimeType: "application/pdf",
  status: "STORED",
};

/** An EXTERNAL (Anthropic) document pick — egress, so toggle-gated. */
const PICK = {
  chain: [{ providerType: "anthropic", instance: {} }],
  pick: {
    entry: { providerType: "anthropic", instance: {} },
    providerType: "anthropic",
    pdfSupported: true,
  },
};

/** A LOCAL (self-hosted) document pick — never egresses, toggle-independent. */
const LOCAL_PICK = {
  chain: [{ providerType: "local", instance: {} }],
  pick: {
    entry: { providerType: "local", instance: {} },
    providerType: "local",
    pdfSupported: false,
  },
};

function visionOk() {
  vi.mocked(prepareVisionInput).mockReturnValue({
    ok: true,
    images: [],
    documents: [{ mediaType: "application/pdf", dataBase64: "AA==" }],
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadOwnedDocument).mockResolvedValue(DOC as never);
  vi.mocked(reserveBudget).mockResolvedValue({
    allowed: true,
    reserved: 1,
    owner: "operator",
  } as never);
  vi.mocked(localExtractText).mockResolvedValue({
    ok: true,
    text: "glucose fasting creatinine values report",
    source: "local-pdf",
  } as never);
  // Default: the auto-read toggle is ON (so the external-pick provider path is
  // exercised); the OFF-specific tests override this explicitly.
  vi.mocked(documentAutoReadEnabled).mockResolvedValue(true);
});

describe("indexDocumentContent — provider-first path", () => {
  it("indexes via an external provider (vision) when configured + toggle ON", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue(PICK as never);
    visionOk();
    vi.mocked(transcribeDocument).mockResolvedValue({
      text: "haemoglobin 14.2 cholesterol 190",
    } as never);

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toEqual({ indexed: true, source: "vision", tokenCount: 5 });
    expect(transcribeDocument).toHaveBeenCalledTimes(1);
    expect(upsertContentIndex).toHaveBeenCalledWith(
      expect.objectContaining({ source: "vision", providerType: "anthropic" }),
    );
    // Budget reserved then reconciled at the full reserved amount (charged).
    expect(reconcileSpend).toHaveBeenCalledWith(
      "user-1",
      1,
      1,
      "2026-07-07",
      0,
      { servedBy: expect.any(String), reservedOwner: "operator" },
    );
    // The local path is never touched when the provider succeeds.
    expect(localExtractText).not.toHaveBeenCalled();
  });

  it("runs a LOCAL vision pick even when the toggle is OFF (no egress)", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue(
      LOCAL_PICK as never,
    );
    vi.mocked(documentAutoReadEnabled).mockResolvedValue(false);
    visionOk();
    vi.mocked(transcribeDocument).mockResolvedValue({
      text: "haemoglobin 14.2 cholesterol 190",
    } as never);

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toEqual({ indexed: true, source: "vision", tokenCount: 5 });
    expect(transcribeDocument).toHaveBeenCalledTimes(1);
    expect(upsertContentIndex).toHaveBeenCalledWith(
      expect.objectContaining({ source: "vision", providerType: "local" }),
    );
    expect(localExtractText).not.toHaveBeenCalled();
  });
});

describe("indexDocumentContent — local fallback path", () => {
  it("falls back to local when NO provider is configured", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue({
      chain: [],
      pick: null,
    } as never);

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toEqual({
      indexed: true,
      source: "local-pdf",
      tokenCount: 5,
    });
    expect(transcribeDocument).not.toHaveBeenCalled();
    expect(upsertContentIndex).toHaveBeenCalledWith(
      expect.objectContaining({ source: "local-pdf", providerType: null }),
    );
  });

  it("stays LOCAL for an external pick when the toggle is OFF (never egresses)", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue(PICK as never);
    vi.mocked(documentAutoReadEnabled).mockResolvedValue(false);

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toMatchObject({ indexed: true, source: "local-pdf" });
    // No egress, no budget reservation, no provider call on the OFF path.
    expect(prepareVisionInput).not.toHaveBeenCalled();
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(transcribeDocument).not.toHaveBeenCalled();
  });

  it("falls back to local when the provider cannot read the PDF", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue(PICK as never);
    vi.mocked(prepareVisionInput).mockReturnValue({
      ok: false,
      reason: "pdfNeedsAnthropic",
    } as never);

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toMatchObject({ indexed: true, source: "local-pdf" });
    expect(reserveBudget).not.toHaveBeenCalled();
    expect(transcribeDocument).not.toHaveBeenCalled();
  });

  it("falls back to local when the daily budget is exhausted", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue(PICK as never);
    visionOk();
    vi.mocked(reserveBudget).mockResolvedValue({
      allowed: false,
      reserved: 0,
    } as never);

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toMatchObject({ indexed: true, source: "local-pdf" });
    expect(transcribeDocument).not.toHaveBeenCalled();
  });

  it("refunds and falls back to local when the provider call throws", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue(PICK as never);
    visionOk();
    vi.mocked(transcribeDocument).mockRejectedValueOnce(new Error("boom"));

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toMatchObject({ indexed: true, source: "local-pdf" });
    // Reservation refunded to zero spend.
    expect(reconcileSpend).toHaveBeenCalledWith(
      "user-1",
      1,
      0,
      "2026-07-07",
      0,
      { servedBy: null, reservedOwner: "operator" },
    );
    expect(localExtractText).toHaveBeenCalledTimes(1);
  });

  it("reports local-empty for a scanned PDF with no usable provider", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue({
      chain: [],
      pick: null,
    } as never);
    vi.mocked(localExtractText).mockResolvedValue({
      ok: false,
      reason: "empty",
    } as never);

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toEqual({ indexed: false, reason: "local-empty" });
    expect(upsertContentIndex).not.toHaveBeenCalled();
  });
});

describe("indexDocumentContent — fail-closed", () => {
  it("returns not-found for an unknown / non-owned document", async () => {
    vi.mocked(loadOwnedDocument).mockResolvedValue(null as never);
    const outcome = await indexDocumentContent("user-1", "missing");
    expect(outcome).toEqual({ indexed: false, reason: "not-found" });
    expect(resolveDocumentVisionProvider).not.toHaveBeenCalled();
  });

  it("fails closed to decrypt-error when local decryption throws", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue({
      chain: [],
      pick: null,
    } as never);
    vi.mocked(decryptDocumentContent).mockImplementationOnce(() => {
      throw new Error("bad key");
    });

    const outcome = await indexDocumentContent("user-1", "doc-1");
    expect(outcome).toEqual({ indexed: false, reason: "decrypt-error" });
    expect(upsertContentIndex).not.toHaveBeenCalled();
  });
});
