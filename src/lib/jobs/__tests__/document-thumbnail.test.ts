import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GitHub #1124 — the thumbnail job ran 355 times on one instance, left
 * sixteen PDFs without a preview, and the log held not one line about it:
 * the job opened no wide event, so every annotation went nowhere. Pins: each
 * run is a `job.document_thumbnail` background event; a run that should have
 * made a preview and did not is raised to `warn` with the reason; a type that
 * never has a preview stays at info.
 */

const { evt, findFirst, upsert, generateThumbnail, withBackgroundEvent } =
  vi.hoisted(() => {
    const evt = { addMeta: vi.fn(), elevateLevel: vi.fn() };
    return {
      evt,
      findFirst: vi.fn(),
      upsert: vi.fn(),
      generateThumbnail: vi.fn(),
      withBackgroundEvent: vi.fn(
        async (_name: string, fn: (e: typeof evt) => Promise<unknown>) =>
          fn(evt),
      ),
    };
  });

vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: { findFirst },
    documentThumbnail: { upsert },
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
});
