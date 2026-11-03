/**
 * The weekly backup of an account whose weight is in its stored bytes: the
 * document vault and the ECG traces (#1239).
 *
 * What this pins. The streaming writer pulled the three tables that are large
 * in ROWS through a page at a time, and read every other section whole. The
 * documents are large in BYTES instead (up to a hundred megabytes each), and
 * whole they cost about five times the vault in heap: the stored bytes, their
 * base64, the section's JSON, and the preview's copies of each row. A single
 * account with 190 MB of documents took a 524 MB process down every time its
 * weekly copy ran, while the measurements beside them (1.25 million rows)
 * fitted easily. Here the documents are read one at a time and each one's
 * bytes a slice at a time, and the traces a page at a time.
 *
 * Four things are proved on one fixture: the streamed copy is byte for byte
 * what the materialising builder writes, including documents that span
 * several slices and one that ends exactly on a slice boundary; the preview
 * taken from the writer agrees with a full read; the writer holds a bounded
 * amount while the materialised form does not fit that bound; and the copy
 * restores every document and strip exactly.
 */
import { createHash, randomBytes } from "node:crypto";
import v8 from "node:v8";
import vm from "node:vm";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { getPrismaClient, truncateAllTables } from "./setup";
import { readStoredBackup } from "./stored-backup-read";
import { encryptDocumentContent } from "@/lib/documents/store";
import { encryptWaveformToBytes } from "@/lib/withings/ecg-waveform-codec";
import { BackupKeyIdCollector } from "@/lib/export/backup-key-ids";
import { createBackupPreviewCollector } from "@/lib/export/backup-preview";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";
import { restoreBackup } from "@/lib/export/restore-backup";
import { storeBackupBlob } from "@/lib/export/store-backup-blob";
import { STORED_BACKUP_SELECT } from "@/lib/export/stored-backup";
import { parseBackupPayload } from "@/lib/validations/backup";
import { summarizeBackup } from "@/lib/validations/backup-summary";

const prisma = getPrismaClient();
const OWNER_ID = "backup-document-owner";

/** The slice the document reader takes (`DOCUMENT_SLICE_BYTES`). */
const SLICE = 1536 * 1024;
/** Ten documents of four megabytes: three slices each, the last one short. */
const LARGE_DOCUMENTS = 10;
const LARGE_BYTES = 4 * 1024 * 1024;
/** More strips than one page of the trace reader (50). */
const ECG_STRIPS = 120;

/**
 * What the writer may hold on top of the process's baseline. Measured on this
 * fixture: the streaming writer holds 4 MB (one slice, its base64, a page of
 * strips), and materialising it holds 61 MB. The bound sits with a wide
 * margin either side.
 */
const STREAM_BUDGET_BYTES = 16 * 1024 * 1024;

const forceGc = ((): (() => void) => {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  v8.setFlagsFromString("--no-expose-gc");
  return gc;
})();

function liveHeapBytes(): number {
  forceGc();
  forceGc();
  return process.memoryUsage().heapUsed;
}

function reportPeak(label: string, heldBytes: number): void {
  process.stderr.write(
    `[backup-document-memory] ${label}: ${Math.round(heldBytes / 1024 / 1024)} MB held, ` +
      `${Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024)} MB heap limit\n`,
  );
}

/** The ciphertext overhead of the active document codec, in bytes. */
const CODEC_OVERHEAD =
  encryptDocumentContent(Buffer.alloc(1)).content.byteLength - 1;

async function addDocument(index: number, cipherBytes: number): Promise<void> {
  const { content, codec } = encryptDocumentContent(
    randomBytes(Math.max(1, cipherBytes - CODEC_OVERHEAD)),
  );
  await prisma.inboundDocument.create({
    data: {
      id: `doc-${String(index).padStart(3, "0")}`,
      userId: OWNER_ID,
      filename: `scan-${index}.pdf`,
      mimeType: "application/pdf",
      byteSize: content.byteLength,
      contentEncrypted: content,
      contentCodec: codec,
      contentSha256: createHash("sha256").update(content).digest("hex"),
      title: `Scan ${index}`,
      // Two documents share an instant, so the order needs its tiebreak.
      createdAt: new Date(Date.UTC(2026, 0, 1 + Math.min(index, 5))),
    },
  });
}

async function seed(): Promise<void> {
  await prisma.user.create({
    data: { id: OWNER_ID, username: "backup-document-owner", role: "ADMIN" },
  });
  for (let i = 0; i < LARGE_DOCUMENTS; i++) await addDocument(i, LARGE_BYTES);
  // Exactly two slices: the reader has to stop on an empty third read.
  await addDocument(LARGE_DOCUMENTS, 2 * SLICE);
  // One short enough that the preview sees the whole value.
  await addDocument(LARGE_DOCUMENTS + 1, 200);
  const samples = Array.from({ length: 2_000 }, (_, i) =>
    Math.round(Math.sin(i / 9) * 800),
  );
  await prisma.ecgRecording.createMany({
    data: Array.from({ length: ECG_STRIPS }, (_, i) => ({
      id: `ecg-${String(i).padStart(4, "0")}`,
      userId: OWNER_ID,
      source: "APPLE_HEALTH" as const,
      externalRecordingId: `strip-${i}`,
      // Pairs share an instant (at two rates, the natural key), so the paged
      // order needs its tiebreak.
      recordedAt: new Date(Date.UTC(2025, 0, 1 + Math.floor(i / 2))),
      waveformEncrypted: encryptWaveformToBytes(samples),
      samplingFrequency: i % 2 === 0 ? 512 : 256,
      sampleCount: samples.length,
    })),
  });
}

