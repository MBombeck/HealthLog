/**
 * The weekly backup, run against a record big enough to have killed the
 * process, with its live memory measured rather than assumed.
 *
 * What this pins. The `data-backup` job used to build the whole payload as an
 * object graph and then `JSON.stringify` it, so both the graph and the string
 * were resident at once and both scaled with the record. On a seeded account
 * of 445 000 measurements under `--max-old-space-size=450` that is
 * `FATAL ERROR: Reached heap limit` about thirty seconds in — and because the
 * job shares the app process, one account's size restarted the instance for
 * everybody on it.
 *
 * Why it measures the way it does. `process.memoryUsage().heapUsed` on its own
 * is not a measurement: V8 lets garbage float in proportion to the heap limit,
 * and a test fork's limit is several times a container's, so the same code
 * "peaks" at wildly different numbers depending on who is running it. Every
 * reading below is taken after a forced collection, so what is compared is
 * what each writer HOLDS.
 *
 * The two halves are the whole point. One says the streaming writer stays
 * inside a budget; the other says the materialising builder does not fit that
 * budget on the same fixture in the same process. Without the second, the
 * budget could be any number at all and the first would still pass — green
 * because nothing was measured rather than because something was proved.
 *
 * The fixture is seeded in one `INSERT … generate_series` rather than through
 * Prisma. 120 000 rows through the client would dominate the runtime and prove
 * nothing about the writer.
 */
import v8 from "node:v8";
import vm from "node:vm";

import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { BackupBlobTooLargeError } from "@/lib/export/backup-blob";
import { storeBackupBlob } from "@/lib/export/store-backup-blob";
import { readStoredBackup } from "./stored-backup-read";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";
import { buildFullBackupPayload } from "@/lib/export/full-backup-payload";
import { getPrismaClient, truncateAllTables } from "./setup";

const OWNER_ID = "backup-streaming-owner";
/** A second account with almost nothing in it — the demo-record case. */
const TINY_OWNER_ID = "backup-streaming-tiny";
const MEASUREMENT_ROWS = 120_000;
const MOOD_ROWS = 8_000;

/**
 * 80 % of the 524 MB V8 limit a 1 GB container gets.
 *
 * The number the weekly pass aborted every account against on the live
 * instance, including one whose entire stored backup is 1.2 MB.
 */
const CONTAINER_BUDGET_BYTES = Math.floor(524 * 1024 * 1024 * 0.8);

/**
 * How much garbage to leave lying about before a backup runs.
 *
 * A container's whole budget where the runner has room for it, and a majority
 * share of the heap where it does not — this file is also run under
 * `--max-old-space-size=450`, and a target above that heap's own limit would
 * measure an out-of-memory abort rather than a backup.
 */
function dirtyTargetBytes(): number {
  return Math.min(
    CONTAINER_BUDGET_BYTES + 8 * 1024 * 1024,
    Math.floor(v8.getHeapStatistics().heap_size_limit * 0.6),
  );
}

/**
 * What the streaming writer may hold on top of the process's own baseline.
 *
 * Measured, not chosen: on this fixture the streaming writer holds 16 MB — a
 * page of rows and the base64 answer so far — and materialising the same
 * fixture holds 168 MB, the object graph and the document at once. The budget
 * sits with a wide margin either side of it, which is what makes it a test
 * rather than a coin toss.
 */
const STREAM_BUDGET_BYTES = 48 * 1024 * 1024;

const prisma = getPrismaClient();

/**
 * A collection this process can ask for, without the runner having to be
 * started with `--expose-gc`. The flag is turned on, the binding is pulled out
 * of a throwaway context, and the flag is turned back off — so nothing about
 * how the rest of the suite runs changes.
 */
const forceGc = ((): (() => void) => {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  v8.setFlagsFromString("--no-expose-gc");
  return gc;
})();

/**
 * The one number this file exists to produce, on stderr where a gate run keeps
 * it. Peaks are the evidence, and evidence that only prints on failure is not
 * evidence.
 */
function reportPeak(label: string, heldBytes: number, liveBytes: number): void {
  const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024);
  process.stderr.write(
    `[backup-memory] ${label}: peak ${mb(heldBytes)} MB held by the backup, ` +
      `${mb(liveBytes)} MB live in the process, ` +
      `${mb(v8.getHeapStatistics().heap_size_limit)} MB heap limit\n`,
  );
}

