/**
 * v1.23 — read-only scan + in-place re-encrypt over the whole encrypted-column
 * corpus, driven by the canonical registry (`encrypted-columns.ts`).
 *
 * Two consumers:
 *   - the admin encryption-status view (`GET /api/admin/encryption/status`)
 *     calls `scanCorpus()` to bucket every encrypted column's rows by key id;
 *   - the admin-triggered rotation pg-boss job (`encryption-key-rotate`) calls
 *     `rotateCorpus()` to re-encrypt every row that is not already on the
 *     active key.
 *
 * The standalone CLI (`scripts/rotate-encryption-key.ts`) remains the canonical
 * rotation path and stays independent (its own Prisma client). This module is
 * the in-app convenience that reuses the SAME registry, so the guard test keeps
 * both in lock-step.
 *
 * GUARANTEES (the security review must confirm these on the rotation path):
 *  - ACTIVE-KEY-ONLY. Re-encryption is `encrypt(decrypt(value))`; `encrypt()`
 *    always writes the configured active key id. There is no code path here
 *    that selects any other write key.
 *  - NEVER ADDS / DROPS A KEY. This module never reads or mutates
 *    `ENCRYPTION_KEYS` / `ENCRYPTION_ACTIVE_KEY_ID`. The operator's env key map
 *    is the only place keys live; a key drop stays a deliberate env + redeploy
 *    act, never a button.
 *  - IDEMPOTENT. The walk skips rows already on the active key, so a
 *    second pass (or two racing workers) re-encrypts zero rows.
 *  - FAIL-CLOSED. A row written under a key id that is no longer configured
 *    throws on decrypt (counted as an error, the row is left untouched) rather
 *    than being silently dropped or overwritten — exactly the property that
 *    protects against dropping a legacy key too early.
 */
import { Buffer } from "node:buffer";
import {
  decrypt,
  encrypt,
  extractKeyId,
  extractKeyIdFromBytes,
  extractStreamKeyId,
  getActiveKeyId,
  isStreamCiphertext,
  reencryptBytesToActive,
} from "@/lib/crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  convertSingleValueBackup,
  singleValueBackupHead,
} from "@/lib/export/store-backup-blob";
import {
  ENCRYPTED_COLUMNS,
  type EncryptedColumn,
} from "@/lib/crypto/encrypted-columns";

/** Sentinel bucket for legacy (unversioned) ciphertext under `byKeyId`. */
export const LEGACY_BUCKET = "legacy";

/**
 * Batch size for blob columns (`codecField` or `batched` set). The document
 * vault's rows are up to cap-sized ciphertexts and a backup row is the whole
 * account compressed, so the walk is id-cursor paginated — at most this many
 * blobs are in memory at once.
 */
export const BLOB_ROTATION_BATCH_SIZE = 25;

/**
 * Batch size for every other column. These rows are short strings, but a
 * column can have one per measurement: `Measurement.notesEncrypted` is read
 * for every row of the table, 1.25 million on a large account (#1031). The
 * walk used to read such a column in one `findMany`; it is id-cursor paged
 * like the blob columns, only with larger pages.
 */
export const ROW_ROTATION_BATCH_SIZE = 5_000;

/** Minimal Prisma delegate shape this module needs. */
interface ColumnDelegate {
  findMany: (args: {
    select: Record<string, true>;
    orderBy?: Record<string, "asc" | "desc">;
    take?: number;
    where?: Record<string, unknown>;
  }) => Promise<Array<Record<string, unknown>>>;
  update: (args: {
    where: Record<string, string>;
    data: Record<string, unknown>;
  }) => Promise<unknown>;
  /** Only ever called for a `disposable` column's unreadable rows. */
  delete: (args: { where: Record<string, string> }) => Promise<unknown>;
}

/** The subset of the Prisma client we touch: one delegate per model. */
export type CorpusClient = Record<string, ColumnDelegate>;

/** PascalCase model name -> camelCase Prisma delegate key. */
function delegateKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

function getDelegate(client: CorpusClient, model: string): ColumnDelegate {
  const delegate = client[delegateKey(model)];
  if (!delegate) {
    throw new Error(`No Prisma delegate for model '${model}'`);
  }
  return delegate;
}

