/**
 * The nightly off-host backup, run against a record big enough to have killed
 * the process, with its live memory measured rather than assumed.
 *
 * What this pins. The weekly in-database pass learned to stream in v1.38.6;
 * the off-host one did not. It shared the payload BUILDER and nothing after
 * it, so it still made the whole JSON as one string, gzipped that whole
 * string, ran a whole-buffer cipher pass over the result and handed the
 * finished buffer to `PutObject` — four full copies of the record alive at
 * once. On the live instance that was `FATAL ERROR: Reached heap limit`
 * seventeen seconds into the first run, and because the job shares the app
 * process, one account's size restarted the instance for everybody on it.
 *
 * Why it measures the way it does. `process.memoryUsage().heapUsed` on its own
 * is not a measurement: V8 lets garbage float in proportion to the heap limit,
 * and a test fork's limit is several times a container's, so the same code
 * "peaks" at wildly different numbers depending on who is running it. Every
 * reading below is taken after a forced collection, so what is compared is
 * what each writer HOLDS.
 *
 * The two halves are the whole point. One says the streaming uploader stays
 * inside a budget; the other says the materialising path does not fit that
 * budget on the same fixture in the same process. Without the second, the
 * budget could be any number at all and the first would still pass — green
 * because nothing was measured rather than because something was proved.
 *
 * The uploader here is an in-process stand-in that counts bytes and throws
 * them away, which is what a socket does. A run against a real bucket lives in
 * `docs/ops/backup-restore.md`; what this file can prove on every gate run is
 * the arithmetic, and the arithmetic is what killed the container.
 */
import { Buffer } from "node:buffer";
import type { Readable } from "node:stream";
import v8 from "node:v8";
import vm from "node:vm";

import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";
import {
  OffhostBackupTooLargeError,
  decryptBackup,
  encryptBackup,
  uploadEncryptedBackup,
  type S3Like,
} from "@/lib/jobs/offhost-backup";
import { getPrismaClient, truncateAllTables } from "./setup";

const OWNER_ID = "offhost-streaming-owner";
const MEASUREMENT_ROWS = 120_000;
const MOOD_ROWS = 8_000;
const INTAKE_ROWS = 20_000;

/** The dedicated off-host key, separate from `ENCRYPTION_KEYS` by design. */
const BACKUP_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "hex",
);

/**
 * What the streaming uploader may hold on top of the process's own baseline.
 *
 * Measured, not chosen: on this fixture the uploader holds a page of rows, one
 * gzip window and the object bytes still in flight, and the materialising path
 * holds the JSON string and the object at once. The budget sits with a wide
 * margin either side of that pair, which is what makes it a test rather than a
 * coin toss.
 */
const STREAM_BUDGET_BYTES = 48 * 1024 * 1024;

const prisma = getPrismaClient();

/**
 * A collection this process can ask for, without the runner having to be
 * started with `--expose-gc`.
 */
const forceGc = ((): (() => void) => {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  v8.setFlagsFromString("--no-expose-gc");
  return gc;
})();

/** Heap held after a forced collection. Garbage is not a measurement. */
function liveHeapBytes(): number {
  forceGc();
  forceGc();
  return process.memoryUsage().heapUsed;
}

/**
 * The one number this file exists to produce, on stderr where a gate run keeps
 * it. Peaks are the evidence, and evidence that only prints on failure is not
 * evidence.
 */
function reportPeak(label: string, heldBytes: number): void {
  const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024);
  process.stderr.write(
    `[offhost-memory] ${label}: peak ${mb(heldBytes)} MB held by the backup, ` +
      `${mb(v8.getHeapStatistics().heap_size_limit)} MB heap limit\n`,
  );
}

/**
 * A bucket that behaves like a socket: it consumes what it is handed and keeps
 * only the byte count, plus — for the one key the restore assertion reads —
 * the object itself, which on this fixture is a couple of megabytes next to a
 * 48 MB budget.
 */
