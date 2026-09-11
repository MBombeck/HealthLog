import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The async-truth contract, pinned per state machine (v1.37.15).
 *
 * > A state that claims work is running must have a writer for every terminal
 * > branch; an enqueue must never claim a pending state its job cannot
 * > terminally resolve.
 *
 * Two machines are pinned — the document summary job and the document index
 * tree. Honest scope: these enumerate the branches of the two KNOWN machines;
 * a generic phantom-pending detector for arbitrary future jobs is not
 * provable and is not claimed. When a branch is added to either job, add it
 * here — the enumerations below are the contract.
 *
 * (a) Every branch of `runDocumentSummaryJob` ends in a terminal
 *     `summaryState` write — the opt-out branch included (it heals a phantom
 *     PENDING back to NONE). The only silent exits are "row gone" and
 *     "summary already stored", whose states are terminal by precondition.
 * (b) Every branch of the index tree behind `runDocumentIndex` ends in an
 *     attempt record (`lastIndexAttemptAt` + `lastIndexOutcome`) — success
 *     included (it clears the outcome). The only silent exit is not-found.
 * (c) `enqueueDocumentSummary` never claims PENDING when the job's only
 *     branch would be the opt-out no-op, and never before a job id exists.
 */

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: { findFirst: vi.fn(), updateMany: vi.fn() },
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
  transcribeDocument: vi.fn(),
}));
vi.mock("@/lib/documents/store", () => ({
  encryptDocumentSummary: vi.fn(() => new Uint8Array([9])),
  decryptDocumentContent: vi.fn(() => Buffer.from([1, 2, 3])),
}));
vi.mock("@/lib/documents/content-index", () => ({
  upsertContentIndex: vi.fn().mockResolvedValue({ tokenCount: 5 }),
}));
vi.mock("@/lib/documents/local-extract", () => ({
  localExtractText: vi.fn(),
}));
vi.mock("@/lib/documents/auto-stage-labs", () => ({
  maybeAutoStageLabFacts: vi.fn().mockResolvedValue({ staged: false }),
}));
vi.mock("@/lib/labs/ocr-upload", () => ({
  detectOcrMimeType: vi.fn(() => "application/pdf"),
}));
vi.mock("@/lib/ai/consent-guard", () => {
  class ConsentRequiredError extends Error {}
  return {
    ConsentRequiredError,
    assertDocumentEgressConsent: vi.fn(),
    isExternalDocumentEgress: (providerType: string) =>
      providerType !== "local",
  };
});
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-08-13"),
  reserveBudget: vi.fn(),
  reconcileSpend: vi.fn().mockResolvedValue(undefined),
  resolveDailyCap: vi.fn(() => 1000),
  resolveCostOwner: vi.fn(() => "operator" as const),
}));
vi.mock("@/lib/ai/ai-budgets", () => ({
  AI_BUDGETS: {
    documentSummary: { temperature: 0.3, maxTokens: 600 },
    documentTranscribe: { temperature: 0, maxTokens: 4000 },
  },
}));

import {
  enqueueDocumentSummary,
  runDocumentSummaryJob,
} from "../document-summary";
import { runDocumentIndex } from "../document-index";
import { prisma } from "@/lib/db";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { documentAutoReadEnabled } from "@/lib/documents/document-settings";
import { resolveDocumentVisionProvider } from "@/lib/documents/provider-order";
import {
  loadOwnedDocument,
  prepareVisionInput,
} from "@/lib/documents/ai-route-support";
import {
  runDocumentSummary,
  transcribeDocument,
} from "@/lib/documents/describe";
import { localExtractText } from "@/lib/documents/local-extract";
import {
  assertDocumentEgressConsent,
  ConsentRequiredError,
} from "@/lib/ai/consent-guard";
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

/** All updateMany data objects that carried a summaryState. */
function summaryStateWrites(): unknown[] {
  return vi
    .mocked(prisma.inboundDocument.updateMany)
    .mock.calls.filter(
      ([arg]) => arg.data && "summaryState" in (arg.data as object),
    )
    .map(([arg]) => (arg.data as { summaryState: unknown }).summaryState);
}