/** Read a registry column's value as a ciphertext string (Bytes -> utf8). */
function toCiphertext(
  value: unknown,
  kind: EncryptedColumn["kind"],
): string | null {
  if (value == null) return null;
  if (kind === "bytes") {
    const buf = value as Uint8Array;
    if (buf.byteLength === 0) return null;
    return Buffer.from(buf).toString("utf8");
  }
  const s = value as string;
  return s.length === 0 ? null : s;
}

/** Encode a re-encrypted ciphertext string back into the column's storage shape. */
function fromCiphertext(
  value: string,
  kind: EncryptedColumn["kind"],
): string | Uint8Array {
  if (kind !== "bytes") return value;
  const encoded = Buffer.from(value, "utf8");
  const next = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  next.set(encoded);
  return next;
}

// ─── Codec-dispatched blob columns (document vault) ─────────────────────────

/**
 * The key id a codec-dispatched blob row was written under, or null when
 * legacy/unparsable. "binary2" parses the binary header; every other codec
 * value (notably "base64v1") is the `encrypt()`-string-as-UTF-8 shape.
 */
function blobKeyId(value: Uint8Array, codec: string): string | null {
  const buf = Buffer.from(value);
  if (codec === "binary2") return extractKeyIdFromBytes(buf);
  return extractKeyId(buf.toString("utf8"));
}

/** Re-encrypt one codec-dispatched blob under its OWN codec (never converts). */
function reencryptBlob(
  value: Uint8Array,
  codec: string,
  aad: string | undefined,
): Uint8Array {
  const buf = Buffer.from(value);
  if (codec === "binary2") {
    const rotated = reencryptBytesToActive(buf, aad);
    const next = new Uint8Array(new ArrayBuffer(rotated.byteLength));
    next.set(rotated);
    return next;
  }
  if (codec === "base64v1") {
    const rotated = encrypt(decrypt(buf.toString("utf8")));
    const encoded = Buffer.from(rotated, "utf8");
    const next = new Uint8Array(new ArrayBuffer(encoded.byteLength));
    next.set(encoded);
    return next;
  }
  // FAIL-CLOSED: an unknown codec is counted as an error and left untouched.
  throw new Error(`Unknown content codec '${codec}'`);
}

/**
 * Walk a column in bounded id-cursor batches, invoking `onRow` per non-empty
 * row. At most one batch is in memory per step (`BLOB_ROTATION_BATCH_SIZE`
 * rows of a blob column, `ROW_ROTATION_BATCH_SIZE` of any other); an
 * interrupted run resumes safely on re-invocation because processing is
 * idempotent (already-active rows are skipped by the callers).
 *
 * `codec` is the row's own codec label for a codec-dispatched column and null
 * for a plain `batched` one — a backup blob has one layout, just a large one.
 */
