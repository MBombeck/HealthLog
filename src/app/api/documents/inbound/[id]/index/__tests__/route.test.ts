import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Content-index route (Document vault P2). Pins: vision path transcribes then
 * upserts the index; text path indexes posted OCR text with no provider;
 * provider-gated on vision; only the index sibling is written (never facts).
 *
 * Bucket honesty: the route charges the shared document-AI bucket up front
 * (so a 429 stays cheap) but a slot must reflect work actually performed —
 * a 429 names the reset instant in `meta.retryAt`, a preparation failure
 * before any provider dispatch refunds the charged slot, and a successful
 * dispatch keeps it.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: { findFirst: vi.fn(), update: vi.fn() },
    extractedFact: { create: vi.fn() },
    documentContentIndex: { upsert: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/documents/store", () => ({
  decryptDocumentContent: vi.fn(() => Buffer.from([1, 2, 3])),
}));
vi.mock("@/lib/labs/ocr-upload", () => ({
  detectOcrMimeType: vi.fn(() => "image/png"),
}));
vi.mock("@/lib/documents/describe", () => ({
  transcribeDocument: vi.fn(),
  DocumentDescribeError: class DocumentDescribeError extends Error {},
}));
vi.mock("@/lib/documents/content-index", () => ({
  upsertContentIndex: vi.fn().mockResolvedValue({ tokenCount: 7 }),
}));
vi.mock("@/lib/documents/provider-order", () => ({
  resolveDocumentVisionProvider: vi.fn(),
}));
vi.mock("@/lib/documents/auto-stage-labs", () => ({
  maybeAutoStageLabFacts: vi
    .fn()
    .mockResolvedValue({ staged: false, reason: "not-lab" }),
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
}));
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  refundRateLimit: vi.fn().mockResolvedValue(undefined),
  rateLimitHeaders: (result: { remaining?: number; resetAt?: number }) => ({
    "X-RateLimit-Remaining": String(result.remaining ?? 0),
    "X-RateLimit-Reset": new Date(result.resetAt ?? 0).toISOString(),
  }),
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
import { maybeAutoStageLabFacts } from "@/lib/documents/auto-stage-labs";
import { checkRateLimit, refundRateLimit } from "@/lib/rate-limit";
import { reserveBudget } from "@/lib/ai/coach/budget";
import { resolveDocumentVisionProvider } from "@/lib/documents/provider-order";
import { decryptDocumentContent } from "@/lib/documents/store";
import { transcribeDocument } from "@/lib/documents/describe";
import { upsertContentIndex } from "@/lib/documents/content-index";

const SESSION_OK = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const visionReq = (id: string) =>
  new NextRequest(
    new URL(`http://localhost/api/documents/inbound/${id}/index`),
    {
      method: "POST",
    },
  );
const textReq = (id: string, text: string) =>
  new NextRequest(
    new URL(`http://localhost/api/documents/inbound/${id}/index`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "text", text }),
    },
  );

const PICK = {
  chain: [{ providerType: "anthropic", instance: {} }],
  pick: {
    entry: { providerType: "anthropic", instance: {} },
    providerType: "anthropic",
    pdfSupported: true,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 5,
    resetAt: Date.now() + 60 * 60 * 1000,
  });
  vi.mocked(reserveBudget).mockResolvedValue({
    allowed: true,
    reserved: 1,
  } as never);
  vi.mocked(decryptDocumentContent).mockReturnValue(
    Buffer.from([1, 2, 3]) as never,
  );
  vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
    id: "doc-1",
    kind: "OTHER",
    contentEncrypted: new Uint8Array([1, 2, 3]),
    contentCodec: "binary2",
    mimeType: "image/png",
    status: "STORED",
  } as never);
});

