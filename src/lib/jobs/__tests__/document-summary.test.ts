import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The auto-summary background job's gating. Pins: the opt-in (`documentsAutoAiRead`)
 * is the trigger — OFF → strictly no summary (no provider call, no write); ON +
 * a configured provider → the summary is generated once and persisted ENCRYPTED
 * (write scoped to `summaryEncrypted: null` so a re-run is a no-op); an already-
 * summarised document short-circuits before the opt-in is even read; no provider
 * configured → a graceful no-op; a provider error refunds the budget and persists
 * nothing.
 */

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    // The job reads the owner's locale to pick the outbound screen's banks.
    user: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: vi.fn() }));
vi.mock("@/lib/documents/document-settings", () => ({
  documentAutoReadEnabled: vi.fn(),
}));
vi.mock("@/lib/documents/provider-order", () => ({
  resolveDocumentVisionProvider: vi.fn(),
}));
vi.mock("@/lib/documents/ai-route-support", () => ({
  loadOwnedDocument: vi.fn(),
  prepareVisionInput: vi.fn(),
}));
vi.mock("@/lib/documents/describe", () => ({
  runDocumentSummary: vi.fn(),
}));
vi.mock("@/lib/documents/store", () => ({
  encryptDocumentSummary: vi.fn(() => new Uint8Array([9, 9, 9])),
}));
vi.mock("@/lib/ai/consent-guard", () => {
  class ConsentRequiredError extends Error {}
  return {
    ConsentRequiredError,
    assertDocumentEgressConsent: vi.fn(),
  };
});
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-07-17"),
  reserveBudget: vi.fn(),
  reconcileSpend: vi.fn().mockResolvedValue(undefined),
  resolveDailyCap: vi.fn(() => 1000),
  resolveCostOwner: vi.fn(() => "operator" as const),
}));
vi.mock("@/lib/ai/ai-budgets", () => ({
  AI_BUDGETS: { documentSummary: { temperature: 0.3, maxTokens: 600 } },
}));

import {
  enqueueDocumentSummary,
  runDocumentSummaryJob,
} from "../document-summary";
import { prisma } from "@/lib/db";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { documentAutoReadEnabled } from "@/lib/documents/document-settings";
import { resolveDocumentVisionProvider } from "@/lib/documents/provider-order";
import {
  loadOwnedDocument,
  prepareVisionInput,
} from "@/lib/documents/ai-route-support";
import { runDocumentSummary } from "@/lib/documents/describe";
import { encryptDocumentSummary } from "@/lib/documents/store";
import { assertDocumentEgressConsent } from "@/lib/ai/consent-guard";
import { reserveBudget, reconcileSpend } from "@/lib/ai/coach/budget";

const DOC = {
  id: "doc-1",
  kind: "OTHER",
  contentEncrypted: new Uint8Array([1, 2, 3]),
  contentCodec: "binary2",
  mimeType: "application/pdf",
  status: "STORED",
};

/** An EXTERNAL (Anthropic) document pick — egress, so opt-in-gated. */
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

beforeEach(() => {
  vi.clearAllMocks();
  // Default: a live, not-yet-summarised document.
  vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
    id: "doc-1",
    summaryEncrypted: null,
  } as never);
  vi.mocked(prisma.inboundDocument.updateMany).mockResolvedValue({
    count: 1,
  } as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    locale: "en",
  } as never);
  vi.mocked(documentAutoReadEnabled).mockResolvedValue(true);
  vi.mocked(resolveDocumentVisionProvider).mockResolvedValue(PICK as never);
  vi.mocked(assertDocumentEgressConsent).mockResolvedValue(undefined);
  vi.mocked(loadOwnedDocument).mockResolvedValue(DOC as never);
  visionOk();
  vi.mocked(runDocumentSummary).mockResolvedValue({
    summary: "A lab report from a clinic listing routine blood values.",
    blocked: null,
  } as never);
  vi.mocked(reserveBudget).mockResolvedValue({
    allowed: true,
    reserved: 5,
    owner: "operator",
  } as never);
});

