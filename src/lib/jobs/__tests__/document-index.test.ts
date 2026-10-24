import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Per-document auto-index job. Pins: the enqueue coalesces per document via a
 * singletonKey and no-ops when the boss is absent; the worker delegates to the
 * shared decision tree and never throws for an expected outcome.
 */

vi.mock("@/lib/documents/index-document", () => ({
  indexDocumentContent: vi.fn(),
}));
vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: vi.fn() }));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/documents/auto-stage-labs", () => ({
  maybeAutoStageLabFacts: vi.fn().mockResolvedValue(undefined),
}));
const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique } } }));

import {
  enqueueDocumentIndex,
  runDocumentIndex,
  stagingSchedule,
} from "../document-index";
import {
  DOCUMENT_INDEX_EXPIRE_SECONDS,
  DOCUMENT_INDEX_QUEUE,
  DOCUMENT_INDEX_UNPLANNED_COMPLETIONS,
} from "../document-index-queue";
import { JOB_BUDGET_SHARE } from "../job-budget";
import { COMPLETION_CEILING_MS } from "../model-time";
import { AI_RESPONSE_TIMEOUT_MAX_SECONDS } from "@/lib/ai/effective-timeout";
import {
  OCR_EXTRACT_MODEL_CALLS,
  OCR_MAX_PAGES,
  maxReadsFor,
} from "@/lib/documents/ocr-plan";
import { indexDocumentContent } from "@/lib/documents/index-document";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { maybeAutoStageLabFacts } from "@/lib/documents/auto-stage-labs";

/** A document the local text layer indexed. */
const INDEXED_LOCALLY = {
  indexed: true,
  source: "local-pdf",
  tokenCount: 3,
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("enqueueDocumentIndex", () => {
  it("coalesces per document via a singletonKey", async () => {
    const send = vi.fn().mockResolvedValue("job-1");
    vi.mocked(getGlobalBoss).mockReturnValue({ send } as never);

    const result = await enqueueDocumentIndex("user-1", "doc-1");
    expect(result).toEqual({ enqueued: true });
    expect(send).toHaveBeenCalledWith(
      DOCUMENT_INDEX_QUEUE,
      expect.objectContaining({ userId: "user-1", documentId: "doc-1" }),
      expect.objectContaining({
        singletonKey: "document-index|doc-1",
        expireInSeconds: DOCUMENT_INDEX_EXPIRE_SECONDS,
      }),
    );
  });

  it("carries localOnly for a deferred import, and only then", async () => {
    const send = vi.fn().mockResolvedValue("job-1");
    vi.mocked(getGlobalBoss).mockReturnValue({ send } as never);
    await enqueueDocumentIndex("user-1", "doc-1", { localOnly: true });
    await enqueueDocumentIndex("user-1", "doc-2");
    expect(send.mock.calls[0][1]).toMatchObject({ localOnly: true });
    expect(send.mock.calls[1][1]).not.toHaveProperty("localOnly");
  });

  it("no-ops when the boss is not running", async () => {
    vi.mocked(getGlobalBoss).mockReturnValue(null as never);
    const result = await enqueueDocumentIndex("user-1", "doc-1");
    expect(result).toEqual({ enqueued: false });
  });

  it("swallows a boss.send failure to a no-op (never fails the upload)", async () => {
    const send = vi.fn().mockRejectedValue(new Error("db down"));
    vi.mocked(getGlobalBoss).mockReturnValue({ send } as never);
    // Must resolve, never reject — the upload has already committed.
    await expect(enqueueDocumentIndex("user-1", "doc-1")).resolves.toEqual({
      enqueued: false,
    });
  });
});

describe("runDocumentIndex", () => {
  it("delegates to the shared decision tree", async () => {
    vi.mocked(indexDocumentContent).mockResolvedValue(INDEXED_LOCALLY);
    await runDocumentIndex({ userId: "user-1", documentId: "doc-1" });
    expect(indexDocumentContent).toHaveBeenCalledWith("user-1", "doc-1", {
      localOnly: false,
    });
    expect(maybeAutoStageLabFacts).toHaveBeenCalledWith("user-1", "doc-1", {
      schedule: undefined,
    });
  });

  it("hands the lab staging the job's deadline", async () => {
    vi.mocked(indexDocumentContent).mockResolvedValue(INDEXED_LOCALLY);
    findUnique.mockResolvedValue({ aiResponseTimeoutSeconds: 300 });
    let clock = 0;
    await runDocumentIndex(
      { userId: "user-1", documentId: "doc-1" },
      { deadlineAt: 3_000_000, now: () => clock },
    );
    const schedule = vi.mocked(maybeAutoStageLabFacts).mock.calls[0][2]
      ?.schedule;
    // 300 s per call, twice for the reasoning repeat: five calls fit.
    expect(schedule?.maxModelCalls()).toBe(5);
    clock = 2_000_000;
    expect(schedule?.maxModelCalls()).toBe(1);
  });

  it("a deferred import indexes locally and stages no lab facts", async () => {
    vi.mocked(indexDocumentContent).mockResolvedValue(INDEXED_LOCALLY);
    await runDocumentIndex({
      userId: "user-1",
      documentId: "doc-1",
      localOnly: true,
    });
    expect(indexDocumentContent).toHaveBeenCalledWith("user-1", "doc-1", {
      localOnly: true,
    });
    expect(maybeAutoStageLabFacts).not.toHaveBeenCalled();
  });

  it("ignores a payload missing ids without calling the tree", async () => {
    await runDocumentIndex({ userId: "", documentId: "" });
    expect(indexDocumentContent).not.toHaveBeenCalled();
  });
});

describe("document-index — a slow model cannot outlive the job (#1274)", () => {
  it("ends below the expiry at the largest setting, however long the report", async () => {
    findUnique.mockResolvedValue({
      aiResponseTimeoutSeconds: AI_RESPONSE_TIMEOUT_MAX_SECONDS,
    });
    const expiryMs = DOCUMENT_INDEX_EXPIRE_SECONDS * 1000;
    const deadlineAt = expiryMs * JOB_BUDGET_SHARE;
    // The transcription takes its whole worst case before the staging plans.
    const stagingStarts = COMPLETION_CEILING_MS;
    const schedule = await stagingSchedule(
      "user-1",
      deadlineAt,
      () => stagingStarts,
    );
    const reads = Math.min(maxReadsFor(schedule), OCR_MAX_PAGES);
    const ends =
      stagingStarts + reads * OCR_EXTRACT_MODEL_CALLS * COMPLETION_CEILING_MS;
    expect(ends).toBeLessThan(expiryMs);
    // Without the deadline the staging would plan every part of a long
    // report: twenty reads of two calls, hours past the expiry.
    expect(
      stagingStarts +
        OCR_MAX_PAGES * OCR_EXTRACT_MODEL_CALLS * COMPLETION_CEILING_MS,
    ).toBeGreaterThan(expiryMs);
  });

  it("counts the transcription and the first read the deadline cannot refuse", () => {
    expect(DOCUMENT_INDEX_UNPLANNED_COMPLETIONS).toBe(
      1 + OCR_EXTRACT_MODEL_CALLS,
    );
    expect(DOCUMENT_INDEX_EXPIRE_SECONDS * 1000).toBeGreaterThan(
      DOCUMENT_INDEX_UNPLANNED_COMPLETIONS * COMPLETION_CEILING_MS,
    );
  });
});
