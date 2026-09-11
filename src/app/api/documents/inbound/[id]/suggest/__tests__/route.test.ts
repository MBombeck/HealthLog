import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Filing-metadata assist (Document vault P2). Pins P2-D2: suggestions ONLY —
 * the route writes nothing (no fact staging, no status flip, no row update) —
 * and 422s cleanly with no provider.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: { findFirst: vi.fn(), update: vi.fn() },
    extractedFact: { deleteMany: vi.fn(), create: vi.fn(), count: vi.fn() },
    documentContentIndex: { upsert: vi.fn() },
    user: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/documents/store", () => ({
  decryptDocumentContent: vi.fn(() => Buffer.from([1, 2, 3])),
}));
vi.mock("@/lib/labs/ocr-upload", () => ({
  detectOcrMimeType: vi.fn(() => "image/png"),
}));
vi.mock("@/lib/documents/assist", () => ({
  runDocumentAssist: vi.fn(),
  DocumentAssistError: class DocumentAssistError extends Error {},
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
  buildDateKey: vi.fn(() => "2026-07-07"),
  reserveBudget: vi.fn().mockResolvedValue({ allowed: true, reserved: 1 }),
  reconcileSpend: vi.fn().mockResolvedValue(undefined),
  resolveDailyCap: vi.fn(() => 1000),
  resolveCostOwner: vi.fn(() => "operator" as const),
}));
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
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
import { resolveDocumentVisionProvider } from "@/lib/documents/provider-order";
import { runDocumentAssist } from "@/lib/documents/assist";

const SESSION_OK = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const visionReq = (id: string) =>
  new NextRequest(
    new URL(`http://localhost/api/documents/inbound/${id}/suggest`),
    {
      method: "POST",
    },
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
    id: "doc-1",
    kind: "OTHER",
    contentEncrypted: new Uint8Array([1, 2, 3]),
    contentCodec: "binary2",
    mimeType: "image/png",
    status: "STORED",
  } as never);
});

describe("POST /api/documents/inbound/[id]/suggest", () => {
  it("422s without a vision provider and writes nothing", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue({
      chain: [],
      pick: null,
    } as never);

    const res = await POST(visionReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.meta?.errorCode).toBe("documents.inbound.providerUnsupported");
    expect(prisma.inboundDocument.update).not.toHaveBeenCalled();
    expect(prisma.extractedFact.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns drafts and never persists them", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue({
      chain: [{ providerType: "anthropic", instance: {} }],
      pick: {
        entry: { providerType: "anthropic", instance: {} },
        providerType: "anthropic",
        pdfSupported: true,
      },
    } as never);
    vi.mocked(runDocumentAssist).mockResolvedValue({
      title: "City Lab — Blood panel",
      kind: "LAB_RESULT",
      documentDate: "2026-06-01",
    } as never);

    const res = await POST(visionReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.suggestions).toEqual({
      title: "City Lab — Blood panel",
      kind: "LAB_RESULT",
      documentDate: "2026-06-01",
    });
    // Writes NOTHING (P2-D2): no fact staging, no status flip, no index write.
    expect(prisma.inboundDocument.update).not.toHaveBeenCalled();
    expect(prisma.extractedFact.deleteMany).not.toHaveBeenCalled();
    expect(prisma.extractedFact.create).not.toHaveBeenCalled();
    expect(prisma.documentContentIndex.upsert).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("404s an unknown document", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue(
      null as never,
    );
    const res = await POST(visionReq("nope") as never, ctx("nope") as never);
    expect(res.status).toBe(404);
  });
});
