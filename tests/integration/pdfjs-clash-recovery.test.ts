/**
 * Migrations 0478 and 0479: what a pdf.js clash left behind gets one more try
 * after the update, through the paths that run on their own.
 *
 * While the server loaded two pdf.js versions, whichever ran first broke the
 * other until a restart. Previews failed as `raster-failed`, which the
 * thumbnail backfill treats as final, and local text reads failed as
 * `decrypt-error`, which nothing on an instance without an AI provider ever
 * retries. The rows are seeded the way such an instance holds them, the data
 * step is read out of each migration file and executed, and then only what a
 * boot runs on its own is called: the boot discovery and the jobs it enqueues.
 * The renderer, the text reader and the database are real; the queue records
 * what was sent, and the test runs each job it holds.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { jsPDF } from "jspdf";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sends = vi.hoisted(() => [] as Array<{ queue: string; data: unknown }>);

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
import {
  runDocumentIndex,
  type DocumentIndexPayload,
} from "@/lib/jobs/document-index";
import { enqueueBootTimeIndexRetry } from "@/lib/jobs/document-index-retry";
import { runDocumentThumbnail } from "@/lib/jobs/document-thumbnail";
import {
  enqueueBootTimeThumbnailBackfill,
  runThumbnailBackfillForUser,
  type ThumbnailBackfillPayload,
} from "@/lib/jobs/document-thumbnail-backfill";
import { MAINTENANCE_DISCOVERY } from "@/lib/jobs/registry/maintenance-discovery";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const USER_ID = "pdfjs-clash-owner";

/** The one data statement of a migration file, comments removed. */
function migrationStep(name: string): string {
  const sql = readFileSync(
    path.join(process.cwd(), "prisma", "migrations", name, "migration.sql"),
    "utf8",
  )
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim();
  const statements = sql.split(";").filter((s) => s.trim().length > 0);
  expect(statements, name).toHaveLength(1);
  return statements[0]!;
}

/** Run one pass of the worker's boot discovery, found by its name. */
async function boot(name: string): Promise<number> {
  const pass = MAINTENANCE_DISCOVERY.find((d) => d.name === name);
  expect(pass, `boot discovery ${name}`).toBeDefined();
  const result = await pass!.run();
  return Number(result?.enqueued ?? 0);
}

const LETTER = readFileSync(
  path.join(process.cwd(), "tests", "fixtures", "pdf", "fallback-fonts.pdf"),
);

function textPdf(): Buffer {
  const doc = new jsPDF();
  doc.text("Discharge letter creatinine 0.9 mg/dL haemoglobin 14.2", 10, 10);
  return Buffer.from(doc.output("arraybuffer"));
}

async function seedPdf(
  id: string,
  bytes: Buffer,
  extra: { lastIndexOutcome?: string; lastIndexAttemptAt?: Date } = {},
  corrupt = false,
) {
  const { content, codec } = encryptDocumentContent(bytes);
  if (corrupt) content[Math.floor(content.length / 2)] ^= 0xff;
  await prisma.inboundDocument.create({
    data: {
      id,
      userId: USER_ID,
      mimeType: "application/pdf",
      byteSize: bytes.length,
      contentEncrypted: content,
      contentCodec: codec,
      title: id,
      ...extra,
    },
  });
}

function takeSends(queue: string): unknown[] {
  const taken = sends.filter((s) => s.queue === queue).map((s) => s.data);
  sends.length = 0;
  return taken;
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  sends.length = 0;
  await prisma.user.create({
    data: { id: USER_ID, username: "pdfjs-clash-owner" },
  });
});

describe("0478: previews that failed to rasterize", () => {
  it("are rendered again by the boot backfill, once", async () => {
    await seedPdf("doc-letter", LETTER);
    await prisma.documentThumbnailFailure.create({
      data: {
        documentId: "doc-letter",
        userId: USER_ID,
        reason: "raster-failed",
        attempts: 1,
        failedAt: new Date(),
      },
    });
    // Final as stored: no boot finds it.
    expect((await enqueueBootTimeThumbnailBackfill()).enqueued).toBe(0);

    await prisma.$executeRawUnsafe(
      migrationStep("0478_retry_raster_failed_thumbnails"),
    );

    expect(await boot("document-thumbnail-backfill")).toBe(1);
    const [backfill] = takeSends("document-thumbnail-backfill") as [
      ThumbnailBackfillPayload,
    ];
    await runThumbnailBackfillForUser(backfill.userId);
    const jobs = takeSends("document-thumbnail") as Array<{
      userId: string;
      documentId: string;
    }>;
    expect(jobs.map((j) => j.documentId)).toEqual(["doc-letter"]);
    await runDocumentThumbnail(jobs[0]!);

    expect(
      await prisma.documentThumbnail.count({
        where: { documentId: "doc-letter" },
      }),
    ).toBe(1);
    expect(await prisma.documentThumbnailFailure.count()).toBe(0);
    expect((await enqueueBootTimeThumbnailBackfill()).enqueued).toBe(0);
  });

  it("leaves a page that really renders blank settled after its one retry", async () => {
    const blank = readFileSync(
      path.join(
        process.cwd(),
        "tests",
        "fixtures",
        "pdf",
        "invisible-text-only.pdf",
      ),
    );
    await seedPdf("doc-blank", blank);
    await prisma.documentThumbnailFailure.create({
      data: {
        documentId: "doc-blank",
        userId: USER_ID,
        reason: "raster-failed",
        attempts: 1,
        failedAt: new Date(),
      },
    });
    await prisma.$executeRawUnsafe(
      migrationStep("0478_retry_raster_failed_thumbnails"),
    );
    expect((await enqueueBootTimeThumbnailBackfill()).enqueued).toBe(1);
    takeSends("document-thumbnail-backfill");
    await runThumbnailBackfillForUser(USER_ID);
    const jobs = takeSends("document-thumbnail") as Array<{
      userId: string;
      documentId: string;
    }>;
    await runDocumentThumbnail(jobs[0]!);

    const failure = await prisma.documentThumbnailFailure.findUnique({
      where: { documentId: "doc-blank" },
    });
    expect(failure).toMatchObject({ reason: "raster-failed", attempts: 1 });
    expect((await enqueueBootTimeThumbnailBackfill()).enqueued).toBe(0);
  });
});

