import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * On-demand summary / extracted text (Document vault P2).
 *
 * `mode=text` stays session-only (P2-D4 / A3): the only persistent side effects
 * are the AI-budget ledger and the audit log. `mode=summary` additionally stores
 * the summary on the document since v1.30.31 — the user asked for it, and it is
 * the repair path for documents the background job never ran for. Nothing else
 * (index, facts, rows) is ever written, and a WITHHELD summary is never stored
 * as text.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: {
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    extractedFact: { create: vi.fn(), deleteMany: vi.fn() },
    documentContentIndex: { upsert: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/documents/store", () => ({
  decryptDocumentContent: vi.fn(() => Buffer.from([1, 2, 3])),
  encryptDocumentSummary: vi.fn((text: string) =>
    new TextEncoder().encode(`enc:${text}`),
  ),
}));
vi.mock("@/lib/labs/ocr-upload", () => ({
  detectOcrMimeType: vi.fn(() => "image/png"),
}));
vi.mock("@/lib/documents/describe", () => ({
  runDocumentSummary: vi.fn(),
  transcribeDocument: vi.fn(),
  documentSummaryBlockedCopy: () => "The summary was withheld.",
  DocumentDescribeError: class DocumentDescribeError extends Error {},
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
import { auditLog } from "@/lib/auth/audit";
import {
  runDocumentSummary,
  transcribeDocument,
} from "@/lib/documents/describe";

const SESSION_OK = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (
  id: string,
  mode?: string,
  options: { persist?: boolean; replace?: boolean } = {},
) => {
  const query = new URLSearchParams();
  if (mode) query.set("mode", mode);
  if (options.persist) query.set("persist", "true");
  if (options.replace) query.set("replace", "true");
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return new NextRequest(
    new URL(`http://localhost/api/documents/inbound/${id}/summary${suffix}`),
    { method: "POST" },
  );
};

/**
 * Nothing beyond the explicitly requested summary column may be written.
 * Transcription and ordinary action-row summaries stay session-only.
 */
function assertNoPersistence(): void {
  expect(prisma.inboundDocument.update).not.toHaveBeenCalled();
  expect(prisma.documentContentIndex.upsert).not.toHaveBeenCalled();
  expect(prisma.extractedFact.create).not.toHaveBeenCalled();
  expect(prisma.extractedFact.deleteMany).not.toHaveBeenCalled();
}

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
  vi.mocked(prisma.inboundDocument.updateMany).mockResolvedValue({
    count: 1,
  });
  vi.mocked(resolveDocumentVisionProvider).mockResolvedValue({
    chain: [{ providerType: "anthropic", instance: {} }],
    pick: {
      entry: { providerType: "anthropic", instance: {} },
      providerType: "anthropic",
      pdfSupported: true,
    },
  } as never);
});

describe("POST /api/documents/inbound/[id]/summary", () => {
  it("keeps an ordinary requested summary session-only", async () => {
    vi.mocked(runDocumentSummary).mockResolvedValue({
      summary: "A transient summary.",
      blocked: null,
    } as never);

    const res = await POST(
      req("doc-1", "summary") as never,
      ctx("doc-1") as never,
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({
      summary: "A transient summary.",
    });
    expect(prisma.inboundDocument.updateMany).not.toHaveBeenCalled();
  });

  it("stores the first requested summary without replacing an existing one", async () => {
    vi.mocked(runDocumentSummary).mockResolvedValue({
      summary: "A blood panel from a lab.",
      blocked: null,
    } as never);

    const res = await POST(
      req("doc-1", "summary", { persist: true }) as never,
      ctx("doc-1") as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      summary: "A blood panel from a lab.",
      persistence: "stored",
    });
    expect(auditLog).toHaveBeenCalledWith(
      "documents.inbound.summary",
      expect.anything(),
    );
    expect(prisma.inboundDocument.updateMany).toHaveBeenCalledWith({
      where: {
        id: "doc-1",
        userId: "user-1",
        deletedAt: null,
        summaryEncrypted: null,
      },
      data: expect.objectContaining({ summaryState: "READY" }),
    });
    assertNoPersistence();
  });

  it("replaces a stored summary only when replacement is explicit", async () => {
    vi.mocked(runDocumentSummary).mockResolvedValue({
      summary: "A newly generated summary.",
      blocked: null,
    } as never);

    const res = await POST(
      req("doc-1", "summary", { persist: true, replace: true }) as never,
      ctx("doc-1") as never,
    );

    expect(res.status).toBe(200);
    expect(prisma.inboundDocument.updateMany).toHaveBeenCalledWith({
      where: {
        id: "doc-1",
        userId: "user-1",
        deletedAt: null,
      },
      data: expect.objectContaining({ summaryState: "READY" }),
    });
  });

  it("uses the signed-in user's locale for a requested summary", async () => {
    vi.mocked(getSession).mockResolvedValue({
      ...SESSION_OK,
      user: { ...SESSION_OK.user, locale: "de" },
    } as never);
    vi.mocked(runDocumentSummary).mockResolvedValue({
      summary: "Ein Laborbericht.",
      blocked: null,
    } as never);

    const res = await POST(
      req("doc-1", "summary") as never,
      ctx("doc-1") as never,
    );

    expect(res.status).toBe(200);
    expect(runDocumentSummary).toHaveBeenCalledWith(
      expect.objectContaining({ locale: "de" }),
    );
  });

  it("records WITHHELD without ever storing the blocked prose", async () => {
    vi.mocked(runDocumentSummary).mockResolvedValue({
      summary: "raise the dose to 10 mg",
      blocked: "dose_directive",
    } as never);

    const res = await POST(
      req("doc-1", "summary", { persist: true }) as never,
      ctx("doc-1") as never,
    );
    expect(res.status).toBe(200);

    // The user gets the honest statement, never the blocked text.
    const body = await res.json();
    expect(body.data.summary).toBe("The summary was withheld.");
    expect(body.data.persistence).toBe("withheld");
    expect(body.data.summary).not.toContain("10 mg");

    // Only the state lands. No ciphertext column is touched on this path.
    expect(prisma.inboundDocument.updateMany).toHaveBeenCalledWith({
      where: {
        id: "doc-1",
        userId: "user-1",
        deletedAt: null,
        summaryState: { not: "READY" },
      },
      data: { summaryState: "WITHHELD" },
    });
    const calls = vi.mocked(prisma.inboundDocument.updateMany).mock.calls;
    for (const [arg] of calls) {
      expect(arg.data).not.toHaveProperty("summaryEncrypted");
    }
    assertNoPersistence();
  });

  it("reports a failed save when the document changed before the write", async () => {
    vi.mocked(runDocumentSummary).mockResolvedValue({
      summary: "A blood panel from a lab.",
      blocked: null,
    } as never);
    vi.mocked(prisma.inboundDocument.updateMany).mockResolvedValueOnce({
      count: 0,
    });

    const res = await POST(
      req("doc-1", "summary", { persist: true }) as never,
      ctx("doc-1") as never,
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({
      summary: "A blood panel from a lab.",
      persistence: "failed",
    });
  });

  it("still answers when the summary write fails", async () => {
    vi.mocked(runDocumentSummary).mockResolvedValue({
      summary: "A blood panel from a lab.",
      blocked: null,
    } as never);
    vi.mocked(prisma.inboundDocument.updateMany).mockRejectedValueOnce(
      new Error("db down"),
    );

    // The user is waiting on a summary they can already read; a failed write
    // must not turn that into an error.
    const res = await POST(
      req("doc-1", "summary", { persist: true }) as never,
      ctx("doc-1") as never,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({
      summary: "A blood panel from a lab.",
      persistence: "failed",
    });
  });

  it("mode=text returns { text } session-only", async () => {
    vi.mocked(transcribeDocument).mockResolvedValue({
      text: "raw transcribed body",
    } as never);

    const res = await POST(
      req("doc-1", "text") as never,
      ctx("doc-1") as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ text: "raw transcribed body" });
    assertNoPersistence();
  });

  it("422s without a provider", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue({
      chain: [],
      pick: null,
    } as never);
    const res = await POST(
      req("doc-1", "summary") as never,
      ctx("doc-1") as never,
    );
    expect(res.status).toBe(422);
    assertNoPersistence();
  });
});