function makeCountingS3(keep?: string): S3Like & {
  bytes: number;
  kept: Buffer | null;
  onChunk?: () => void;
} {
  const sink = {
    bytes: 0,
    kept: null as Buffer | null,
    onChunk: undefined as (() => void) | undefined,
    putStream: async (key: string, body: Readable): Promise<void> => {
      const held: Buffer[] = [];
      for await (const chunk of body) {
        const piece = Buffer.from(chunk as Uint8Array);
        sink.bytes += piece.byteLength;
        if (key === keep) held.push(piece);
        sink.onChunk?.();
      }
      if (key === keep) sink.kept = Buffer.concat(held);
    },
    putObject: async (): Promise<void> => {
      throw new Error("the nightly pass must never take the whole-buffer arm");
    },
    getObject: async (): Promise<Buffer> => {
      throw new Error("not used");
    },
    headObject: async (): Promise<boolean> => false,
    listObjects: async (): Promise<Array<{ key: string }>> => [],
    deleteObject: async (): Promise<void> => {},
  };
  return sink;
}

async function seedLargeRecord(): Promise<void> {
  await prisma.user.create({
    data: { id: OWNER_ID, username: "offhost-streaming-owner" },
  });
  await prisma.medication.create({
    data: {
      id: "offhost-med",
      userId: OWNER_ID,
      name: "Seeded",
      dose: "10 mg",
    },
  });
  // One statement, one round trip. Notes on one row in forty and ciphertext on
  // one in twenty-five so the base64 arm of the serialiser is exercised at
  // scale, and one in two hundred is a tombstone because a backup that drops
  // them resurrects deleted readings on the next device sync.
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (
       id, user_id, type, value, unit, source, measured_at, notes,
       notes_encrypted, external_id, created_at, updated_at, sync_version,
       deleted_at)
     SELECT
       'ox' || lpad(g::text, 10, '0'),
       $1,
       'PULSE'::measurement_type,
       60 + (g % 40),
       'bpm',
       'APPLE_HEALTH'::measurement_source,
       timestamp '2019-01-01 00:00:00' + (g * interval '30 seconds'),
       CASE WHEN g % 40 = 0 THEN 'a note recorded with reading ' || g END,
       CASE WHEN g % 25 = 0
            THEN decode(md5(g::text) || md5((g + 1)::text), 'hex') END,
       'offhost-stream-' || g,
       timestamp '2019-01-01 00:00:00' + (g * interval '30 seconds'),
       timestamp '2019-01-01 00:00:00' + (g * interval '30 seconds'),
       1,
       CASE WHEN g % 200 = 0
            THEN timestamp '2026-01-01 00:00:00' + (g * interval '1 second') END
     FROM generate_series(1, ${MEASUREMENT_ROWS}) AS g`,
    OWNER_ID,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO mood_entries (
       id, user_id, date, mood, score, source, mood_logged_at, synced_at,
       created_at, updated_at, tz, note, sync_version, deleted_at)
     SELECT
       'oy' || lpad(g::text, 10, '0'),
       $1,
       to_char(timestamp '2019-01-01' + (g * interval '1 hour'), 'YYYY-MM-DD'),
       'okay', 3, 'MOODLOG',
       timestamp '2019-01-01' + (g * interval '1 hour'),
       now(), now(), now(), 'Europe/Berlin',
       CASE WHEN g % 3 = 0 THEN 'a journal line about day ' || g END,
       1,
       CASE WHEN g % 150 = 0 THEN now() END
     FROM generate_series(1, ${MOOD_ROWS}) AS g`,
    OWNER_ID,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO medication_intake_events (
       id, user_id, medication_id, scheduled_for, taken_at, skipped, source,
       created_at, updated_at, sync_version, deleted_at, dose_taken)
     SELECT
       'oz' || lpad(g::text, 10, '0'),
       $1,
       'offhost-med',
       timestamp '2019-01-01' + (g * interval '10 minutes'),
       CASE WHEN g % 7 <> 0
            THEN timestamp '2019-01-01' + (g * interval '10 minutes') END,
       (g % 7 = 0),
       'WEB'::intake_source,
       timestamp '2019-01-01' + (g * interval '10 minutes'),
       timestamp '2019-01-01' + (g * interval '10 minutes'),
       1,
       CASE WHEN g % 300 = 0 THEN now() END,
       '10 mg'
     FROM generate_series(1, ${INTAKE_ROWS}) AS g`,
    OWNER_ID,
  );
}

describe("off-host backup under a memory budget", () => {
  beforeAll(async () => {
    expect(
      typeof forceGc,
      "without a real collection every reading in this file measures " +
        "uncollected garbage and nothing here can fail",
    ).toBe("function");
    await truncateAllTables(prisma);
    await seedLargeRecord();
  }, 240_000);

  afterAll(async () => {
    await truncateAllTables(prisma);
  });

  it("uploads a restorable object while holding a bounded amount of the record", async () => {
    const objectKey = "2026-09-05/user-offhost-streaming-owner.json.enc";
    const s3 = makeCountingS3(objectKey);
    const baseline = liveHeapBytes();
    let peakHeld = 0;
    let samples = 0;
    // Sampled rather than continuous: a forced collection per chunk would
    // dominate the runtime, and one in twenty still lands inside every phase
    // of the walk.
    s3.onChunk = () => {
      if (samples++ % 20 === 0) {
        peakHeld = Math.max(peakHeld, liveHeapBytes() - baseline);
      }
    };

    const objectBytes = await uploadEncryptedBackup(
      s3,
      objectKey,
      BACKUP_KEY,
      (write) =>
        // The purpose the nightly job asks for: tombstones and ciphertext ride
        // verbatim, which is the arm that has to fit in memory.
        streamFullBackupJson(prisma, OWNER_ID, write, {
          purpose: "disaster-recovery",
        }),
    );
    peakHeld = Math.max(peakHeld, liveHeapBytes() - baseline);
    reportPeak("large record", peakHeld);

    expect(objectBytes).toBe(s3.bytes);
    expect(
      peakHeld,
      `the streaming uploader held ${Math.round(peakHeld / 1024 / 1024)} MB ` +
        "of a record it is supposed to pass through a page at a time",
    ).toBeLessThan(STREAM_BUDGET_BYTES);

    // An object that writes but does not read is worse than none.
    const restored = JSON.parse(decryptBackup(s3.kept!, BACKUP_KEY)) as {
      measurements: Array<{ deletedAt: string | null }>;
      moodEntries: unknown[];
      intakeEvents: unknown[];
    };
    expect(restored.measurements).toHaveLength(MEASUREMENT_ROWS);
    expect(restored.moodEntries).toHaveLength(MOOD_ROWS);
    expect(restored.intakeEvents).toHaveLength(INTAKE_ROWS);
    // Tombstones ride along, or the next device sync resurrects them.
    expect(
      restored.measurements.filter((row) => row.deletedAt !== null).length,
    ).toBe(Math.floor(MEASUREMENT_ROWS / 200));
  }, 300_000);

  it("would not fit that budget if the object were materialised", async () => {
    const baseline = liveHeapBytes();
    // Exactly what the job did before, with the step the old whole-string builder took
    // takes internally spelled out: the payload graph, the JSON string it is
    // stringified into, then a whole-buffer gzip-and-encrypt pass, then a
    // single put of the finished buffer.
    const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
      purpose: "disaster-recovery",
    });
    const json = JSON.stringify(payload);
    const object = encryptBackup(json, BACKUP_KEY);
    // All three are deliberately still reachable at the reading: holding the
    // graph, the document and the finished object at the same time is exactly
    // the shape that exhausted the container.
    const held = liveHeapBytes() - baseline;
    expect(payload.measurements).toHaveLength(MEASUREMENT_ROWS);
    expect(json.length).toBeGreaterThan(0);
    expect(object.byteLength).toBeGreaterThan(0);
    reportPeak("materialised", held);
    expect(
      held,
      "materialising this fixture no longer costs what the budget in this " +
        "file assumes; re-measure the budget rather than widening it",
    ).toBeGreaterThan(STREAM_BUDGET_BYTES * 2);
  }, 300_000);

  it("fails as a job rather than as a process when one object does not fit", async () => {
    // The only ceiling the write path still has is structural: a multipart
    // upload carries 10 000 parts and no more. An account past it is now a
    // failed backup for that account instead of a confusing SDK error halfway
    // through an object that is already mostly written.
    const s3 = makeCountingS3();
    await expect(
      uploadEncryptedBackup(
        s3,
        "k",
        BACKUP_KEY,
        (write) =>
          streamFullBackupJson(prisma, OWNER_ID, write, {
            purpose: "disaster-recovery",
          }),
        { maxBytes: 64 * 1024 },
      ),
    ).rejects.toBeInstanceOf(OffhostBackupTooLargeError);
  }, 120_000);
});
