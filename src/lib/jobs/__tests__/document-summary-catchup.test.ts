import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The auto-read catch-up pass.
 *
 * Documents are summarised by a job enqueued at UPLOAD time that no-ops while
 * the `documentsAutoAiRead` opt-in is OFF, so a vault filled before the flip was
 * never read and the toggle appeared to do nothing. These tests pin the catch-up
 * that closes that hole, and the three properties it must not lose: it stays
 * bounded, it stays idempotent, and it grants no consent or budget of its own.
 */

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: { inboundDocument: { findMany: vi.fn() } },
}));
vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: vi.fn() }));
vi.mock("@/lib/documents/document-settings", () => ({
  documentAutoReadEnabled: vi.fn(),
}));
vi.mock("@/lib/jobs/document-summary", () => ({
  enqueueDocumentSummary: vi.fn(),
}));
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForJob: vi.fn(),
  aiCapabilityForRecord: vi.fn(),
}));

import {
  enqueueSummaryCatchUp,
  runSummaryCatchUpForUser,
  MAX_ENQUEUES_PER_RUN,
  DOCUMENT_SUMMARY_CATCHUP_QUEUE,
} from "../document-summary-catchup";
import { prisma } from "@/lib/db";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { documentAutoReadEnabled } from "@/lib/documents/document-settings";
import { enqueueDocumentSummary } from "@/lib/jobs/document-summary";
import { annotate } from "@/lib/logging/context";
import { aiCapabilityForJob } from "@/lib/ai/capabilities/gate";

const findMany = vi.mocked(prisma.inboundDocument.findMany);
const mockEnqueueSummary = vi.mocked(enqueueDocumentSummary);
const mockAutoRead = vi.mocked(documentAutoReadEnabled);
const mockCapability = vi.mocked(aiCapabilityForJob);

/** Serve `total` document ids across the job's id-cursor paged walk. */
function serveDocuments(total: number) {
  const ids = Array.from({ length: total }, (_, i) => ({
    id: `doc-${String(i).padStart(5, "0")}`,
  }));
  findMany.mockImplementation((async (args: {
    take: number;
    cursor?: { id: string };
  }) => {
    const start = args.cursor
      ? ids.findIndex((d) => d.id === args.cursor!.id) + 1
      : 0;
    return ids.slice(start, start + args.take);
  }) as unknown as typeof findMany);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAutoRead.mockResolvedValue(true);
  mockCapability.mockResolvedValue({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  });
  mockEnqueueSummary.mockResolvedValue({ enqueued: true });
});

