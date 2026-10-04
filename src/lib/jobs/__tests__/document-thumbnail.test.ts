import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GitHub #1124 — the thumbnail job ran 355 times on one instance, left
 * sixteen PDFs without a preview, and the log held not one line about it:
 * the job opened no wide event, so every annotation went nowhere. Pins: each
 * run is a `job.document_thumbnail` background event; a run that should have
 * made a preview and did not is raised to `warn` with the reason; a type that
 * never has a preview stays at info.
 */

const {
  evt,
  findFirst,
  upsert,
  failureUpsert,
  failureDelete,
  generateThumbnail,
  withBackgroundEvent,
} = vi.hoisted(() => {
  const evt = { addMeta: vi.fn(), elevateLevel: vi.fn() };
  return {
    evt,
    findFirst: vi.fn(),
    upsert: vi.fn(),
    failureUpsert: vi.fn(),
    failureDelete: vi.fn(),
    generateThumbnail: vi.fn(),
    withBackgroundEvent: vi.fn(
      async (_name: string, fn: (e: typeof evt) => Promise<unknown>) => fn(evt),
    ),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: { findFirst },
    documentThumbnail: { upsert },
    documentThumbnailFailure: {
      upsert: failureUpsert,
      deleteMany: failureDelete,
    },
  },
}));
vi.mock("@/lib/documents/store", () => ({
  decryptDocumentContent: vi.fn(() => Buffer.from("%PDF-1.7")),
  encryptThumbnail: vi.fn(() => new Uint8Array([1])),
}));
vi.mock("@/lib/documents/thumbnail", () => ({ generateThumbnail }));
vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: vi.fn() }));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/logging/background", () => ({ withBackgroundEvent }));

import { runDocumentThumbnail } from "../document-thumbnail";

const DOC = {
  id: "doc-1",
  mimeType: "application/pdf",
  contentEncrypted: new Uint8Array([1]),
  contentCodec: "binary2",
  thumbnail: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue(DOC);
});

describe("runDocumentThumbnail wide event", () => {
  it("runs inside a background event named for the job", async () => {
    generateThumbnail.mockResolvedValue({ ok: false, reason: "raster-failed" });
    await runDocumentThumbnail({ userId: "user-1", documentId: "doc-1" });
    expect(withBackgroundEvent).toHaveBeenCalledWith(
      "job.document_thumbnail",
      expect.any(Function),
    );
    expect(evt.addMeta).toHaveBeenCalledWith("document_id", "doc-1");
  });

  it("warns with the reason when a PDF gets no preview", async () => {
    generateThumbnail.mockResolvedValue({ ok: false, reason: "error" });
    await runDocumentThumbnail({ userId: "user-1", documentId: "doc-1" });
    expect(evt.elevateLevel).toHaveBeenCalledWith("warn");
    expect(evt.addMeta).toHaveBeenCalledWith(
      "thumbnail_missing_reason",
      "error",
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it("stays at info for a type that never has a preview", async () => {
    findFirst.mockResolvedValue({ ...DOC, mimeType: "text/plain" });
    generateThumbnail.mockResolvedValue({
      ok: false,
      reason: "unsupported-type",
    });
    await runDocumentThumbnail({ userId: "user-1", documentId: "doc-1" });
    expect(evt.elevateLevel).not.toHaveBeenCalled();
  });

  it("stores the preview and stays at info when one is made", async () => {
    generateThumbnail.mockResolvedValue({
      ok: true,
      thumbnail: { jpeg: Buffer.from([0xff, 0xd8]), width: 2, height: 3 },
    });
    await runDocumentThumbnail({ userId: "user-1", documentId: "doc-1" });
    expect(upsert).toHaveBeenCalledOnce();
    expect(evt.elevateLevel).not.toHaveBeenCalled();
  });

  it("keeps a render failure so the backfill can stop queueing the document", async () => {
    generateThumbnail.mockResolvedValue({ ok: false, reason: "raster-failed" });
    await runDocumentThumbnail({ userId: "user-1", documentId: "doc-1" });
    expect(failureUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { documentId: "doc-1" },
        create: expect.objectContaining({
          userId: "user-1",
          reason: "raster-failed",
          attempts: 1,
        }),
        update: expect.objectContaining({ attempts: { increment: 1 } }),
      }),
    );
  });

  it("keeps no failure for a type that never has a preview, and clears one when a preview is made", async () => {
    findFirst.mockResolvedValue({ ...DOC, mimeType: "text/plain" });
    generateThumbnail.mockResolvedValue({
      ok: false,
      reason: "unsupported-type",
    });
    await runDocumentThumbnail({ userId: "user-1", documentId: "doc-1" });
    expect(failureUpsert).not.toHaveBeenCalled();

    findFirst.mockResolvedValue(DOC);
    generateThumbnail.mockResolvedValue({
      ok: true,
      thumbnail: { jpeg: Buffer.from([0xff, 0xd8]), width: 2, height: 3 },
    });
    await runDocumentThumbnail({ userId: "user-1", documentId: "doc-1" });
    expect(failureDelete).toHaveBeenCalledWith({
      where: { documentId: "doc-1" },
    });
  });
});

describe("thumbnailRetryDue", () => {
  const at = new Date("2026-10-01T00:00:00Z");
  const before = new Date("2026-09-30T00:00:00Z");
  const after = new Date("2026-10-02T00:00:00Z");

  it("retries a document with no failure, and one that changed since", async () => {
    const { thumbnailRetryDue } =
      await import("../document-thumbnail-backfill");
    expect(thumbnailRetryDue(null, before)).toBe(true);
    expect(
      thumbnailRetryDue(
        { reason: "raster-failed", attempts: 1, failedAt: at },
        after,
      ),
    ).toBe(true);
  });

  it("settles a deterministic refusal after one try and a throw after three", async () => {
    const { thumbnailRetryDue } =
      await import("../document-thumbnail-backfill");
    for (const reason of ["raster-failed", "empty-render", "pixel-cap"]) {
      expect(
        thumbnailRetryDue({ reason, attempts: 1, failedAt: at }, before),
      ).toBe(false);
    }
    expect(
      thumbnailRetryDue({ reason: "error", attempts: 2, failedAt: at }, before),
    ).toBe(true);
    expect(
      thumbnailRetryDue({ reason: "error", attempts: 3, failedAt: at }, before),
    ).toBe(false);
  });
});