/** All updateMany data objects that carried the index-attempt record. */
function indexAttemptWrites(): unknown[] {
  return vi
    .mocked(prisma.inboundDocument.updateMany)
    .mock.calls.filter(
      ([arg]) => arg.data && "lastIndexAttemptAt" in (arg.data as object),
    )
    .map(
      ([arg]) => (arg.data as { lastIndexOutcome: unknown }).lastIndexOutcome,
    );
}

beforeEach(() => {
  vi.clearAllMocks();
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
  vi.mocked(prepareVisionInput).mockResolvedValue({
    ok: true,
    images: [],
    documents: [{ mediaType: "application/pdf", dataBase64: "AA==" }],
  } as never);
  vi.mocked(runDocumentSummary).mockResolvedValue({
    summary: "A short descriptive summary.",
    blocked: null,
  } as never);
  vi.mocked(transcribeDocument).mockResolvedValue({
    text: "haemoglobin 14.2",
  } as never);
  vi.mocked(reserveBudget).mockResolvedValue({
    allowed: true,
    reserved: 1,
  } as never);
  vi.mocked(localExtractText).mockResolvedValue({
    ok: true,
    text: "glucose fasting values",
    source: "local-pdf",
  } as never);
});

const PAYLOAD = { userId: "user-1", documentId: "doc-1" };

describe("contract (a): every runDocumentSummaryJob branch writes a terminal state", () => {
  const branches: Array<{
    name: string;
    setup: () => void;
    state: string;
  }> = [
    {
      name: "opt-out heals PENDING to NONE",
      setup: () => {
        vi.mocked(documentAutoReadEnabled).mockResolvedValue(false);
      },
      state: "NONE",
    },
    {
      name: "no provider configured",
      setup: () => {
        vi.mocked(resolveDocumentVisionProvider).mockResolvedValue({
          chain: [],
          pick: null,
        } as never);
      },
      state: "UNAVAILABLE",
    },
    {
      name: "consent refused",
      setup: () => {
        vi.mocked(assertDocumentEgressConsent).mockRejectedValue(
          new ConsentRequiredError("insights"),
        );
      },
      state: "UNAVAILABLE",
    },
    {
      name: "document unreadable by the picked provider",
      setup: () => {
        vi.mocked(prepareVisionInput).mockResolvedValue({
          ok: false,
          reason: "fileType",
        } as never);
      },
      state: "UNAVAILABLE",
    },
    {
      name: "budget exhausted",
      setup: () => {
        vi.mocked(reserveBudget).mockResolvedValue({
          allowed: false,
          reserved: 0,
        } as never);
      },
      state: "UNAVAILABLE",
    },
    {
      name: "safety screen blocked the summary",
      setup: () => {
        vi.mocked(runDocumentSummary).mockResolvedValue({
          summary: "",
          blocked: "dose_directive",
        } as never);
      },
      state: "WITHHELD",
    },
    {
      name: "provider error",
      setup: () => {
        vi.mocked(runDocumentSummary).mockRejectedValue(new Error("boom"));
      },
      state: "UNAVAILABLE",
    },
    {
      name: "success",
      setup: () => {},
      state: "READY",
    },
  ];

  for (const branch of branches) {
    it(`${branch.name} → writes ${branch.state}`, async () => {
      branch.setup();
      await runDocumentSummaryJob(PAYLOAD);
      expect(summaryStateWrites()).toContain(branch.state);
    });
  }

  it("the only silent exits are row-gone and already-summarised (terminal by precondition)", async () => {
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue(
      null as never,
    );
    await runDocumentSummaryJob(PAYLOAD);
    expect(summaryStateWrites()).toEqual([]);

    vi.clearAllMocks();
    vi.mocked(prisma.inboundDocument.findFirst).mockResolvedValue({
      id: "doc-1",
      summaryEncrypted: new Uint8Array([1]),
    } as never);
    await runDocumentSummaryJob(PAYLOAD);
    expect(summaryStateWrites()).toEqual([]);
  });
});