describe("0479: PDFs whose local text read failed", () => {
  it("indexes a readable one and settles an unreadable one after one retry", async () => {
    const failedAt = new Date("2026-10-20T10:00:00.000Z");
    const failed = {
      lastIndexOutcome: "decrypt-error",
      lastIndexAttemptAt: failedAt,
    };
    await seedPdf("doc-text", textPdf(), failed);
    await seedPdf("doc-cipher-broken", textPdf(), failed, true);
    await seedPdf("doc-not-a-pdf", Buffer.from("not a pdf at all"), failed);
    // Never attempted, and a failure no clash produces: both left alone.
    await seedPdf("doc-never", textPdf());
    await seedPdf("doc-scan", textPdf(), {
      lastIndexOutcome: "local-empty",
      lastIndexAttemptAt: failedAt,
    });

    expect((await enqueueBootTimeIndexRetry()).enqueued).toBe(0);

    await prisma.$executeRawUnsafe(
      migrationStep("0479_retry_failed_local_pdf_index"),
    );

    expect(await boot("document-index-retry")).toBe(3);
    const jobs = takeSends("document-index") as DocumentIndexPayload[];
    expect(jobs.map((j) => j.documentId).sort()).toEqual([
      "doc-cipher-broken",
      "doc-not-a-pdf",
      "doc-text",
    ]);
    // The upload's job, not a narrower one: no local-only flag.
    expect(jobs.every((j) => j.localOnly === undefined)).toBe(true);
    for (const job of jobs) await runDocumentIndex(job);

    const rows = await prisma.inboundDocument.findMany({
      select: {
        id: true,
        lastIndexOutcome: true,
        lastIndexAttemptAt: true,
        contentIndex: { select: { source: true } },
      },
      orderBy: { id: "asc" },
    });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId["doc-text"]).toMatchObject({
      lastIndexOutcome: null,
      contentIndex: { source: "local-pdf" },
    });
    for (const id of ["doc-cipher-broken", "doc-not-a-pdf"]) {
      expect(byId[id]!.contentIndex, id).toBeNull();
      expect(byId[id]!.lastIndexOutcome, id).toBe("decrypt-error");
      expect(byId[id]!.lastIndexAttemptAt!.getTime(), id).toBeGreaterThan(
        failedAt.getTime(),
      );
    }
    expect(byId["doc-never"]).toMatchObject({
      lastIndexAttemptAt: null,
      lastIndexOutcome: null,
      contentIndex: null,
    });
    expect(byId["doc-scan"]).toMatchObject({
      lastIndexOutcome: "local-empty",
      lastIndexAttemptAt: failedAt,
    });

    // Every later boot finds nothing.
    expect((await enqueueBootTimeIndexRetry()).enqueued).toBe(0);
    expect(takeSends("document-index")).toEqual([]);
  });

  it("keeps the mark while the documents module is off", async () => {
    await seedPdf("doc-text", textPdf(), {
      lastIndexOutcome: "decrypt-error",
      lastIndexAttemptAt: new Date(),
    });
    await prisma.$executeRawUnsafe(
      migrationStep("0479_retry_failed_local_pdf_index"),
    );
    await prisma.user.update({
      where: { id: USER_ID },
      data: { modulePreferencesJson: { inboundDocuments: false } },
    });
    expect((await enqueueBootTimeIndexRetry()).enqueued).toBe(0);
    expect(
      await prisma.inboundDocument.findUnique({
        where: { id: "doc-text" },
        select: { lastIndexAttemptAt: true },
      }),
    ).toEqual({ lastIndexAttemptAt: null });
  });
});
