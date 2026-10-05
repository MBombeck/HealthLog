/**
 * The preview a weekly copy carries is worked out from the counts the writer
 * already produces, not by parsing the copy a second time.
 *
 * What this pins. From v1.39.6 the preview scanner parsed the JSON on its way
 * into the pieces, kept every section that is not one of the three bulk tables
 * (documents with their ciphertext, coach turns, profiles), and validated the
 * whole document at the end. On an account with a document vault that is a
 * second full copy of the record beside the writer's own, inside the weekly
 * job that shares the app's heap.
 *
 * How it measures. Like `backup-streaming-memory.test.ts`: every reading is
 * taken after a forced collection, so what is compared is what the pass
 * HOLDS. The reading at the end of the producer is the one that matters: the
 * writer has released its sections by then, so anything still held belongs
 * to the preview. Run under `--max-old-space-size=524` (the V8 limit of a
 * 1 GB container) for the production ceiling.
 */
import { randomBytes } from "node:crypto";
import v8 from "node:v8";
import vm from "node:vm";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBackupPreviewCollector } from "@/lib/export/backup-preview";
import type { FullBackupCounts } from "@/lib/export/full-backup-payload";
import { storeBackupBlob } from "@/lib/export/store-backup-blob";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";
import { getPrismaClient, truncateAllTables } from "./setup";

const OWNER_ID = "backup-preview-memory-owner";
const MEASUREMENT_ROWS = 70_000;
const MOOD_ROWS = 3_000;
const DOCUMENTS = 40;
const DOCUMENT_BYTES = 1024 * 1024;

/**
 * What the pass may still hold once the producer is done. Measured: the
 * scanner that kept the sections held about twice the document vault at
 * that point (the parsed sections and the base64 text inside them); the
 * pass without it holds a few megabytes.
 */
const HELD_AT_END_BUDGET_BYTES = 16 * 1024 * 1024;

const prisma = getPrismaClient();

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

const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024);

async function seed(): Promise<void> {
  await prisma.user.create({
    data: { id: OWNER_ID, username: "backup-preview-memory" },
  });
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (
       id, user_id, type, value, unit, source, measured_at, notes,
       notes_encrypted, external_id, created_at, updated_at, sync_version)
     SELECT
       'pm' || lpad(g::text, 10, '0'), $1, 'PULSE'::measurement_type,
       60 + (g % 40), 'bpm', 'APPLE_HEALTH'::measurement_source,
       timestamp '2019-01-01 00:00:00' + (g * interval '30 seconds'),
       CASE WHEN g % 40 = 0 THEN 'a note recorded with reading ' || g END,
       CASE WHEN g % 25 = 0
            THEN decode(md5(g::text) || md5((g + 1)::text), 'hex') END,
       'preview-' || g,
       timestamp '2019-01-01 00:00:00' + (g * interval '30 seconds'),
       timestamp '2019-01-01 00:00:00' + (g * interval '30 seconds'),
       1
     FROM generate_series(1, ${MEASUREMENT_ROWS}) AS g`,
    OWNER_ID,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO mood_entries (
       id, user_id, date, mood, score, source, mood_logged_at, synced_at,
       created_at, updated_at, tz, note, sync_version)
     SELECT
       'pd' || lpad(g::text, 10, '0'), $1,
       to_char(timestamp '2019-01-01' + (g * interval '1 day'), 'YYYY-MM-DD'),
       'okay', 3, 'MOODLOG', timestamp '2019-01-01' + (g * interval '1 day'),
       now(), now(), now(), 'Europe/Berlin', 'a journal line about day ' || g, 1
     FROM generate_series(1, ${MOOD_ROWS}) AS g`,
    OWNER_ID,
  );
  for (let i = 0; i < DOCUMENTS; i++) {
    await prisma.inboundDocument.create({
      data: {
        userId: OWNER_ID,
        mimeType: "application/pdf",
        byteSize: DOCUMENT_BYTES,
        contentEncrypted: new Uint8Array(randomBytes(DOCUMENT_BYTES)),
        contentCodec: "binary2",
        title: `document ${i}`,
      },
    });
  }
}

describe("weekly copy preview under a memory budget", () => {
  beforeAll(async () => {
    await truncateAllTables(prisma);
    await seed();
  }, 240_000);

  afterAll(async () => {
    await truncateAllTables(prisma);
  });

  it("holds nothing of the record once the producer is done", async () => {
    // The backup schema the preview checks each section against is a module
    // loaded once per process (about 12 MB, `backup-summary.ts`), not memory
    // that grows with the record: load it before the baseline, as a running
    // server has long since done.
    await import("@/lib/validations/backup");
    const baseline = liveHeapBytes();
    let peakHeld = 0;
    let heldAtEnd = 0;
    let rawPeak = 0;
    let chunks = 0;
    const poll = setInterval(() => {
      rawPeak = Math.max(rawPeak, process.memoryUsage().heapUsed);
    }, 5);
    // Wired exactly as the weekly job wires it (`backup-handlers.ts`).
    const preview = await createBackupPreviewCollector();
    let counts: FullBackupCounts | undefined;
    try {
      await storeBackupBlob(
        prisma,
        {
          userId: OWNER_ID,
          type: "WEEKLY_AUTO",
          preview: () => (counts ? preview.finish(counts) : null),
        },
        async (write) => {
          counts = await streamFullBackupJson(
            prisma,
            OWNER_ID,
            async (chunk) => {
              await write(chunk);
              if (chunks++ % 40 === 0) {
                peakHeld = Math.max(peakHeld, liveHeapBytes() - baseline);
              }
            },
            { purpose: "disaster-recovery", observe: preview.observe },
          );
          heldAtEnd = liveHeapBytes() - baseline;
          peakHeld = Math.max(peakHeld, heldAtEnd);
        },
      );
    } finally {
      clearInterval(poll);
    }
    rawPeak = Math.max(rawPeak, process.memoryUsage().heapUsed);
    process.stderr.write(
      `[preview-memory] held at end of producer ${mb(heldAtEnd)} MB, ` +
        `peak held ${mb(peakHeld)} MB, raw peak heapUsed ${mb(rawPeak)} MB ` +
        `(baseline ${mb(baseline)} MB), ` +
        `${mb(v8.getHeapStatistics().heap_size_limit)} MB heap limit\n`,
    );

    const row = await prisma.dataBackup.findFirstOrThrow({
      where: { userId: OWNER_ID, type: "WEEKLY_AUTO" },
      select: { preview: true },
    });
    expect(row.preview).toMatchObject({
      summary: {
        measurements: MEASUREMENT_ROWS,
        moodEntries: MOOD_ROWS,
        documents: DOCUMENTS,
      },
    });
    expect(
      heldAtEnd,
      `the pass still held ${mb(heldAtEnd)} MB after the producer finished`,
    ).toBeLessThan(HELD_AT_END_BUDGET_BYTES);
  }, 600_000);
});
