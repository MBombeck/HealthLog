import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Refs #776 — the reindex trigger's wire honesty. The client types
 * `{ enqueued: number }` and interpolates it into "Indexing {count}
 * document(s)"; the route used to return `Boolean(jobId)`, so the toast said
 * "Indexing true document(s)". Pins: `enqueued` is a NUMBER — the count of
 * live documents still lacking a content index (the same figure the usage
 * gauge derives) when a job was created, and an honest 0 when none was.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: { count: vi.fn() },
    documentContentIndex: { count: vi.fn() },
  },
}));
vi.mock("@/lib/jobs/document-content-index-backfill", () => ({
  enqueueContentIndexBackfill: vi.fn(),
}));
vi.mock("@/lib/documents/provider-order", () => ({
  requireDocumentVisionProvider: vi.fn(),
}));
vi.mock("@/lib/ai/capabilities/gate", () => ({
  requireAiCapability: vi.fn(),
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
import { enqueueContentIndexBackfill } from "@/lib/jobs/document-content-index-backfill";
import { requireDocumentVisionProvider } from "@/lib/documents/provider-order";
import { requireAiCapability } from "@/lib/ai/capabilities/gate";
import { AiUnavailableError } from "@/lib/ai/capabilities/refusal";

const SESSION_OK = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

const PICK = {
  chain: [{ providerType: "anthropic", instance: {} }],
  pick: {
    entry: { providerType: "anthropic", instance: {} },
    providerType: "anthropic",
    pdfSupported: true,
  },
};

const req = () =>
  new NextRequest(new URL("http://localhost/api/documents/inbound/reindex"), {
    method: "POST",
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireAiCapability).mockResolvedValue({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  });
  vi.mocked(requireDocumentVisionProvider).mockResolvedValue(
    PICK.pick as never,
  );
  vi.mocked(enqueueContentIndexBackfill).mockResolvedValue({ enqueued: true });
  // 7 live documents, 4 already indexed → 3 remain.
  vi.mocked(prisma.inboundDocument.count).mockResolvedValue(7 as never);
  vi.mocked(prisma.documentContentIndex.count).mockResolvedValue(4 as never);
});

describe("POST /api/documents/inbound/reindex", () => {
  it("returns the remaining un-indexed count as a NUMBER, never a boolean", async () => {
    const res = await POST(req() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.data.enqueued).toBe("number");
    expect(body.data.enqueued).toBe(3);
  });

  it("returns an honest 0 when no job was created", async () => {
    vi.mocked(enqueueContentIndexBackfill).mockResolvedValue({
      enqueued: false,
    });
    const res = await POST(req() as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.enqueued).toBe(0);
  });

  it("scopes both counts to the caller's LIVE documents (the gauge's own figures)", async () => {
    await POST(req() as never);
    // Imports held back from AI reading (#1038) are not part of the run and
    // stay out of both figures.
    expect(prisma.inboundDocument.count).toHaveBeenCalledWith({
      where: { userId: "user-1", deletedAt: null, aiReadDeferred: false },
    });
    expect(prisma.documentContentIndex.count).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        document: { deletedAt: null, aiReadDeferred: false },
      },
    });
  });
});

describe("POST /api/documents/inbound/reindex — the documentAi capability", () => {
  it("answers the capability envelope and enqueues nothing when document reading is off", async () => {
    vi.mocked(requireAiCapability).mockRejectedValue(
      new AiUnavailableError("documentAi", "operator_disabled"),
    );
    const res = await POST(req() as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.meta).toEqual({
      errorCode: "assistant.disabled.documentAi",
      capability: "documentAi",
      reason: "operator_disabled",
    });
    expect(requireAiCapability).toHaveBeenCalledWith("documentAi", {
      pickDecides: true,
    });
    expect(enqueueContentIndexBackfill).not.toHaveBeenCalled();
  });

  it("keeps the vault's own code when no provider can read documents", async () => {
    vi.mocked(requireDocumentVisionProvider).mockRejectedValue(
      new AiUnavailableError("documentAi", "no_provider", null, {
        errorCode: "documents.inbound.providerUnsupported",
      }),
    );
    const res = await POST(req() as never);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.meta.errorCode).toBe("documents.inbound.providerUnsupported");
    expect(enqueueContentIndexBackfill).not.toHaveBeenCalled();
  });
});
