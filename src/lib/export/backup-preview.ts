/**
 * What the restore preview shows for a stored backup, worked out while the
 * copy is written and kept on its row (`DataBackup.preview`).
 *
 * Why. The preview used to read the whole stored copy inside the request that
 * asked for it: open every piece, parse every measurement, validate the rest.
 * For an account of 1.8 million readings on slow hardware that took two
 * minutes, the dialog gave up long before, and the operator was told the
 * contents could not be read (#1031). The copy passes through this process
 * once anyway, on its way into the pieces, so the counts are taken there.
 *
 * What is kept. The `summarizeBackup` counts of the copy, its schema version,
 * and the inner key ids with the sections they sit in and the shortest
 * value of each section. The verdicts are not kept: whether this release can restore the
 * schema version, and whether this server holds the keys the copy needs, can
 * both change after the copy was written, so the route takes them again from
 * these inputs on every read.
 *
 * Which copy. A preview names the copy it describes (`copy`), and a reader
 * ignores one that names another: a copy replaced by a writer that does not
 * know about previews (an older release, after a downgrade) must not be
 * described by the numbers of the one it replaced.
 */
import { createHash } from "node:crypto";
import { z } from "zod/v4";

import {
  BackupKeyIdCollector,
  type StoredKeyUse,
} from "@/lib/export/backup-key-ids";
import { scanBackupJson } from "@/lib/export/backup-json-scan";
import type { StoredBackupRef } from "@/lib/export/stored-backup";
import {
  backupPayloadSchema,
  summarizeBackup,
  type BackupSummary,
} from "@/lib/validations/backup";

export interface BackupPreview {
  version: 1;
  /** The copy this describes (`storedCopyIdentity`). */
  copy: string;
  summary: BackupSummary;
  keys: StoredKeyUse[];
}

const storedPreviewSchema = z.object({
  version: z.literal(1),
  copy: z.string().min(1),
  summary: z
    .object({
      schemaVersion: z.string(),
      userId: z.string(),
      exportedAt: z.string(),
      measurements: z.number(),
    })
    .catchall(z.union([z.string(), z.number()])),
  keys: z.array(
    z.object({
      keyId: z.string(),
      count: z.number().int().nonnegative(),
      sections: z.array(z.string()),
      samples: z
        .array(
          z.object({
            value: z.string(),
            form: z.enum(["string", "bytes-string", "binary"]),
            section: z.string().optional(),
            member: z.string().optional(),
          }),
        )
        .optional(),
      // A preview stored by v1.40.0 or earlier kept one sample per key.
      sample: z
        .object({
          value: z.string(),
          form: z.enum(["string", "bytes-string", "binary"]),
        })
        .nullable()
        .optional(),
    }),
  ),
});

/**
 * How a single stored value is told apart from another: its length and its
 * first characters, which carry the key id and the random nonce of the
 * envelope. Hashed, so the preview does not repeat the envelope's head.
 */
export function singleValueIdentity(length: number, head: string): string {
  return `value:${createHash("sha256").update(`${length}:${head}`).digest("hex")}`;
}

/** How many leading characters of a single stored value the identity reads. */
export const SINGLE_VALUE_IDENTITY_HEAD = 128;

/**
 * The name of the copy a row holds now, or null for a row nothing may
 * describe: one holding both forms, or neither.
 */
export function storedCopyIdentity(
  backup: Pick<StoredBackupRef, "data" | "chunkCount" | "chunkStreamId">,
): string | null {
  if (backup.data != null && backup.chunkStreamId != null) return null;
  if (backup.chunkStreamId != null) {
    return `chunks:${backup.chunkStreamId}:${backup.chunkCount ?? ""}`;
  }
  if (backup.data != null) {
    return singleValueIdentity(
      backup.data.length,
      backup.data.slice(0, SINGLE_VALUE_IDENTITY_HEAD),
    );
  }
  return null;
}

export function buildBackupPreview(
  copy: string,
  summary: BackupSummary,
  keys: BackupKeyIdCollector,
): BackupPreview {
  return { version: 1, copy, summary, keys: keys.toStored() };
}

/**
 * The stored preview of a row, when it describes the copy the row holds now;
 * null when there is none, it is malformed, or it describes another copy.
 */
export function storedPreviewFor(
  stored: unknown,
  backup: Pick<StoredBackupRef, "data" | "chunkCount" | "chunkStreamId">,
): BackupPreview | null {
  const copy = storedCopyIdentity(backup);
  if (copy === null || stored == null) return null;
  const parsed = storedPreviewSchema.safeParse(stored);
  if (!parsed.success || parsed.data.copy !== copy) return null;
  return parsed.data as unknown as BackupPreview;
}

/**
 * The sections that grow with a record. Their elements are counted and their
 * key ids read as they pass, and never kept, so the scan holds no more of the
 * copy than the writer itself does (`full-backup-stream.ts`).
 */
const STREAMED = new Set(["measurements", "intakeEvents", "moodEntries"]);

export interface BackupPreviewScanner {
  /**
   * Hand over the next piece of the JSON. Resolves once the scan has taken
   * it, so a writer never runs more than a piece ahead of the scan.
   */
  feed(piece: string | Uint8Array): Promise<void>;
  /**
   * The counts and key uses, once every piece has been fed; null when the
   * JSON was not a backup the schema accepts. Never rejects: a copy is
   * stored whether or not its preview could be worked out.
   */
  finish(): Promise<{
    summary: BackupSummary;
    keys: BackupKeyIdCollector;
  } | null>;
}

/**
 * Work out a preview from a copy's JSON as it is written. The counts are the
 * ones the preview route derives from the stored copy (`summarizeBackup` over
 * the parsed file), the three bulk sections counted rather than parsed.
 */
export function createBackupPreviewScanner(): BackupPreviewScanner {
  const queue: Array<{ chunk: Uint8Array; taken: () => void }> = [];
  let ended = false;
  let stopped = false;
  let wake: (() => void) | null = null;
  const signal = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  async function* pieces(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const next = queue.shift();
      if (next) {
        next.taken();
        yield next.chunk;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  const keys = new BackupKeyIdCollector();
  const result = scanBackupJson(pieces(), {
    streamKeys: STREAMED,
    onElement: (key, element) => keys.visit(element, key),
  })
    .then(({ document, streamedCounts }) => {
      keys.visit(document);
      const parsed = backupPayloadSchema.safeParse(document);
      if (!parsed.success) return null;
      const summary: BackupSummary = {
        ...summarizeBackup(parsed.data),
        measurements: streamedCounts.measurements ?? 0,
        intakeEvents: streamedCounts.intakeEvents ?? 0,
        moodEntries: streamedCounts.moodEntries ?? 0,
      };
      return { summary, keys };
    })
    .catch(() => null)
    .finally(() => {
      // A scan that stopped early takes nothing more: release the writer.
      stopped = true;
      for (const waiting of queue.splice(0)) waiting.taken();
    });

  return {
    feed(piece) {
      if (stopped) return Promise.resolve();
      const chunk =
        typeof piece === "string" ? Buffer.from(piece, "utf8") : piece;
      return new Promise<void>((taken) => {
        queue.push({ chunk, taken });
        signal();
      });
    },
    finish() {
      ended = true;
      signal();
      return result;
    },
  };
}