async function walkColumn(
  delegate: ColumnDelegate,
  col: EncryptedColumn,
  onRow: (row: {
    id: string;
    value: unknown;
    codec: string | null;
  }) => Promise<void> | void,
): Promise<void> {
  const codecField = col.codecField;
  const pk = pkField(col);
  const batchSize = isBlobColumn(col)
    ? BLOB_ROTATION_BATCH_SIZE
    : ROW_ROTATION_BATCH_SIZE;
  let cursor: string | null = null;
  for (;;) {
    const rows = await delegate.findMany({
      select: {
        [pk]: true,
        [col.field]: true,
        ...(codecField ? { [codecField]: true } : {}),
      },
      orderBy: { [pk]: "asc" },
      take: batchSize,
      // `id > last`, not Prisma's `cursor` + `skip`: the cursor form looks
      // the last row up again, and a row deleted between pages ends the walk.
      ...(cursor ? { where: { [pk]: { gt: cursor } } } : {}),
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const value = row[col.field];
      if (value == null) continue;
      if (value instanceof Uint8Array && value.byteLength === 0) continue;
      if (typeof value === "string" && value.length === 0) continue;
      await onRow({
        id: row[pk] as string,
        value,
        codec: codecField ? String(row[codecField] ?? "") : (col.codec ?? null),
      });
    }
    cursor = rows[rows.length - 1]![pk] as string;
    if (rows.length < batchSize) break;
  }
}

/** The model's primary-key field: `id` unless the registry says otherwise. */
function pkField(col: EncryptedColumn): string {
  return col.pkField ?? "id";
}

/** True when the column's rows are blobs, walked in the small batches. */
function isBlobColumn(col: EncryptedColumn): boolean {
  return Boolean(col.codecField ?? col.codec ?? col.batched);
}

/** The key id a walked row was written under, dispatching on its codec. */
function walkedKeyId(
  value: unknown,
  codec: string | null,
  kind: EncryptedColumn["kind"],
): string | null {
  if (codec !== null) return blobKeyId(value as Uint8Array, codec);
  const ciphertext = toCiphertext(value, kind);
  if (ciphertext == null) return null;
  // The single-stream backup form v1.38.6 to v1.39.1 wrote carries its key id behind a
  // `~hlgcm1.` marker, where the string codec's parser does not look.
  if (isStreamCiphertext(ciphertext)) return extractStreamKeyId(ciphertext);
  return extractKeyId(ciphertext);
}

/**
 * The ids of the rows of a `convertsToPieces` column that still hold a single
 * value, a page of ids at a time. Only the id is read: the value can be a
 * hundred megabytes.
 */
async function* singleValueIds(
  delegate: ColumnDelegate,
): AsyncGenerator<string> {
  let cursor: string | null = null;
  for (;;) {
    const rows = await delegate.findMany({
      select: { id: true },
      orderBy: { id: "asc" },
      take: ROW_ROTATION_BATCH_SIZE,
      where: {
        data: { not: null },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
    });
    for (const row of rows) yield row.id as string;
    if (rows.length < ROW_ROTATION_BATCH_SIZE) return;
    cursor = rows[rows.length - 1]!.id as string;
  }
}

/** True for a Prisma "record to update not found" (P2025). */
function isRowGone(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2025"
  );
}

export interface ColumnScan {
  model: string;
  field: string;
  kind: EncryptedColumn["kind"];
  /** Non-null ciphertext rows. */
  total: number;
  /** Rows per key id; legacy/unversioned rows land under `LEGACY_BUCKET`. */
  byKeyId: Record<string, number>;
  /** Rows under the legacy/unversioned format (= `byKeyId[LEGACY_BUCKET]`). */
  legacy: number;
}

/** Scan one encrypted column: bucket every non-null ciphertext by key id. */
export async function scanColumn(
  client: CorpusClient,
  col: EncryptedColumn,
): Promise<ColumnScan> {
  const delegate = getDelegate(client, col.model);
  const byKeyId: Record<string, number> = {};
  let total = 0;

  if (col.convertsToPieces) {
    // One value can be a hundred megabytes: read only the first characters,
    // which carry the key id.
    for await (const id of singleValueIds(delegate)) {
      const head = await singleValueBackupHead(
        client as unknown as PrismaClient,
        id,
      );
      if (head === null) continue;
      total += 1;
      const key = walkedKeyId(head, null, col.kind) ?? LEGACY_BUCKET;
      byKeyId[key] = (byKeyId[key] ?? 0) + 1;
    }
    return {
      model: col.model,
      field: col.field,
      kind: col.kind,
      total,
      byKeyId,
      legacy: byKeyId[LEGACY_BUCKET] ?? 0,
    };
  }

  // Bounded batches for every column, per-row codec where the column has one.
  await walkColumn(delegate, col, ({ value, codec }) => {
    total += 1;
    const id = walkedKeyId(value, codec, col.kind) ?? LEGACY_BUCKET;
    byKeyId[id] = (byKeyId[id] ?? 0) + 1;
  });
  return {
    model: col.model,
    field: col.field,
    kind: col.kind,
    total,
    byKeyId,
    legacy: byKeyId[LEGACY_BUCKET] ?? 0,
  };
}

export interface CorpusScan {
  activeKeyId: string;
  columns: ColumnScan[];
  /** Total non-null ciphertext rows across the corpus. */
  totalRows: number;
  /** Rows already on the active key. */
  activeRows: number;
  /** Rows NOT on the active key (legacy + any non-active versioned). */
  staleRows: number;
  /**
   * True iff every column has zero rows that are not on the active key — the
   * single signal an operator needs before dropping a legacy key.
   */
  rotationComplete: boolean;
}

/** Scan the whole corpus. Read-only; never writes. */
export async function scanCorpus(client: CorpusClient): Promise<CorpusScan> {
  const activeKeyId = getActiveKeyId();
  const columns: ColumnScan[] = [];
  for (const col of ENCRYPTED_COLUMNS) {
    columns.push(await scanColumn(client, col));
  }
  let totalRows = 0;
  let activeRows = 0;
  for (const c of columns) {
    totalRows += c.total;
    activeRows += c.byKeyId[activeKeyId] ?? 0;
  }
  const staleRows = totalRows - activeRows;
  return {
    activeKeyId,
    columns,
    totalRows,
    activeRows,
    staleRows,
    rotationComplete: staleRows === 0,
  };
}

export interface RotationResult {
  model: string;
  field: string;
  scanned: number;
  rotated: number;
  errors: number;
  /** Unreadable rows deleted from a `disposable` column. */
  dropped: number;
}

/** Re-encrypt one column's stale rows to the active key. */
export async function rotateColumn(
  client: CorpusClient,
  col: EncryptedColumn,
): Promise<RotationResult> {
  const delegate = getDelegate(client, col.model);
  const result: RotationResult = {
    model: col.model,
    field: col.field,
    scanned: 0,
    rotated: 0,
    errors: 0,
    dropped: 0,
  };

  /**
   * A row that could not be re-encrypted. FAIL-CLOSED by default: count it and
   * leave it untouched rather than dropping data. A `disposable` column takes
   * the other branch — the value is a reproducible cache entry, and keeping an
   * unreadable one only guarantees the next reader gets a body it cannot
   * parse, so the row goes instead.
   */
  const onUnreadable = async (id: string): Promise<void> => {
    if (!col.disposable) {
      result.errors += 1;
      return;
    }
    try {
      await delegate.delete({ where: { [pkField(col)]: id } });
      result.dropped += 1;
    } catch {
      result.errors += 1;
    }
  };

  if (col.convertsToPieces) {
    // Converted into pieces under the active key, one row at a time and a
    // slice of the value at a time, whatever key it is under now: re-sealing
    // it in place would hold the whole value several times over
    // (`convertSingleValueBackup`). A row converted, replaced or deleted since
    // it was listed is gone, not an error.
    for await (const id of singleValueIds(delegate)) {
      result.scanned += 1;
      try {
        const outcome = await convertSingleValueBackup(
          client as unknown as PrismaClient,
          id,
        );
        if (outcome === "converted") result.rotated += 1;
        else result.scanned -= 1;
      } catch {
        result.errors += 1;
      }
    }
    return result;
  }

  // Bounded id-cursor batches for every column (never an unbounded
  // findMany), re-encrypted under each row's OWN codec where it has one.
  // Idempotent — rows already on the active key are skipped, so an
  // interrupted run resumes cleanly on the next invocation. `scanned` counts
  // the rows that hold ciphertext, whatever the column.
  await walkColumn(delegate, col, async ({ id, value, codec }) => {
    result.scanned += 1;
    if (walkedKeyId(value, codec, col.kind) === getActiveKeyId()) return;
    try {
      // The plaintext is never inspected, only re-sealed, so every envelope
      // a stored value can legitimately carry survives rotation untouched.
      const next =
        codec !== null
          ? reencryptBlob(value as Uint8Array, codec, col.aad)
          : fromCiphertext(
              encrypt(decrypt(toCiphertext(value, col.kind)!)),
              col.kind,
            );
      await delegate.update({
        where: { [pkField(col)]: id },
        data: { [col.field]: next },
      });
      result.rotated += 1;
    } catch (err) {
      // Deleted between the read and the write (a backup replacing its
      // pieces, an account going): nothing is left to rotate.
      if (isRowGone(err)) return;
      await onUnreadable(id);
    }
  });
  return result;
}

export interface CorpusRotation {
  activeKeyId: string;
  results: RotationResult[];
  totalScanned: number;
  totalRotated: number;
  totalErrors: number;
  /** Unreadable rows deleted from `disposable` columns. */
  totalDropped: number;
}

/** Re-encrypt the whole corpus to the active key. Idempotent + active-key-only. */
export async function rotateCorpus(
  client: CorpusClient,
): Promise<CorpusRotation> {
  const activeKeyId = getActiveKeyId();
  const results: RotationResult[] = [];
  for (const col of ENCRYPTED_COLUMNS) {
    results.push(await rotateColumn(client, col));
  }
  let totalScanned = 0;
  let totalRotated = 0;
  let totalErrors = 0;
  let totalDropped = 0;
  for (const r of results) {
    totalScanned += r.scanned;
    totalRotated += r.rotated;
    totalErrors += r.errors;
    totalDropped += r.dropped;
  }
  return {
    activeKeyId,
    results,
    totalScanned,
    totalRotated,
    totalErrors,
    totalDropped,
  };
}
