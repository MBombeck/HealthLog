import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.25 — optional extraction action.
 *
 * Pins the store-first fix: with NO vision provider configured, extraction
 * 422s on the ENHANCEMENT only — the already-stored document is left intact
 * (no fact-staging transaction, no status flip). This is the inverse of the
 * old behaviour where the absence of a provider blocked the upload itself.
 *
 * STORED mode — `{ mode: "stored" }` structures the document's OWN stored
 * extracted text (its content index) into staged facts: the manual recovery
 * for a skipped/failed automatic staging run. Pins that the stored text is
 * the input (the encrypted original is never touched — no re-upload), that
 * no stored text 422s (`documents.inbound.notIndexed`) before any bucket
 * charge, that the shared document-AI bucket applies, and that the
 * approved-facts re-extraction refusal covers this mode too.
 */

vi.mock("@/lib/db", () => {
  const tx = {
    extractedFact: { deleteMany: vi.fn() },
    inboundDocument: { update: vi.fn(), findUniqueOrThrow: vi.fn() },
  };
  return {
    prisma: {
      inboundDocument: { findFirst: vi.fn(), update: vi.fn() },
      extractedFact: { deleteMany: vi.fn(), count: vi.fn() },
      user: { findUnique: vi.fn() },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      __tx: tx,
    },
  };
});

vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((s: string) => `v1.${s}`),
  decrypt: vi.fn((s: string) => s.replace(/^v1\./u, "")),
}));
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  encryptToBytes: vi.fn(() => new Uint8Array([1])),
  decryptFromBytes: vi.fn(() => "{}"),
}));

vi.mock("@/lib/documents/store", () => ({
  decryptDocumentContent: vi.fn(() => Buffer.from([1, 2, 3])),
  encryptFactData: vi.fn(() => new Uint8Array([1])),
  encryptFactProvenance: vi.fn(() => new Uint8Array([2])),
  serialiseDocumentDetail: vi.fn(() => ({ id: "doc-1", facts: [] })),
}));
vi.mock("@/lib/documents/content-index", () => ({
  loadDocumentChatText: vi.fn(),
}));
vi.mock("@/lib/labs/ocr-upload", () => ({
  detectOcrMimeType: vi.fn(() => "image/png"),
}));

vi.mock("@/lib/documents/provider-order", () => ({
  resolveDocumentVisionProvider: vi.fn(),
  resolveDocumentTextProvider: vi.fn(),
}));
vi.mock("@/lib/ai/consent-guard", () => ({
  assertDocumentEgressConsent: vi.fn().mockResolvedValue(undefined),
  ConsentRequiredError: class ConsentRequiredError extends Error {},
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-06-27"),
  reserveBudget: vi.fn().mockResolvedValue({ allowed: true, reserved: 1 }),
  reconcileSpend: vi.fn().mockResolvedValue(undefined),
  resolveDailyCap: vi.fn(() => 1000),
}));
vi.mock("@/lib/documents/extract", () => ({
  runInboundExtraction: vi.fn(),
  InboundExtractError: class InboundExtractError extends Error {},
}));

vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi
    .fn()
    .mockResolvedValue({ allowed: true, remaining: 5, resetAt: Date.now() }),
  refundRateLimit: vi.fn().mockResolvedValue(undefined),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit } from "@/lib/rate-limit";
import { loadDocumentChatText } from "@/lib/documents/content-index";
import { runInboundExtraction } from "@/lib/documents/extract";
import { decryptDocumentContent } from "@/lib/documents/store";
import {
  resolveDocumentTextProvider,
  resolveDocumentVisionProvider,
} from "@/lib/documents/provider-order";

const tx = (
  prisma as unknown as {
    __tx: {
      extractedFact: { deleteMany: ReturnType<typeof vi.fn> };
      inboundDocument: {
        update: ReturnType<typeof vi.fn>;
        findUniqueOrThrow: ReturnType<typeof vi.fn>;
      };
    };
  }
).__tx;

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function visionReq(id: string): NextRequest {
  // No JSON content-type → vision mode (operates on the stored original).
  return new NextRequest(
    new URL(`http://localhost/api/documents/inbound/${id}/extract`),
    { method: "POST" },
  );
}