describe("runDocumentSummaryJob — gating", () => {
  it("does no provider work when the opt-in is OFF (only the PENDING heal may write)", async () => {
    vi.mocked(documentAutoReadEnabled).mockResolvedValue(false);

    await runDocumentSummaryJob({ userId: "user-1", documentId: "doc-1" });

    expect(resolveDocumentVisionProvider).not.toHaveBeenCalled();
    expect(runDocumentSummary).not.toHaveBeenCalled();
    // The single permitted write is the PENDING→NONE heal; nothing may claim
    // an attempt (UNAVAILABLE/WITHHELD) or a summary (READY) here.
    const calls = vi.mocked(prisma.inboundDocument.updateMany).mock.calls;
    for (const [arg] of calls) {
      expect(arg.data).toEqual({ summaryState: "NONE" });
    }
  });

  it("generates and PERSISTS the summary encrypted when opt-in is ON + a provider is configured", async () => {
    await runDocumentSummaryJob({ userId: "user-1", documentId: "doc-1" });

    expect(runDocumentSummary).toHaveBeenCalledTimes(1);
    expect(encryptDocumentSummary).toHaveBeenCalledWith(
      "A lab report from a clinic listing routine blood values.",
    );
    // Budget reserved then reconciled at the full reserved amount (charged).
    expect(reconcileSpend).toHaveBeenCalledWith(
      "user-1",
      5,
      5,
      "2026-07-17",
      0,
      { servedBy: expect.any(String), reservedOwner: "operator" },
    );
    // Write is scoped to the still-null column so a re-run cannot clobber it.
    expect(prisma.inboundDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "doc-1",
          userId: "user-1",
          summaryEncrypted: null,
        }),
        data: expect.objectContaining({
          summaryEncrypted: expect.any(Uint8Array),
          summaryGeneratedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("generates the background summary in the owner's selected locale", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      locale: "de",
    } as never);

    await runDocumentSummaryJob({ userId: "user-1", documentId: "doc-1" });

    expect(runDocumentSummary).toHaveBeenCalledWith(
      expect.objectContaining({ locale: "de" }),
    );
  });

  it("SKIPS a document that already has a summary (before reading the opt-in)", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
      id: "doc-1",
      summaryEncrypted: new Uint8Array([1]),
    } as never);

    await runDocumentSummaryJob({ userId: "user-1", documentId: "doc-1" });

    expect(documentAutoReadEnabled).not.toHaveBeenCalled();
    expect(runDocumentSummary).not.toHaveBeenCalled();
    expect(prisma.inboundDocument.updateMany).not.toHaveBeenCalled();
  });

  it("is a graceful no-op when NO provider is configured", async () => {
    vi.mocked(resolveDocumentVisionProvider).mockResolvedValue({
      chain: [],
      pick: null,
    } as never);

    await runDocumentSummaryJob({ userId: "user-1", documentId: "doc-1" });

    expect(reserveBudget).not.toHaveBeenCalled();
    expect(runDocumentSummary).not.toHaveBeenCalled();
    // No summary is written — but the attempt is RECORDED. Leaving the row
    // untouched is what made the detail view claim "being generated" forever.
    expect(prisma.inboundDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { summaryState: "UNAVAILABLE" } }),
    );
  });

  it("refunds the budget and records UNAVAILABLE when the provider call throws", async () => {
    vi.mocked(runDocumentSummary).mockRejectedValueOnce(new Error("boom"));

    await runDocumentSummaryJob({ userId: "user-1", documentId: "doc-1" });

    // Reservation refunded to zero spend; no summary written, state recorded.
    expect(reconcileSpend).toHaveBeenCalledWith(
      "user-1",
      5,
      0,
      "2026-07-17",
      0,
      { servedBy: null, reservedOwner: "operator" },
    );
    expect(prisma.inboundDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { summaryState: "UNAVAILABLE" } }),
    );
  });

  it("records WITHHELD — not silence — when the safety screen blocks the summary", async () => {
    vi.mocked(runDocumentSummary).mockResolvedValueOnce({
      summary: "",
      blocked: "dose_directive",
    } as never);

    await runDocumentSummaryJob({ userId: "user-1", documentId: "doc-1" });

    // The blocked prose NEVER lands. Only the state does, and it is not
    // terminal — the guard refuses to overwrite READY, nothing else.
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
  });

  it("marks a stored summary READY so the view serves it from storage", async () => {
    await runDocumentSummaryJob({ userId: "user-1", documentId: "doc-1" });

    expect(prisma.inboundDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ summaryEncrypted: null }),
        data: expect.objectContaining({ summaryState: "READY" }),
      }),
    );
  });

  it("heals a phantom PENDING back to NONE when the opt-in is OFF", async () => {
    vi.mocked(documentAutoReadEnabled).mockResolvedValue(false);

    await runDocumentSummaryJob({ userId: "user-1", documentId: "doc-1" });

    // The opt-out branch may not leave a claimed PENDING standing — the view
    // reads PENDING as "being generated" and this run is the only writer that
    // can resolve it. The heal is scoped to PENDING: UNAVAILABLE / WITHHELD
    // record real attempts and stay, READY is never touched.
    expect(prisma.inboundDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ summaryState: "PENDING" }),
        data: { summaryState: "NONE" },
      }),
    );
    // Still strictly no provider work.
    expect(resolveDocumentVisionProvider).not.toHaveBeenCalled();
    expect(runDocumentSummary).not.toHaveBeenCalled();
  });
});

describe("enqueueDocumentSummary — the pending contract", () => {
  it("does not enqueue and does not claim PENDING when the opt-in is OFF", async () => {
    vi.mocked(documentAutoReadEnabled).mockResolvedValue(false);
    const send = vi.fn().mockResolvedValue("job-1");
    vi.mocked(getGlobalBoss).mockReturnValue({ send } as never);

    const result = await enqueueDocumentSummary("user-1", "doc-1");

    // With auto-read OFF the job's only move is the opt-out no-op, so a
    // PENDING claimed here could never be resolved to a real outcome. No job,
    // no state write — the view keeps offering the manual action.
    expect(result).toEqual({ enqueued: false });
    expect(send).not.toHaveBeenCalled();
    expect(prisma.inboundDocument.updateMany).not.toHaveBeenCalled();
  });

  it("enqueues and claims PENDING when the opt-in is ON and a job was created", async () => {
    const send = vi.fn().mockResolvedValue("job-1");
    vi.mocked(getGlobalBoss).mockReturnValue({ send } as never);

    const result = await enqueueDocumentSummary("user-1", "doc-1");

    expect(result).toEqual({ enqueued: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(prisma.inboundDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { summaryState: "PENDING" } }),
    );
  });

  it("claims nothing when the boss dropped the send (no job id)", async () => {
    const send = vi.fn().mockResolvedValue(null);
    vi.mocked(getGlobalBoss).mockReturnValue({ send } as never);

    const result = await enqueueDocumentSummary("user-1", "doc-1");

    expect(result).toEqual({ enqueued: false });
    expect(prisma.inboundDocument.updateMany).not.toHaveBeenCalled();
  });
});
