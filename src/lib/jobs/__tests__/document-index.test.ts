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

import {
  DOCUMENT_INDEX_QUEUE,
  enqueueDocumentIndex,
  runDocumentIndex,
} from "../document-index";
import { indexDocumentContent } from "@/lib/documents/index-document";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { maybeAutoStageLabFacts } from "@/lib/documents/auto-stage-labs";

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
      expect.objectContaining({ singletonKey: "document-index|doc-1" }),
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
    vi.mocked(indexDocumentContent).mockResolvedValue({
      indexed: true,
      source: "local-pdf",
      tokenCount: 3,
    } as never);
    await runDocumentIndex({ userId: "user-1", documentId: "doc-1" });
    expect(indexDocumentContent).toHaveBeenCalledWith("user-1", "doc-1", {
      localOnly: false,
    });
    expect(maybeAutoStageLabFacts).toHaveBeenCalledWith("user-1", "doc-1");
  });

  it("a deferred import indexes locally and stages no lab facts", async () => {
    vi.mocked(indexDocumentContent).mockResolvedValue({
      indexed: true,
      source: "local-pdf",
      tokenCount: 3,
    } as never);
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