function storedReq(id: string): NextRequest {
  return new NextRequest(
    new URL(`http://localhost/api/documents/inbound/${id}/extract`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "stored" }),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true } as never);
  vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
    id: "doc-1",
    kind: "OTHER",
    contentEncrypted: new Uint8Array([1, 2, 3]),
    mimeType: "image/png",
    status: "STORED",
  } as never);
  vi.mocked(prisma.extractedFact.count).mockResolvedValue(0 as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 5,
    resetAt: Date.now() + 60 * 60 * 1000,
  });
});

describe("POST /api/documents/inbound/[id]/extract", () => {
  it("422s without a vision provider and leaves the stored row intact", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue({
      chain: [],
      pick: null,
    } as never);

    const res = await POST(visionReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.meta?.errorCode).toBe("documents.inbound.providerUnsupported");

    // The stored document is untouched — no staging transaction, no flip.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.inboundDocument.update).not.toHaveBeenCalled();
  });

  it("409s and refuses re-extraction when any fact is already APPROVED", async () => {
    // A partially-confirmed document stays at EXTRACTED, so the CONFIRMED gate
    // does not catch it; the approved-fact guard must.
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
      id: "doc-1",
      kind: "OTHER",
      contentEncrypted: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      status: "EXTRACTED",
    } as never);
    vi.mocked(prisma.extractedFact.count).mockResolvedValue(2 as never);

    const res = await POST(visionReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.meta?.errorCode).toBe(
      "documents.inbound.alreadyPartlyConfirmed",
    );

    // No staging transaction, no fact deletion — committed provenance is safe.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.extractedFact.deleteMany).not.toHaveBeenCalled();
  });

  it("404s for a document the caller does not own", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue(
      null as never,
    );
    const res = await POST(
      visionReq("foreign") as never,
      ctx("foreign") as never,
    );
    expect(res.status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("POST /api/documents/inbound/[id]/extract — stored mode", () => {
  beforeEach(() => {
    vi.mocked(loadDocumentChatText).mockResolvedValue({
      text: "Hemoglobin 13.9 g/dL reference range 12-16",
      source: "verbatim",
    } as never);
    vi.mocked(resolveDocumentTextProvider).mockResolvedValue({
      pick: {
        providerType: "anthropic",
        entry: { providerType: "anthropic", instance: {} },
      },
    } as never);
    vi.mocked(runInboundExtraction).mockResolvedValue({
      providerType: "anthropic",
      reportDate: "2026-08-01",
      facts: [
        {
          factType: "OBSERVATION",
          confidence: 0.95,
          needsReview: false,
          data: { label: "Hemoglobin", value: 13.9, unit: "g/dL" },
          provenance: {
            sourceText: "",
            anchored: false,
            sourceOffset: null,
            page: null,
            confidence: 0.95,
          },
        },
      ],
    } as never);
    tx.inboundDocument.findUniqueOrThrow.mockResolvedValue({
      id: "doc-1",
      facts: [{ id: "fact-1" }],
    } as never);
  });

  it("structures the stored text and stages PENDING facts, never touching the original", async () => {
    const res = await POST(storedReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(200);
    // The stored extracted text is the input…
    expect(runInboundExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        ocrText: "Hemoglobin 13.9 g/dL reference range 12-16",
      }),
    );
    // …and the encrypted original is never read — no re-upload, no re-scan.
    expect(decryptDocumentContent).not.toHaveBeenCalled();
    // Staged through the guarded transaction (prior PENDING leftovers cleared,
    // status flipped) — nothing here writes a structured store.
    expect(tx.extractedFact.deleteMany).toHaveBeenCalled();
    expect(tx.inboundDocument.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "EXTRACTED" }),
      }),
    );
    expect(auditLog).toHaveBeenCalledWith(
      "documents.inbound.extract",
      expect.objectContaining({
        details: expect.objectContaining({ mode: "stored" }),
      }),
    );
  });

  it("422s (notIndexed) without stored text, before any bucket charge", async () => {
    vi.mocked(loadDocumentChatText).mockResolvedValue(null as never);
    const res = await POST(storedReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("documents.inbound.notIndexed");
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(runInboundExtraction).not.toHaveBeenCalled();
  });

  it("consumes the shared document-AI bucket honestly", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 30 * 60_000,
    });
    const res = await POST(storedReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(429);
    expect(runInboundExtraction).not.toHaveBeenCalled();
  });

  it("refuses once any fact is APPROVED, like every other extract mode", async () => {
    vi.mocked(prisma.extractedFact.count).mockResolvedValue(1 as never);
    const res = await POST(storedReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(409);
    expect(runInboundExtraction).not.toHaveBeenCalled();
  });
});
