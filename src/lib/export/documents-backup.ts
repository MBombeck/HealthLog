/**
 * The document vault, with both backup ends in one file.
 *
 * A disaster-recovery file carries each document's stored bytes verbatim; a
 * portable one carries metadata only and cannot be restored into documents.
 */
import { Buffer } from "node:buffer";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { decryptDocumentSummary } from "@/lib/documents/store";
import { getEvent } from "@/lib/logging/context";
import { dateOnlyKey } from "@/lib/tz/date-only";
import { streamedField, type StreamedField } from "@/lib/export/streamed-field";
import {
  decodeEncryptedBytes,
  type RestoreContext,
} from "@/lib/export/restore-context";
import { normaliseSourceInstance } from "@/lib/validations/inbound-documents";
import type { BackupPayload } from "@/lib/validations/backup";

// ── Export ───────────────────────────────────────────────────────────────────

export interface DocumentsBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

export interface DocumentBackupEntry {
  id: string;
  kind: string;
  title: string | null;
  filename: string | null;
  mimeType: string;
  byteSize: number;
  status: string;
  reportDate: string | null;
  documentDate: string | null;
  /** Portable export only; canonical DR carries summaryEncrypted instead. */
  summary?: string | null;
  createdAt: string;
  updatedAt?: string;
  /** Base64 of the already-encrypted BYTEA value; never plaintext. */
  contentEncrypted?: string;
  contentSha256?: string | null;
  contentCodec?: string;
  providerType?: string | null;
  errorReason?: string | null;
  /** Base64 of the already-encrypted summary BYTEA value. */
  summaryEncrypted?: string | null;
  summaryGeneratedAt?: string | null;
  summaryState?: string;
  /** Refs #776 — the index-attempt record, carried verbatim (canonical DR). */
  lastIndexAttemptAt?: string | null;
  lastIndexOutcome?: string | null;
  /**
   * Where an imported document came from, both payload
   * kinds. Optional so a file written before the fields existed still parses.
   */
  sourceSystem?: string | null;
  sourceId?: string | null;
  /** The source instance (origin); absent in older files. */
  sourceInstance?: string | null;
  /** Canonical DR only: the import's hold on automatic AI reading. */
  aiReadDeferred?: boolean;
  /** Canonical DR only: the staged facts may leave part of it out. */
  extractionIncomplete?: boolean;
}

/** The document columns both purposes carry. */
const DOCUMENT_PORTABLE_SELECT = {
  id: true,
  kind: true,
  title: true,
  filename: true,
  mimeType: true,
  byteSize: true,
  status: true,
  reportDate: true,
  documentDate: true,
  summaryEncrypted: true,
  sourceSystem: true,
  sourceId: true,
  sourceInstance: true,
  createdAt: true,
} as const satisfies Prisma.InboundDocumentSelect;

/**
 * A disaster-recovery document without its stored bytes. The paged reader
 * reads this for every document at once and the bytes one slice at a time.
 */
const DOCUMENT_DR_METADATA_SELECT = {
  ...DOCUMENT_PORTABLE_SELECT,
  contentSha256: true,
  contentCodec: true,
  providerType: true,
  errorReason: true,
  summaryGeneratedAt: true,
  summaryState: true,
  lastIndexAttemptAt: true,
  lastIndexOutcome: true,
  aiReadDeferred: true,
  extractionIncomplete: true,
  updatedAt: true,
} as const satisfies Prisma.InboundDocumentSelect;

const DOCUMENT_DR_SELECT = {
  ...DOCUMENT_DR_METADATA_SELECT,
  contentEncrypted: true,
} as const satisfies Prisma.InboundDocumentSelect;

/** Total, so two exports of the same account list the documents alike. */
const DOCUMENT_ORDER = [
  { createdAt: "desc" },
  { id: "desc" },
] as const satisfies Prisma.InboundDocumentOrderByWithRelationInput[];

