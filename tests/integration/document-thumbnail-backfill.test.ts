/**
 * A document whose preview cannot be rendered is not queued again on every
 * boot.
 *
 * What this pins. The boot-time backfill queued every thumbnailable document
 * without a thumbnail, and a PDF whose first page renders blank never gets
 * one: it was queued, rendered, refused, and queued again at the next boot,
 * forever. The failure is now kept with the document, the backfill leaves a
 * document that failed for good alone, and a document that changed after the
 * failure is tried once more. A preview that does get made clears it.
 *
 * Both ends against the real schema: the job writes the failure, the boot
 * discovery and the per-account pass read it. Only the renderer and the queue
 * are stand-ins, so the outcome of a render can be chosen.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateThumbnail = vi.hoisted(() => vi.fn());
const sends = vi.hoisted(() => [] as Array<{ queue: string; data: unknown }>);

vi.mock("@/lib/documents/thumbnail", () => ({ generateThumbnail }));
vi.mock("@/lib/documents/native-canvas-support", () => ({
  nativeCanvasSupported: () => true,
}));
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({
    send: async (queue: string, data: unknown) => {
      sends.push({ queue, data });
      return `job-${sends.length}`;
    },
  }),
}));

import { encryptDocumentContent } from "@/lib/documents/store";
import { runDocumentThumbnail } from "@/lib/jobs/document-thumbnail";
import {
  enqueueBootTimeThumbnailBackfill,
  runThumbnailBackfillForUser,
} from "@/lib/jobs/document-thumbnail-backfill";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const USER_ID = "thumbnail-backfill-owner";

async function seedPdf(id: string) {
  const { content, codec } = encryptDocumentContent(
    Buffer.from("%PDF-1.7 a page that renders blank"),
  );
  await prisma.inboundDocument.create({
    data: {
      id,
      userId: USER_ID,
      mimeType: "application/pdf",
      byteSize: 32,
      contentEncrypted: content,
      contentCodec: codec,
      title: id,
    },
  });
}

function queuedDocuments(): string[] {
  return sends
    .filter((s) => s.queue === "document-thumbnail")
    .map((s) => (s.data as { documentId: string }).documentId);
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  sends.length = 0;
  generateThumbnail.mockReset();
  await prisma.user.create({
    data: { id: USER_ID, username: "thumbnail-backfill-owner" },
  });
});

describe("thumbnail backfill and a render that fails for good", () => {
  it("leaves a document whose render failed for good out of every later backfill", async () => {
    await seedPdf("doc-blank");
    await seedPdf("doc-fine");
    generateThumbnail.mockResolvedValue({ ok: false, reason: "raster-failed" });
    await runDocumentThumbnail({ userId: USER_ID, documentId: "doc-blank" });

    sends.length = 0;
    await runThumbnailBackfillForUser(USER_ID);
    expect(queuedDocuments()).toEqual(["doc-fine"]);

    // The boot discovery still finds the account, for the other document,
    // and stops finding it once that one has its preview.
    sends.length = 0;
    expect((await enqueueBootTimeThumbnailBackfill()).enqueued).toBe(1);
    generateThumbnail.mockResolvedValue({
      ok: true,
      thumbnail: { jpeg: Buffer.from([0xff, 0xd8, 0xff]), width: 2, height: 3 },
    });
    await runDocumentThumbnail({ userId: USER_ID, documentId: "doc-fine" });
    sends.length = 0;
    expect((await enqueueBootTimeThumbnailBackfill()).enqueued).toBe(0);
    expect(await runThumbnailBackfillForUser(USER_ID)).toEqual({ enqueued: 0 });
  });

  it("tries a failed document again once it has changed, and forgets the failure when a preview is made", async () => {
    await seedPdf("doc-blank");
    generateThumbnail.mockResolvedValue({ ok: false, reason: "raster-failed" });
    await runDocumentThumbnail({ userId: USER_ID, documentId: "doc-blank" });
    sends.length = 0;
    expect(await runThumbnailBackfillForUser(USER_ID)).toEqual({ enqueued: 0 });

    // A later edit is a change: the document is tried once more.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await prisma.inboundDocument.update({
      where: { id: "doc-blank" },
      data: { title: "renamed" },
    });
    expect(await runThumbnailBackfillForUser(USER_ID)).toEqual({ enqueued: 1 });
    sends.length = 0;
    expect((await enqueueBootTimeThumbnailBackfill()).enqueued).toBe(1);

    generateThumbnail.mockResolvedValue({
      ok: true,
      thumbnail: { jpeg: Buffer.from([0xff, 0xd8, 0xff]), width: 2, height: 3 },
    });
    await runDocumentThumbnail({ userId: USER_ID, documentId: "doc-blank" });
    expect(
      await prisma.documentThumbnailFailure.count({
        where: { documentId: "doc-blank" },
      }),
    ).toBe(0);
  });

  it("gives a render that failed by a throw three tries, not one", async () => {
    await seedPdf("doc-flaky");
    generateThumbnail.mockResolvedValue({ ok: false, reason: "error" });
    for (let attempt = 1; attempt <= 3; attempt++) {
      sends.length = 0;
      expect(await runThumbnailBackfillForUser(USER_ID)).toEqual({
        enqueued: 1,
      });
      await runDocumentThumbnail({ userId: USER_ID, documentId: "doc-flaky" });
    }
    expect(await runThumbnailBackfillForUser(USER_ID)).toEqual({ enqueued: 0 });
  });
});