/** Heap held after a forced collection. Garbage is not a measurement. */
function liveHeapBytes(): number {
  // Twice: the first pass frees the objects, the second collects what the
  // first pass's own bookkeeping released.
  forceGc();
  forceGc();
  return process.memoryUsage().heapUsed;
}

/** Leave the heap carrying `targetBytes` of garbage nothing holds any more. */
function dirtyHeap(targetBytes: number): number {
  let garbage: unknown[] = [];
  for (
    let round = 0;
    round < 2_000 && process.memoryUsage().heapUsed < targetBytes;
    round++
  ) {
    const chunk = new Array(30_000);
    for (let at = 0; at < 30_000; at++) chunk[at] = { k: round * at };
    garbage.push(chunk);
  }
  const reached = process.memoryUsage().heapUsed;
  // Dropped. Every byte counted above is collectable from here on, which is
  // exactly what a long-lived Next.js server's heap looks like.
  garbage = [];
  void garbage;
  return reached;
}

async function seedTinyRecord(): Promise<void> {
  await prisma.user.create({
    data: { id: TINY_OWNER_ID, username: "backup-streaming-tiny" },
  });
  await prisma.measurement.create({
    data: {
      userId: TINY_OWNER_ID,
      type: "WEIGHT",
      value: 80,
      unit: "kg",
      source: "MANUAL",
      measuredAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
}

async function seedLargeRecord(): Promise<void> {
  await prisma.user.create({
    data: { id: OWNER_ID, username: "backup-streaming-owner" },
  });
  // One statement, one round trip. Every row carries a note on one row in
  // forty and ciphertext on one in twenty-five so the base64 arm of the
  // serialiser is exercised at scale, and one in two hundred is a tombstone
  // because the delta sync reads exactly those and a backup that drops them
  // resurrects deleted readings on the next device sync.
  await prisma.$executeRawUnsafe(
    `INSERT INTO measurements (
       id, user_id, type, value, unit, source, measured_at, notes,
       notes_encrypted, external_id, created_at, updated_at, sync_version,
       deleted_at)
     SELECT
       'sm' || lpad(g::text, 10, '0'),
       $1,
       'PULSE'::measurement_type,
       60 + (g % 40),
       'bpm',
       'APPLE_HEALTH'::measurement_source,
       timestamp '2019-01-01 00:00:00' + (g * interval '30 seconds'),
       CASE WHEN g % 40 = 0 THEN 'a note recorded with reading ' || g END,
       CASE WHEN g % 25 = 0
            THEN decode(md5(g::text) || md5((g + 1)::text), 'hex') END,
       'stream-' || g,
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
       'sd' || lpad(g::text, 10, '0'),
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
}

describe("weekly backup under a memory budget", () => {
  beforeAll(async () => {
    expect(
      typeof forceGc,
      "without a real collection every reading in this file measures " +
        "uncollected garbage and nothing here can fail",
    ).toBe("function");
    await truncateAllTables(prisma);
    await seedLargeRecord();
    await seedTinyRecord();
  }, 240_000);

  afterAll(async () => {
    await truncateAllTables(prisma);
  });

  it("writes a restorable blob while holding a bounded amount of the record", async () => {
    // Dirtied first, and only then measured: the baseline is taken after a
    // forced collection, so what is compared below is what the writer HOLDS,
    // not what the process happens to have lying about.
    dirtyHeap(dirtyTargetBytes());
    const baseline = liveHeapBytes();
    let peakHeld = 0;
    let chunks = 0;

    const { id: blob } = await storeBackupBlob(
      prisma,
      { userId: OWNER_ID, type: "WEEKLY_AUTO" },
      async (write) => {
        const counts = await streamFullBackupJson(
          prisma,
          OWNER_ID,
          async (chunk) => {
            await write(chunk);
            // Sampled rather than continuous: a forced collection per chunk
            // would dominate the runtime, and one in forty still lands inside
            // every phase of the walk.
            if (chunks++ % 40 === 0) {
              peakHeld = Math.max(peakHeld, liveHeapBytes() - baseline);
            }
          },
          // The purpose the weekly job asks for: tombstones and ciphertext ride
          // verbatim, which is the arm that has to fit in memory.
          { purpose: "disaster-recovery" },
        );
        expect(counts.measurements).toBe(MEASUREMENT_ROWS);
        expect(counts.moodEntries).toBe(MOOD_ROWS);
      },
    );
    peakHeld = Math.max(peakHeld, liveHeapBytes() - baseline);
    reportPeak("large record", peakHeld, liveHeapBytes());

    expect(
      peakHeld,
      `the streaming writer held ${Math.round(peakHeld / 1024 / 1024)} MB of ` +
        "a record it is supposed to pass through a page at a time",
    ).toBeLessThan(STREAM_BUDGET_BYTES);

    // A blob that writes but does not read is worse than none.
    const restored = JSON.parse(await readStoredBackup(prisma, blob)) as {
      measurements: Array<{ deletedAt: string | null }>;
      moodEntries: unknown[];
    };
    expect(restored.measurements).toHaveLength(MEASUREMENT_ROWS);
    expect(restored.moodEntries).toHaveLength(MOOD_ROWS);
    // Tombstones ride along, or the next device sync resurrects them.
    expect(
      restored.measurements.filter((row) => row.deletedAt !== null).length,
    ).toBe(Math.floor(MEASUREMENT_ROWS / 200));
  }, 300_000);

  it("would not fit that budget if the record were materialised", async () => {
    const baseline = liveHeapBytes();
    const { payload } = await buildFullBackupPayload(prisma, OWNER_ID, {
      purpose: "disaster-recovery",
    });
    const json = JSON.stringify(payload);
    // Both are deliberately still reachable at the reading: holding the
    // graph and the document at the same time is exactly the shape that
    // exhausted the container.
    const held = liveHeapBytes() - baseline;
    expect(json.length).toBeGreaterThan(0);
    expect(payload.measurements).toHaveLength(MEASUREMENT_ROWS);
    expect(
      held,
      "materialising this fixture no longer costs what the budget in this " +
        "file assumes; re-measure the budget rather than widening it",
    ).toBeGreaterThan(STREAM_BUDGET_BYTES * 2);
  }, 300_000);

  it("backs up a one-row record on a heap already full of garbage", async () => {
    // The second way this pass has failed. The writer used to compare the
    // process's whole heap usage against a fraction of the heap limit, so on a
    // server that had been up a week it aborted the FIRST chunk of every
    // account — 422, 447, 448 and 441 MB read against a 419 MB budget, for
    // records from 445 000 measurements down to 1.2 MB. None of what it read
    // was the backup's.
    const target = dirtyTargetBytes();
    const dirty = dirtyHeap(target);
    const baseline = process.memoryUsage().heapUsed;
    let peak = baseline;

    let jsonBytes = 0;
    const { id: blob } = await storeBackupBlob(
      prisma,
      { userId: TINY_OWNER_ID, type: "WEEKLY_AUTO" },
      async (write) => {
        const counts = await streamFullBackupJson(
          prisma,
          TINY_OWNER_ID,
          async (chunk) => {
            jsonBytes += chunk.length;
            peak = Math.max(peak, process.memoryUsage().heapUsed);
            await write(chunk);
          },
          { purpose: "disaster-recovery" },
        );
        expect(counts.measurements).toBe(1);
      },
    );

    const restored = JSON.parse(await readStoredBackup(prisma, blob)) as {
      measurements: unknown[];
    };
    expect(restored.measurements).toHaveLength(1);
    // The record really is tiny and the heap really was carrying the pile it
    // aimed at — without both halves this passes vacuously.
    expect(jsonBytes).toBeLessThan(64 * 1024);
    expect(dirty).toBeGreaterThanOrEqual(target);
    expect(dirty).toBeGreaterThan(64 * 1024 * 1024);
    // The backup itself moved the heap by a rounding error next to the pile of
    // garbage it ran on top of.
    expect(peak - baseline).toBeLessThan(32 * 1024 * 1024);
    reportPeak("tiny record", peak - baseline, liveHeapBytes());
  }, 180_000);

  it("fails as a job rather than as a process when the stored copy passes its limit", async () => {
    // The one bound left is a storage limit on the stored copy, counted in
    // bytes it produced. An account past it is a failed backup for that
    // account, not a restart for every account on the host.
    await expect(
      storeBackupBlob(
        prisma,
        { userId: OWNER_ID, type: "WEEKLY_AUTO" },
        (write) =>
          streamFullBackupJson(prisma, OWNER_ID, write, {
            purpose: "disaster-recovery",
          }),
        { maxBytes: 64 * 1024 },
      ),
    ).rejects.toBeInstanceOf(BackupBlobTooLargeError);
  }, 120_000);
});