type PortableDocumentRow = Prisma.InboundDocumentGetPayload<{
  select: typeof DOCUMENT_PORTABLE_SELECT;
}>;
type DisasterRecoveryDocumentRow = Prisma.InboundDocumentGetPayload<{
  select: typeof DOCUMENT_DR_METADATA_SELECT;
}>;
type DocumentRow =
  | PortableDocumentRow
  | Prisma.InboundDocumentGetPayload<{ select: typeof DOCUMENT_DR_SELECT }>;

/**
 * One document as it rides the wire. `contentEncrypted` is the base64 of the
 * stored bytes for a disaster-recovery entry and null for a portable one,
 * which carries the readable summary instead. Shared by the materialising
 * reader and the paged one, so the two cannot drift.
 */
function serialiseDocument(
  d: PortableDocumentRow | DisasterRecoveryDocumentRow,
  contentEncrypted: string | null,
): DocumentBackupEntry {
  const metadata = {
    id: d.id,
    kind: d.kind,
    title: d.title,
    filename: d.filename,
    mimeType: d.mimeType,
    byteSize: d.byteSize,
    status: d.status,
    reportDate: d.reportDate ? dateOnlyKey(d.reportDate) : null,
    documentDate: d.documentDate ? dateOnlyKey(d.documentDate) : null,
    sourceSystem: d.sourceSystem,
    sourceId: d.sourceId,
    sourceInstance: d.sourceInstance,
    createdAt: d.createdAt.toISOString(),
  };

  if (contentEncrypted !== null && "contentCodec" in d) {
    const dr: DisasterRecoveryDocumentRow = d;
    return {
      ...metadata,
      reportDate: dr.reportDate?.toISOString() ?? null,
      documentDate: dr.documentDate?.toISOString() ?? null,
      updatedAt: dr.updatedAt.toISOString(),
      contentEncrypted,
      contentSha256: dr.contentSha256,
      contentCodec: dr.contentCodec,
      providerType: dr.providerType,
      errorReason: dr.errorReason,
      summaryEncrypted: dr.summaryEncrypted
        ? Buffer.from(dr.summaryEncrypted).toString("base64")
        : null,
      summaryGeneratedAt: dr.summaryGeneratedAt?.toISOString() ?? null,
      summaryState: dr.summaryState,
      lastIndexAttemptAt: dr.lastIndexAttemptAt?.toISOString() ?? null,
      lastIndexOutcome: dr.lastIndexOutcome,
      aiReadDeferred: dr.aiReadDeferred,
      extractionIncomplete: dr.extractionIncomplete,
    };
  }

  return {
    ...metadata,
    summary: decryptSummarySoft(d.summaryEncrypted),
  };
}

/**
 * How much of a document's stored bytes one read takes. A multiple of three,
 * so the base64 of every slice joins into the base64 of the whole.
 */
const DOCUMENT_SLICE_BYTES = 1536 * 1024;

/**
 * How much of a document's base64 the streaming writer shows its observer
 * (the restore preview). The key id sits in the first characters; the cap is
 * above the longest value the preview keeps as a key sample, so a shortened
 * value is never kept as one. A multiple of four, so it still reads as base64.
 */
const DOCUMENT_OBSERVED_CHARS = 128 * 1024;

/**
 * Every document of the account, one at a time, for the streaming backup
 * writer (#1239).
 *
 * A document is up to a hundred megabytes, and the materialising read holds
 * every document's bytes, their base64 and the section's JSON at once: about
 * five times the size of the vault in heap, which a 524 MB process does not
 * have for a vault of 100 MB. Here the metadata of all documents is read
 * once, and each document's bytes are read a slice at a time and handed on as
 * base64 pieces (`streamedField`), so what is held is one slice.
 *
 * A document that disappears between the metadata read and its first slice
 * is left out, as a later read would not have seen it. One that disappears
 * halfway fails the copy: half a document is not a document.
 */