describe("POST /api/documents/inbound/[id]/index", () => {
  it("vision: transcribes then upserts the index, never facts", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue(PICK as never);
    vi.mocked(transcribeDocument).mockResolvedValue({
      text: "hemoglobin 14.2 leukocytes normal",
    } as never);

    const res = await POST(visionReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      documentId: "doc-1",
      indexed: true,
      tokenCount: 7,
    });
    expect(upsertContentIndex).toHaveBeenCalledWith(
      expect.objectContaining({ source: "vision", documentId: "doc-1" }),
    );
    expect(prisma.extractedFact.create).not.toHaveBeenCalled();
    expect(prisma.inboundDocument.update).not.toHaveBeenCalled();
  });

  it("vision: 422 without a provider", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue({
      chain: [],
      pick: null,
    } as never);
    const res = await POST(visionReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(422);
    expect(upsertContentIndex).not.toHaveBeenCalled();
  });

  it("text: indexes posted OCR text with no provider egress", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      labsLocalOcrEnabled: true,
    } as never);

    const res = await POST(
      textReq("doc-1", "cholesterol total 190 mg dl") as never,
      ctx("doc-1") as never,
    );
    expect(res.status).toBe(200);
    expect(upsertContentIndex).toHaveBeenCalledWith(
      expect.objectContaining({ source: "text-ocr", providerType: null }),
    );
    // No provider was resolved on the text path.
    expect(resolveDocumentVisionProvider).not.toHaveBeenCalled();
  });

  it("text: 422 when local OCR is not enabled", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      labsLocalOcrEnabled: false,
    } as never);
    const res = await POST(
      textReq("doc-1", "some text") as never,
      ctx("doc-1") as never,
    );
    expect(res.status).toBe(422);
    expect(upsertContentIndex).not.toHaveBeenCalled();
  });
});

describe("POST /api/documents/inbound/[id]/index — bucket honesty", () => {
  beforeEach(() => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue(PICK as never);
    vi.mocked(transcribeDocument).mockResolvedValue({
      text: "hemoglobin 14.2 leukocytes normal",
    } as never);
  });

  it("returns 429 with the reset instant in meta.retryAt when the bucket is exhausted", async () => {
    const resetAt = Date.now() + 47 * 60_000;
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt,
    });
    const res = await POST(visionReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      meta?: { errorCode?: string; retryAt?: string };
    };
    expect(body.meta?.errorCode).toBe("documents.inbound.rateLimited");
    expect(body.meta?.retryAt).toBe(new Date(resetAt).toISOString());
    expect(refundRateLimit).not.toHaveBeenCalled();
  });

  it("refunds the charged slot when input preparation fails before dispatch", async () => {
    vi.mocked(decryptDocumentContent).mockImplementation(() => {
      throw new Error("bad codec");
    });
    const res = await POST(visionReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(422);
    expect(refundRateLimit).toHaveBeenCalledTimes(1);
    expect(refundRateLimit).toHaveBeenCalledWith("documents-inbound:user-1");
    expect(transcribeDocument).not.toHaveBeenCalled();
  });

  it("refunds the charged slot when the daily budget refuses before dispatch", async () => {
    vi.mocked(reserveBudget).mockResolvedValue({
      allowed: false,
      reserved: 0,
    } as never);
    const res = await POST(visionReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("documents.inbound.budgetExceeded");
    expect(refundRateLimit).toHaveBeenCalledTimes(1);
    expect(transcribeDocument).not.toHaveBeenCalled();
  });

  it("keeps the slot once the provider was actually dispatched", async () => {
    const res = await POST(visionReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(200);
    expect(transcribeDocument).toHaveBeenCalledTimes(1);
    expect(refundRateLimit).not.toHaveBeenCalled();
  });
});

describe("POST /api/documents/inbound/[id]/index — staging continuation", () => {
  beforeEach(() => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue(PICK as never);
    vi.mocked(transcribeDocument).mockResolvedValue({
      text: "hemoglobin 14.2 reference range 12-16",
    } as never);
  });

  it("a manual read continues into the same lab staging the auto worker performs", async () => {
    vi.mocked(maybeAutoStageLabFacts).mockResolvedValue({
      staged: true,
      facts: 4,
    } as never);
    const res = await POST(visionReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(200);
    expect(maybeAutoStageLabFacts).toHaveBeenCalledWith("user-1", "doc-1");
    const body = await res.json();
    expect(body.data.labFactsStaged).toBe(4);
  });

  it("reports zero staged facts as an honest zero, never an error", async () => {
    vi.mocked(maybeAutoStageLabFacts).mockResolvedValue({
      staged: false,
      reason: "not-lab",
    } as never);
    const res = await POST(visionReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.labFactsStaged).toBe(0);
  });

  it("a staging failure never fails the index that just succeeded", async () => {
    vi.mocked(maybeAutoStageLabFacts).mockRejectedValue(new Error("boom"));
    const res = await POST(visionReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ indexed: true, labFactsStaged: 0 });
  });

  it("does not reach staging when the index itself was refused", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await POST(visionReq("doc-1") as never, ctx("doc-1") as never);
    expect(res.status).toBe(429);
    expect(maybeAutoStageLabFacts).not.toHaveBeenCalled();
  });
});
