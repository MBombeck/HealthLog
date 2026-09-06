/**
 * The full-backup payload, written out incrementally instead of built.
 *
 * Why it exists. the old whole-string builder (removed with the streaming path) had to hold two things at once that
 * both scale with the record: the payload object graph, and the JSON string
 * `JSON.stringify` makes of it. On a seeded account of 445 000 measurements,
 * 30 000 mood entries and 60 000 intake events, that pair alone exhausts a
 * 546 MB heap and the process dies with `Reached heap limit` — measured, not
 * inferred, and reproducible with `--max-old-space-size=450`. The production
 * container is capped at 1 GB, which puts V8's limit at 524 MB, so the weekly
 * pass took the whole app down with it: every other user of that instance lost
 * their session because one account's backup did not fit.
 *
 * What changed. The three tables that scale with a long-lived record —
 * measurements, intake events, mood entries — are declared rather than read
 * (`deferBulk`), and this writer pulls them through page by page, serialising
 * one row at a time straight into the sink. Every other section is stringified
 * and then RELEASED from the payload before the next one is touched, so the
 * peak is the largest single section rather than the sum of all of them.
 *
 * The output is byte-identical to `JSON.stringify(payload)`. That is not a
 * hope: `Object.entries` walks a plain object in insertion order, which is the
 * order `JSON.stringify` uses, and `JSON.stringify([a, b])` is exactly
 * `"[" + JSON.stringify(a) + "," + JSON.stringify(b) + "]"` for plain rows.
 * The integration suite pins it against the materialising builder rather than
 * trusting that paragraph.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import {
  buildFullBackupPayload,
  isDeferredRows,
  type FullBackupCounts,
  type FullBackupOptions,
} from "@/lib/export/full-backup-payload";

/** Where the writer puts its pieces. Awaited, so a sink can apply backpressure. */
export type BackupJsonSink = (chunk: string) => void | Promise<void>;

/**
 * How much serialised JSON to gather before handing it to the sink.
 *
 * Row-at-a-time writes would push half a million tiny strings through gzip and
 * spend more time in framing than in compression; a batch this size keeps the
 * resident buffer trivial and the write count in the low thousands.
 */
const FLUSH_BYTES = 256 * 1024;

/**
 * There is deliberately no heap reading in this writer.
 *
 * There used to be: every flush compared the process's live heap usage against
 * 80 % of V8's heap limit and aborted the backup above it. That reading is not
 * the backup's footprint — it is the whole process's, garbage included, and a
 * long-lived Next.js server sits at 400 MB of largely COLLECTABLE heap. On a
 * 1 GB container (a 524 MB V8 limit, so a 419 MB budget) the check therefore
 * fired on the first flush of every account: a weekly pass over four accounts
 * aborted all four in seven seconds, and the smallest of them was a demo
 * record whose entire stored copy is 1.2 MB. It turned "this process has been
 * up a while" into "your record is too large", and then told the operator to
 * buy memory.
 *
 * What this writer holds is bounded by its own shape and needs no gauge to
 * prove: the three tables that scale with a record are pulled a page at a
 * time, every other section is released as soon as its JSON is in the sink,
 * and at most `FLUSH_BYTES` of text is ever pending. The one copy that DOES
 * grow with the record is the sink's — the stored blob — so that is where the
 * bound belongs, and `packBackupBlobStreaming` enforces it there against bytes
 * it counted itself rather than against a heap the rest of the process shares.
 */

/**
 * Write the full-backup JSON for `userId` into `sink`, and answer the counts.
 *
 * The counts for the three deferred tables are filled in as their rows go
 * past, so a caller gets the same numbers the materialising builder reports.
 */
export async function streamFullBackupJson(
  prisma: PrismaClient,
  userId: string,
  sink: BackupJsonSink,
  options: FullBackupOptions = {},
): Promise<FullBackupCounts> {
  const { payload, counts } = await buildFullBackupPayload(prisma, userId, {
    ...options,
    deferBulk: true,
  });

  let pending = "";
  let pendingBytes = 0;

  const flush = async (force: boolean): Promise<void> => {
    if (pending === "" || (!force && pendingBytes < FLUSH_BYTES)) return;
    const chunk = pending;
    pending = "";
    pendingBytes = 0;
    await sink(chunk);
  };

  const write = async (piece: string): Promise<void> => {
    pending += piece;
    pendingBytes += piece.length;
    await flush(false);
  };

  const bulkCounts: Record<string, number> = {};

  await write("{");
  let first = true;
  // The walk is destructive: each section is released from the payload as soon
  // as its JSON is in the sink, which is what keeps the peak at one section
  // rather than at all of them. Nothing else reads this object.
  for (const key of Object.keys(payload)) {
    const value = payload[key];
    // `JSON.stringify` omits an undefined-valued key; so does this.
    if (value === undefined) continue;
    if (!first) await write(",");
    first = false;
    await write(`${JSON.stringify(key)}:`);

    if (isDeferredRows(value)) {
      await write("[");
      let rows = 0;
      for await (const row of value.rows()) {
        await write(
          rows === 0 ? JSON.stringify(row) : `,${JSON.stringify(row)}`,
        );
        rows++;
      }
      await write("]");
      bulkCounts[key] = rows;
    } else {
      await write(JSON.stringify(value));
    }
    delete payload[key];
  }
  await write("}");
  await flush(true);

  return { ...counts, ...bulkCounts } as FullBackupCounts;
}