describe("runSummaryCatchUpForUser", () => {
  it("enqueues a summary for every already-stored un-summarised document", async () => {
    serveDocuments(3);

    const result = await runSummaryCatchUpForUser("user-1");

    expect(result).toEqual({ enqueued: 3, capped: false });
    expect(mockEnqueueSummary).toHaveBeenCalledTimes(3);
    expect(mockEnqueueSummary).toHaveBeenCalledWith("user-1", "doc-00000");
    expect(mockEnqueueSummary).toHaveBeenCalledWith("user-1", "doc-00002");
  });

  it("only considers documents that have no summary yet", async () => {
    // Idempotency floor: a re-run cannot redo finished work because a
    // summarised document is not in the candidate set at all.
    serveDocuments(1);

    await runSummaryCatchUpForUser("user-1");

    const where = findMany.mock.calls[0]![0]!.where;
    expect(where).toMatchObject({
      userId: "user-1",
      deletedAt: null,
      summaryEncrypted: null,
    });
  });

  it("leaves imports held back from AI reading alone (#1038)", async () => {
    serveDocuments(1);
    await runSummaryCatchUpForUser("user-1");
    expect(findMany.mock.calls[0]![0]!.where).toMatchObject({
      aiReadDeferred: false,
    });
  });

  it("stops at the documented cap instead of queueing a whole vault", async () => {
    serveDocuments(MAX_ENQUEUES_PER_RUN + 50);

    const result = await runSummaryCatchUpForUser("user-1");

    expect(result.enqueued).toBe(MAX_ENQUEUES_PER_RUN);
    expect(result.capped).toBe(true);
    expect(mockEnqueueSummary).toHaveBeenCalledTimes(MAX_ENQUEUES_PER_RUN);
  });

  it("re-reads the opt-in and does nothing when it was flipped back OFF", async () => {
    // Consent race: the PATCH that scheduled the pass is not authority enough.
    serveDocuments(5);
    mockAutoRead.mockResolvedValue(false);

    const result = await runSummaryCatchUpForUser("user-1");

    expect(result).toEqual({ enqueued: 0, capped: false });
    expect(mockEnqueueSummary).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it.each(["operator_disabled", "module_disabled", "user_disabled"] as const)(
    "does nothing when the documentAi capability is unavailable (%s)",
    async (reason) => {
      serveDocuments(5);
      mockCapability.mockResolvedValue({
        available: false,
        reason,
        onDeviceAllowed: false,
      });

      const result = await runSummaryCatchUpForUser("user-1");

      expect(mockCapability).toHaveBeenCalledWith("user-1", "documentAi");
      expect(result).toEqual({ enqueued: 0, capped: false });
      // Refused before a single document is listed.
      expect(findMany).not.toHaveBeenCalled();
      expect(mockEnqueueSummary).not.toHaveBeenCalled();
      expect(annotate).toHaveBeenCalledWith({
        action: { name: "documents.autoRead.catchUpSkipped" },
        meta: { reason },
      });
    },
  );

  it.each(["no_provider", "consent_required"] as const)(
    "leaves %s to each job's pick: still walks and enqueues",
    async (reason) => {
      // Whether there is a provider and whether sending to it needs a receipt
      // depends on the document-order pick, which the per-document job
      // re-checks at the wire. The pass-level presence answer does not decide.
      serveDocuments(2);
      mockCapability.mockResolvedValue({
        available: false,
        reason,
        onDeviceAllowed: true,
      });

      const result = await runSummaryCatchUpForUser("user-1");

      expect(result).toEqual({ enqueued: 2, capped: false });
      expect(mockEnqueueSummary).toHaveBeenCalledTimes(2);
      expect(annotate).not.toHaveBeenCalledWith(
        expect.objectContaining({
          action: { name: "documents.autoRead.catchUpSkipped" },
        }),
      );
    },
  );

  it("routes work through the ordinary summary job, granting nothing itself", async () => {
    // The per-document job is what re-asserts egress consent and reserves the
    // daily budget. The catch-up must not have its own provider or budget path.
    serveDocuments(2);

    await runSummaryCatchUpForUser("user-1");

    expect(mockEnqueueSummary).toHaveBeenCalledTimes(2);
    for (const call of mockEnqueueSummary.mock.calls) {
      expect(call[0]).toBe("user-1");
    }
  });

  it("emits the catch-up wide event", async () => {
    serveDocuments(2);

    await runSummaryCatchUpForUser("user-1");

    expect(annotate).toHaveBeenCalledWith({
      action: { name: "documents.autoRead.catchUp" },
      meta: { enqueued: 2, capped: false },
    });
  });
});

describe("enqueueSummaryCatchUp", () => {
  it("coalesces a double toggle onto one per-user singleton key", async () => {
    const send = vi.fn().mockResolvedValue("job-1");
    vi.mocked(getGlobalBoss).mockReturnValue({
      send,
    } as unknown as ReturnType<typeof getGlobalBoss>);

    await enqueueSummaryCatchUp("user-1");
    await enqueueSummaryCatchUp("user-1");

    expect(send).toHaveBeenCalledTimes(2);
    for (const call of send.mock.calls) {
      expect(call[0]).toBe(DOCUMENT_SUMMARY_CATCHUP_QUEUE);
      expect(call[2]).toMatchObject({
        singletonKey: "document-summary-catchup|user-1",
      });
    }
  });

  it("is a no-op without a boss and never throws on a send failure", async () => {
    vi.mocked(getGlobalBoss).mockReturnValue(
      null as unknown as ReturnType<typeof getGlobalBoss>,
    );
    await expect(enqueueSummaryCatchUp("user-1")).resolves.toEqual({
      enqueued: false,
    });

    vi.mocked(getGlobalBoss).mockReturnValue({
      send: vi.fn().mockRejectedValue(new Error("down")),
    } as unknown as ReturnType<typeof getGlobalBoss>);
    await expect(enqueueSummaryCatchUp("user-1")).resolves.toEqual({
      enqueued: false,
    });
  });
});

describe("the toggle copy discloses the catch-up", () => {
  const LOCALES = ["de", "en", "es", "fr", "it", "pl", "ko"] as const;

  function autoReadCopy(locale: string): { subLabel: string; honesty: string } {
    const bundle = JSON.parse(
      readFileSync(
        join(__dirname, `../../../../messages/${locale}.json`),
        "utf8",
      ),
    ) as {
      settings: {
        ai: { autoRead: { subLabel: string; honesty: string } };
      };
    };
    return bundle.settings.ai.autoRead;
  }

  it.each(LOCALES)(
    "%s does not promise the switch only applies to future uploads",
    (locale) => {
      // The flip enqueues a pass over documents ALREADY stored, so copy that
      // scopes the switch to newly uploaded documents understates its reach.
      const { subLabel } = autoReadCopy(locale);
      expect(subLabel).not.toMatch(
        /newly|neu hochgeladene|recién subidos|nouvellement téléversés|appena caricati|nowo przesłane/i,
      );
    },
  );

  it.each(LOCALES)("%s names the retroactive pass and its cap", (locale) => {
    const { honesty } = autoReadCopy(locale);
    expect(honesty).toContain(String(MAX_ENQUEUES_PER_RUN));
  });
});