async function documentsOf(userId: string) {
  const rows = await prisma.inboundDocument.findMany({
    where: { userId },
    orderBy: { id: "asc" },
    select: { id: true, byteSize: true, contentEncrypted: true, title: true },
  });
  return rows.map(({ contentEncrypted, ...row }) => ({
    ...row,
    sha: createHash("sha256").update(contentEncrypted).digest("hex"),
  }));
}

async function stripsOf(userId: string) {
  const rows = await prisma.ecgRecording.findMany({
    where: { userId },
    orderBy: { id: "asc" },
    select: { id: true, recordedAt: true, waveformEncrypted: true },
  });
  return rows.map(({ waveformEncrypted, ...row }) => ({
    ...row,
    waveform: Buffer.from(waveformEncrypted).toString("base64"),
  }));
}

describe("weekly backup of an account heavy in stored bytes", () => {
  beforeAll(async () => {
    expect(typeof forceGc).toBe("function");
    await truncateAllTables(prisma);
    await seed();
  }, 240_000);

  afterAll(async () => {
    await truncateAllTables(prisma);
  });

  it("writes what the materialising builder writes, and previews it alike", async () => {
    const exportedAt = new Date("2026-08-01T00:00:00.000Z");
    let streamed = "";
    const preview = await createBackupPreviewCollector();
    const counts = await streamFullBackupJson(
      prisma,
      OWNER_ID,
      (chunk) => {
        streamed += chunk;
      },
      { purpose: "disaster-recovery", exportedAt, observe: preview.observe },
    );
    expect(counts.documents).toBe(LARGE_DOCUMENTS + 2);
    expect(counts.ecgRecordings).toBe(ECG_STRIPS);

    const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
      purpose: "disaster-recovery",
      exportedAt,
    });
    expect(
      streamed === JSON.stringify(payload),
      "the streaming writer and the materialising builder disagree",
    ).toBe(true);

    const fromWriter = preview.finish(counts);
    expect(fromWriter).not.toBeNull();
    expect(fromWriter!.summary).toEqual(
      summarizeBackup(parseBackupPayload(streamed)),
    );
    const readBack = new BackupKeyIdCollector();
    readBack.visit(JSON.parse(streamed));
    expect(fromWriter!.keys.toStored()).toEqual(readBack.toStored());
  }, 300_000);

  it("holds a bounded amount of the vault while storing it", async () => {
    const baseline = liveHeapBytes();
    let peakHeld = 0;
    let pieces = 0;
    await storeBackupBlob(
      prisma,
      { userId: OWNER_ID, type: "WEEKLY_AUTO" },
      (write) =>
        streamFullBackupJson(
          prisma,
          OWNER_ID,
          async (chunk) => {
            await write(chunk);
            if (pieces++ % 8 === 0) {
              peakHeld = Math.max(peakHeld, liveHeapBytes() - baseline);
            }
          },
          { purpose: "disaster-recovery" },
        ),
    );
    peakHeld = Math.max(peakHeld, liveHeapBytes() - baseline);
    reportPeak("streamed", peakHeld);
    expect(peakHeld).toBeLessThan(STREAM_BUDGET_BYTES);

    // The other half: the same fixture, materialised, does not fit the bound,
    // so the bound above measures something.
    const before = liveHeapBytes();
    const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
      purpose: "disaster-recovery",
    });
    const json = JSON.stringify(payload);
    const held = liveHeapBytes() - before;
    reportPeak("materialised", held);
    expect(json.length).toBeGreaterThan(LARGE_DOCUMENTS * LARGE_BYTES);
    expect(held).toBeGreaterThan(STREAM_BUDGET_BYTES * 2);
  }, 300_000);

  it("restores every document and strip exactly from the stored copy", async () => {
    const documents = await documentsOf(OWNER_ID);
    const strips = await stripsOf(OWNER_ID);
    const { id } = await storeBackupBlob(
      prisma,
      { userId: OWNER_ID, type: "WEEKLY_AUTO" },
      (write) =>
        streamFullBackupJson(prisma, OWNER_ID, write, {
          purpose: "disaster-recovery",
        }),
    );
    const copy = JSON.parse(await readStoredBackup(prisma, id)) as {
      documents: Array<{ id: string; contentEncrypted: string }>;
    };
    expect(copy.documents).toHaveLength(LARGE_DOCUMENTS + 2);

    await prisma.inboundDocument.deleteMany({ where: { userId: OWNER_ID } });
    await prisma.ecgRecording.deleteMany({ where: { userId: OWNER_ID } });
    const backup = await prisma.dataBackup.findUniqueOrThrow({
      where: { id },
      select: STORED_BACKUP_SELECT,
    });
    const outcome = await restoreBackup({
      backup,
      actorUserId: OWNER_ID,
      ipAddress: null,
      restoreInstanceSettings: false,
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(await documentsOf(OWNER_ID)).toEqual(documents);
    expect(await stripsOf(OWNER_ID)).toEqual(strips);
  }, 300_000);
});