describe("contract (a): every runDocumentIndex branch records the attempt", () => {
  const branches: Array<{
    name: string;
    setup: () => void;
    outcome: string | null;
  }> = [
    {
      name: "provider success",
      setup: () => {},
      outcome: null,
    },
    {
      name: "local success (no provider)",
      setup: () => {
        vi.mocked(resolveDocumentVisionProvider).mockResolvedValue({
          chain: [],
          pick: null,
        } as never);
      },
      outcome: null,
    },
    {
      name: "scan with no text and no provider",
      setup: () => {
        vi.mocked(resolveDocumentVisionProvider).mockResolvedValue({
          chain: [],
          pick: null,
        } as never);
        vi.mocked(localExtractText).mockResolvedValue({
          ok: false,
          reason: "empty",
        } as never);
      },
      outcome: "local-empty",
    },
    {
      name: "provider error with no local text",
      setup: () => {
        vi.mocked(transcribeDocument).mockRejectedValue(new Error("boom"));
        vi.mocked(localExtractText).mockResolvedValue({
          ok: false,
          reason: "empty",
        } as never);
      },
      outcome: "provider-error",
    },
    {
      name: "empty transcription with no local text",
      setup: () => {
        vi.mocked(transcribeDocument).mockResolvedValue({
          text: "  ",
        } as never);
        vi.mocked(localExtractText).mockResolvedValue({
          ok: false,
          reason: "empty",
        } as never);
      },
      outcome: "empty-transcription",
    },
    {
      name: "raster failure with no local text",
      setup: () => {
        vi.mocked(prepareVisionInput).mockResolvedValue({
          ok: false,
          reason: "rasterFailed",
        } as never);
        vi.mocked(localExtractText).mockResolvedValue({
          ok: false,
          reason: "empty",
        } as never);
      },
      outcome: "raster-failed",
    },
    {
      name: "decrypt failure",
      setup: () => {
        vi.mocked(prepareVisionInput).mockResolvedValue({
          ok: false,
          reason: "decryptFailed",
        } as never);
      },
      outcome: "decrypt-error",
    },
  ];

  for (const branch of branches) {
    it(`${branch.name} → records outcome ${JSON.stringify(branch.outcome)}`, async () => {
      branch.setup();
      await runDocumentIndex(PAYLOAD);
      expect(indexAttemptWrites()).toContain(branch.outcome);
    });
  }

  it("the only silent exit is not-found (no row to explain)", async () => {
    vi.mocked(loadOwnedDocument).mockResolvedValue(null as never);
    await runDocumentIndex(PAYLOAD);
    expect(indexAttemptWrites()).toEqual([]);
  });
});

describe("contract (b): enqueue never claims a pending state its job cannot resolve", () => {
  it("enqueueDocumentSummary with the opt-in OFF claims nothing and mints no job", async () => {
    vi.mocked(documentAutoReadEnabled).mockResolvedValue(false);
    const send = vi.fn().mockResolvedValue("job-1");
    vi.mocked(getGlobalBoss).mockReturnValue({ send } as never);

    const result = await enqueueDocumentSummary("user-1", "doc-1");
    expect(result).toEqual({ enqueued: false });
    expect(send).not.toHaveBeenCalled();
    expect(summaryStateWrites()).toEqual([]);
  });

  it("enqueueDocumentSummary claims PENDING only once a job id exists", async () => {
    const send = vi.fn().mockResolvedValue(null);
    vi.mocked(getGlobalBoss).mockReturnValue({ send } as never);
    await enqueueDocumentSummary("user-1", "doc-1");
    expect(summaryStateWrites()).toEqual([]);

    send.mockResolvedValue("job-1");
    await enqueueDocumentSummary("user-1", "doc-1");
    expect(summaryStateWrites()).toContain("PENDING");
  });
});