export async function* iterateBackupDocuments(
  prisma: Pick<PrismaClient, "inboundDocument" | "$queryRaw">,
  userId: string,
  options: DocumentsBackupOptions = {},
): AsyncGenerator<DocumentBackupEntry | StreamedField, void, void> {
  if (options.purpose !== "disaster-recovery") {
    const rows = await prisma.inboundDocument.findMany({
      where: { userId, deletedAt: null },
      orderBy: DOCUMENT_ORDER,
      select: DOCUMENT_PORTABLE_SELECT,
    });
    for (const row of rows) yield serialiseDocument(row, null);
    return;
  }
  const rows = await prisma.inboundDocument.findMany({
    where: { userId, deletedAt: null },
    orderBy: DOCUMENT_ORDER,
    select: DOCUMENT_DR_METADATA_SELECT,
  });
  const slice = async (id: string, from: number): Promise<Buffer | null> => {
    const [row] = await prisma.$queryRaw<Array<{ part: Uint8Array | null }>>`
      SELECT substring(content_encrypted FROM ${from + 1}::int
                       FOR ${DOCUMENT_SLICE_BYTES}::int) AS part
      FROM inbound_documents
      WHERE id = ${id} AND user_id = ${userId}
    `;
    if (!row) return null;
    const part = row.part ?? new Uint8Array(0);
    // A view, not a copy: the slice is read once and dropped.
    return Buffer.from(part.buffer, part.byteOffset, part.byteLength);
  };
  for (const row of rows) {
    const first = await slice(row.id, 0);
    if (first === null) continue;
    const head = first.toString("base64");
    const pieces = async function* (): AsyncGenerator<string, void, void> {
      yield head;
      let last = first.byteLength;
      for (let at = last; last === DOCUMENT_SLICE_BYTES; at += last) {
        const next = await slice(row.id, at);
        if (next === null) {
          throw new Error(
            `Document ${row.id} was removed while it was being backed up; ` +
              "the next run copies the account again.",
          );
        }
        last = next.byteLength;
        if (last > 0) yield next.toString("base64");
      }
    };
    yield streamedField(
      serialiseDocument(row, ""),
      "contentEncrypted",
      head.length > DOCUMENT_OBSERVED_CHARS
        ? head.slice(0, DOCUMENT_OBSERVED_CHARS)
        : head,
      pieces,
    );
  }
}

/** Decrypt a document's optional AI summary fail-soft (null on any error). */
function decryptSummarySoft(buf: Uint8Array | null): string | null {
  if (!buf || buf.byteLength === 0) return null;
  try {
    return decryptDocumentSummary(buf);
  } catch (err) {
    getEvent()?.addWarning(
      `document summary decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * The document slice of the records section. A portable entry carries the
 * metadata and the readable summary; a disaster-recovery one the stored
 * bytes verbatim, unless the caller reads them itself (`deferDocuments`).
 */
export async function buildDocumentsBackupSlice(
  prisma: Pick<PrismaClient, "inboundDocument">,
  userId: string,
  disasterRecovery: boolean,
  deferDocuments: boolean,
): Promise<{ documents: DocumentBackupEntry[] }> {
  const documentRows: DocumentRow[] = deferDocuments
    ? []
    : disasterRecovery
      ? await prisma.inboundDocument.findMany({
          where: { userId, deletedAt: null },
          orderBy: DOCUMENT_ORDER,
          select: DOCUMENT_DR_SELECT,
        })
      : await prisma.inboundDocument.findMany({
          where: { userId, deletedAt: null },
          orderBy: DOCUMENT_ORDER,
          select: DOCUMENT_PORTABLE_SELECT,
        });

  const documents: DocumentBackupEntry[] = documentRows.map((d) =>
    serialiseDocument(
      d,
      disasterRecovery && "contentEncrypted" in d
        ? Buffer.from(d.contentEncrypted).toString("base64")
        : null,
    ),
  );

  return { documents };
}

// ── Restore ──────────────────────────────────────────────────────────────────

/**
 * The first document the file carries as metadata only, if any.
 *
 * Portable exports intentionally omit document ciphertext. They remain valid
 * upload/download artifacts, but cannot be used to manufacture an
 * InboundDocument row. A DR restore must fail before any delete rather than
 * inventing empty/plaintext content.
 */
export function findIncompleteDocument(
  payload: Pick<BackupPayload, "documents">,
): BackupPayload["documents"][number] | undefined {
  return payload.documents.find(
    (document) =>
      document.contentEncrypted === undefined ||
      document.contentSha256 === undefined ||
      document.contentCodec === undefined ||
      document.providerType === undefined ||
      document.reportDate === undefined ||
      document.documentDate === undefined ||
      document.errorReason === undefined ||
      document.summaryEncrypted === undefined ||
      document.summaryGeneratedAt === undefined ||
      document.summaryState === undefined ||
      document.createdAt === undefined ||
      document.updatedAt === undefined,
  );
}

export async function clearDocuments(ctx: RestoreContext): Promise<void> {
  const documents = await ctx.tx.inboundDocument.deleteMany({
    where: { userId: ctx.ownerId },
  });
  ctx.cleared.documents = documents.count;
}

/**
 * One document at a time, its stored bytes read from the file again
 * (`forEachDocumentContent`): the first read left them out, because a vault
 * held whole does not fit a 524 MB heap (#1239). The rows are in file order
 * on both reads.
 */
export async function restoreDocuments(ctx: RestoreContext): Promise<void> {
  const { tx, ownerId, payload, streamed } = ctx;
  if (payload.documents.length === 0) return;
  let written = 0;
  await streamed.forEachDocumentContent(async (content, index) => {
    const document = payload.documents[index];
    if (!document || content === undefined) {
      throw new Error(
        `Document ${index} of the backup has no stored bytes on the second read`,
      );
    }
    await tx.inboundDocument.create({
      data: {
        id: document.id,
        userId: ownerId,
        kind: document.kind as never,
        title: document.title ?? null,
        filename: document.filename ?? null,
        mimeType: document.mimeType,
        byteSize: document.byteSize,
        contentEncrypted: decodeEncryptedBytes(content),
        contentSha256: document.contentSha256 ?? null,
        contentCodec: document.contentCodec!,
        status: document.status as never,
        providerType: document.providerType ?? null,
        reportDate: document.reportDate ? new Date(document.reportDate) : null,
        documentDate: document.documentDate
          ? new Date(document.documentDate)
          : null,
        errorReason: document.errorReason ?? null,
        summaryEncrypted: document.summaryEncrypted
          ? decodeEncryptedBytes(document.summaryEncrypted)
          : null,
        summaryGeneratedAt: document.summaryGeneratedAt
          ? new Date(document.summaryGeneratedAt)
          : null,
        summaryState: document.summaryState as never,
        lastIndexAttemptAt: document.lastIndexAttemptAt
          ? new Date(document.lastIndexAttemptAt)
          : null,
        lastIndexOutcome: document.lastIndexOutcome ?? null,
        // An older file has no marker: those documents predate the hold and
        // restore as ordinary ones.
        aiReadDeferred: document.aiReadDeferred ?? false,
        // An older file has no marker: its staged facts read as complete,
        // as they were shown when it was written.
        extractionIncomplete: document.extractionIncomplete ?? false,
        sourceSystem: document.sourceSystem ?? null,
        sourceId: document.sourceSystem ? (document.sourceId ?? null) : null,
        // A file written before v1.39.3 has no instance: the key then
        // matches any instance of its system, as it did when stored.
        sourceInstance:
          document.sourceSystem && document.sourceId
            ? document.sourceInstance
              ? normaliseSourceInstance(document.sourceInstance)
              : null
            : null,
        createdAt: new Date(document.createdAt!),
        updatedAt: new Date(document.updatedAt!),
      },
      select: { id: true },
    });
    written += 1;
  });
  if (written !== payload.documents.length) {
    throw new Error(
      `The backup's second read found ${written} of ${payload.documents.length} documents`,
    );
  }
}
