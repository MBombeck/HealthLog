/**
 * What a stored document was filed against, and what was read out of it, with
 * both backup ends in one file.
 *
 * Same arrangement as `coach-backup.ts`, `reminders-backup.ts` and
 * `vaccinations-backup.ts`, for the same reason: a reader asking "is this
 * carried at both ends?" answers it here, and a reader who greps only the
 * restore ROUTE gets a false negative because the route delegates.
 *
 * Two models ride, and they are the two halves of the same sentence about a
 * document. `DocumentConditionLink` says which conditions a page belongs to.
 * `ExtractedFact` says what the extraction pass transcribed out of it, with the
 * span it came from. Both sat on the coverage-pending register, where the
 * entries read "a restored vault is unsorted" and "re-derivable only by
 * re-running the extraction against a provider, at the operator's cost".
 *
 * A third rides beside them: the import ledger (`DocumentImportKey`), the
 * source keys of imported documents the person deleted, with the keys of the
 * documents still waiting in Recently deleted folded in (those documents do
 * not travel). Without it a restore onto a fresh instance let a token importer
 * store every deliberately deleted document again.
 *
 * ## The state on a fact is worth more than the fact
 *
 * `status`, `needsReview` and the pair `committedRecordId` /
 * `committedRecordType` are the record of a DECISION a person already made:
 * this fact was reviewed, approved, and committed to that lab result. Every one
 * of them has a schema default that reads as "nobody has looked at this yet"
 * (`PENDING`, `needsReview: true`, both commitment columns NULL), so a restore
 * that let them default hands back the same rows with their history erased.
 *
 * That is not only lost history. `POST /api/documents/inbound/[id]/confirm`
 * accepts a decision only on a `PENDING` fact and commits it through the normal
 * field-by-field create — so a fact that comes back PENDING is offered for
 * review a second time, and approving it writes a SECOND lab result, condition
 * or medication for a reading the account already has. The count of facts would
 * be right, the vault would look right, and the structured store would start
 * doubling. So the four columns are carried and restored verbatim, and asserted
 * by name in the round trip.
 *
 * ## Two references that behave very differently
 *
 * `documentId` is a real foreign key on both models, and `episodeId` is one on
 * the link. A value that cannot resolve does not quietly stop meaning
 * something: it aborts the transaction and costs the operator the WHOLE
 * restore. So the builder carries a row only when both of its ends are
 * carried — a document tombstoned out of the file takes its filings and its
 * facts with it — and the restore still checks against what it actually wrote
 * and drops what it cannot place, because a hand-edited or truncated file is
 * the case the write-time filter cannot cover.
 *
 * `committedRecordId` is the opposite: a bare id column with no relation
 * declared, pointing into one of three different tables depending on
 * `committedRecordType`. Nothing in the database refuses a value that points at
 * nothing, which makes it more dangerous rather than less. It is resolved
 * against the lab results, condition episodes and medications the restore has
 * just written, and a value that resolves to nothing is nulled TOGETHER with
 * its type and reported — a fact that still claimed to have been committed
 * somewhere, with no somewhere, would send a reader looking for a row that is
 * not there.
 *
 * ## Ciphertext follows the contract every other encrypted column here uses
 *
 * A disaster-recovery payload carries the stored bytes verbatim as base64,
 * because the same instance's key reads them back unchanged. A portable export
 * carries the decrypted JSON, because a portable export exists to be readable
 * by the person who owns it, exactly as it already decrypts medication notes,
 * mood notes and document summaries.
 *
 * The portable arm of the RESTORE is there for the reader's file, not for a
 * path this release can reach: a fact cannot exist without a document, and the
 * route refuses a portable file that carries any document ahead of the wipe
 * because document ciphertext is not in it. It is written the same way as the
 * coach turns rather than as a special case, so the next person reading either
 * file finds one contract instead of two.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { importKeysOf, SOURCE_KEY_SELECT } from "@/lib/documents/tombstones";
import {
  recordUnknownKeys,
  type RestoreSkipLog,
} from "@/lib/export/restore-skips";

export interface DocumentFilingBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

/** One document filed against one condition episode. */
export interface DocumentConditionLinkBackupEntry {
  documentId: string;
  episodeId: string;
  createdAt: string;
}

/** One fact the extraction pass staged against a document. */
export interface ExtractedFactBackupEntry {
  id: string;
  documentId: string;
  factType: string;
  /**
   * The review state and the commitment it produced. Carried verbatim; see the
   * file header for why letting these default re-opens a decided fact and lets
   * a second approval double the structured row behind it.
   */
  status: string;
  confidence: number;
  needsReview: boolean;
  committedRecordId: string | null;
  committedRecordType: string | null;
  /** Ciphertext as base64. Present on a disaster-recovery payload only. */
  dataEncrypted?: string;
  provenanceEncrypted?: string;
  /** Decrypted JSON. Present on a portable payload only. */
  data?: unknown;
  provenance?: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * One import source key the person deleted the document of. The ledger's own
 * rows (documents the purge removed) and the keys of the documents still
 * waiting in Recently deleted, which the file does not carry as documents.
 */
export interface DocumentImportKeyBackupEntry {
  sourceSystem: string;
  sourceId: string;
  sourceInstance: string | null;
  createdAt: string;
}

export interface DocumentFilingBackupSection {
  documentConditionLinks: DocumentConditionLinkBackupEntry[];
  extractedFacts: ExtractedFactBackupEntry[];
  documentImportKeys: DocumentImportKeyBackupEntry[];
}

export interface DocumentFilingBackupCounts {
  documentConditionLinks: number;
  extractedFacts: number;
  documentImportKeys: number;
}

/**
 * Every restorable column of both models.
 *
 * Named rather than inlined so a column added to either model shows up as a
 * diff here rather than as a silent omission from the file.
 */
const DOCUMENT_CONDITION_LINK_BACKUP_SELECT = {
  documentId: true,
  episodeId: true,
  createdAt: true,
} satisfies Prisma.DocumentConditionLinkSelect;

const EXTRACTED_FACT_BACKUP_SELECT = {
  id: true,
  documentId: true,
  factType: true,
  status: true,
  confidence: true,
  needsReview: true,
  committedRecordId: true,
  committedRecordType: true,
  dataEncrypted: true,
  provenanceEncrypted: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ExtractedFactSelect;

/**
 * Decrypt one JSON column, or say plainly that this one could not be read.
 *
 * A single row encrypted under a key the instance has since dropped must not
 * take the export down with it: the rest of the vault is still the person's.
 * The placeholder is an object rather than `null` because `null` reads as "the
 * extraction found nothing here", and that is not what happened.
 */
function decryptJsonSoft(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decryptFromBytes(bytes));
  } catch {
    return { unreadable: "encrypted with a key this instance no longer holds" };
  }
}

/**
 * What the person deleted on purpose among their imported documents, as the
 * import ledger would hold it once every deletion is purged: the ledger's own
 * rows, then the keys (own and alias) of every document still waiting in
 * Recently deleted. Those documents do not travel, as no tombstone ever has;
 * without their keys a restore onto a fresh instance would let an importer
 * store each one again. A key that appears twice is carried once.
 */
async function buildDeletedImportKeys(
  prisma: Pick<PrismaClient, "documentImportKey" | "inboundDocument">,
  userId: string,
): Promise<DocumentImportKeyBackupEntry[]> {
  const [ledger, tombstones] = await Promise.all([
    prisma.documentImportKey.findMany({
      where: { userId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        sourceSystem: true,
        sourceId: true,
        sourceInstance: true,
        createdAt: true,
      },
    }),
    prisma.inboundDocument.findMany({
      where: {
        userId,
        deletedAt: { not: null },
        OR: [
          { sourceSystem: { not: null }, sourceId: { not: null } },
          { sourceAliases: { some: {} } },
        ],
      },
      orderBy: [{ deletedAt: "asc" }, { id: "asc" }],
      select: { ...SOURCE_KEY_SELECT, deletedAt: true },
    }),
  ]);
  const out: DocumentImportKeyBackupEntry[] = [];
  const seen = new Set<string>();
  const add = (
    key: Omit<DocumentImportKeyBackupEntry, "createdAt">,
    at: Date,
  ) => {
    const id = JSON.stringify([
      key.sourceSystem,
      key.sourceInstance,
      key.sourceId,
    ]);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ ...key, createdAt: at.toISOString() });
  };
  for (const row of ledger) add(row, row.createdAt);
  for (const row of tombstones) {
    for (const key of importKeysOf(row)) add(key, row.deletedAt!);
  }
  return out;
}

export async function buildDocumentFilingBackupSection(
  prisma: Pick<
    PrismaClient,
    | "documentConditionLink"
    | "extractedFact"
    | "documentImportKey"
    | "inboundDocument"
  >,
  userId: string,
  options: DocumentFilingBackupOptions = {},
): Promise<DocumentFilingBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";

  // Both parents are foreign keys, so a row whose parent the file does not
  // carry could only ever restore as a reported loss. The document reader
  // skips tombstoned documents in BOTH purposes, and the episode reader skips
  // tombstoned episodes in a portable export only — so the filters here mirror
  // exactly what `records-backup.ts` decided to carry.
  const [linkRows, factRows, documentImportKeys] = await Promise.all([
    prisma.documentConditionLink.findMany({
      where: {
        userId,
        document: { deletedAt: null },
        ...(disasterRecovery ? {} : { episode: { deletedAt: null } }),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: DOCUMENT_CONDITION_LINK_BACKUP_SELECT,
    }),
    prisma.extractedFact.findMany({
      where: { userId, document: { deletedAt: null } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: EXTRACTED_FACT_BACKUP_SELECT,
    }),
    buildDeletedImportKeys(prisma, userId),
  ]);

  return {
    documentConditionLinks: linkRows.map((row) => ({
      documentId: row.documentId,
      episodeId: row.episodeId,
      createdAt: row.createdAt.toISOString(),
    })),
    extractedFacts: factRows.map((row) => ({
      id: row.id,
      documentId: row.documentId,
      factType: row.factType,
      status: row.status,
      confidence: row.confidence,
      needsReview: row.needsReview,
      committedRecordId: row.committedRecordId,
      committedRecordType: row.committedRecordType,
      ...(disasterRecovery
        ? {
            dataEncrypted: Buffer.from(row.dataEncrypted).toString("base64"),
            provenanceEncrypted: Buffer.from(row.provenanceEncrypted).toString(
              "base64",
            ),
          }
        : {
            data: decryptJsonSoft(row.dataEncrypted),
            provenance: decryptJsonSoft(row.provenanceEncrypted),
          }),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    documentImportKeys,
  };
}

/** Row counts for the audit trail, mirroring the other section counters. */
export function countDocumentFilingBackupSection(
  section: DocumentFilingBackupSection,
): DocumentFilingBackupCounts {
  return {
    documentConditionLinks: section.documentConditionLinks.length,
    extractedFacts: section.extractedFacts.length,
    documentImportKeys: section.documentImportKeys.length,
  };
}

/** Counts this restore wiped, for the audit trail. */
export interface DocumentFilingRestoreCleared {
  documentConditionLinks: number;
  extractedFacts: number;
  documentImportKeys: number;
}

type OptionalNullable<T> = { [K in keyof T]?: T[K] | undefined };

/**
 * What the parser hands over, which is looser than what the builder writes.
 *
 * The wire schema defaults or leaves optional every field an older file might
 * not carry. The three kept strictly required on a fact are `status`,
 * `needsReview` and `confidence`: a file that does not state a review decision
 * must not have one invented for it, and making them optional here would let
 * exactly that compile.
 */
export type RestoredExtractedFact = Pick<
  ExtractedFactBackupEntry,
  | "id"
  | "documentId"
  | "factType"
  | "status"
  | "confidence"
  | "needsReview"
  | "createdAt"
  | "updatedAt"
> &
  OptionalNullable<
    Pick<
      ExtractedFactBackupEntry,
      | "committedRecordId"
      | "committedRecordType"
      | "dataEncrypted"
      | "provenanceEncrypted"
      | "data"
      | "provenance"
    >
  >;

export interface DocumentFilingRestoreInput {
  documentConditionLinks: DocumentConditionLinkBackupEntry[];
  extractedFacts: RestoredExtractedFact[];
  documentImportKeys: Array<
    Pick<DocumentImportKeyBackupEntry, "sourceSystem" | "sourceId"> & {
      sourceInstance?: string | null;
      createdAt?: string;
    }
  >;
  /** The restored documents' own keys: a live document's key is not deleted. */
  documents: Array<{
    sourceSystem?: string | null;
    sourceId?: string | null;
    sourceInstance?: string | null;
  }>;
}

/**
 * The rows this restore has already written that these two can point at.
 *
 * Passed in rather than re-queried so this stays a pure function of the
 * transaction it was handed, the same arrangement the Coach attachments use.
 * `committedRecordIds` is the UNION of the restored lab results, condition
 * episodes and medications, because `committedRecordType` chooses between the
 * three and a fact naming a row from any of them is equally valid.
 */
export interface DocumentFilingRestoreRefs {
  documentIds: ReadonlySet<string>;
  episodeIds: ReadonlySet<string>;
  committedRecordIds: ReadonlySet<string>;
}

/**
 * Re-create the filings and the staged facts.
 *
 * Delete-then-recreate inside the caller's transaction, matching every other
 * section. Both tables cascade from `InboundDocument`, so the document wipe
 * earlier in the restore has already emptied them — they are counted and
 * cleared explicitly anyway, so the cleared numbers are truthful rather than
 * "whatever the cascade took" and so this stays correct if the document wipe
 * ever moves.
 *
 * MUST be called AFTER the documents, the condition episodes, the lab results
 * and the medications are restored. The first two are foreign keys and would
 * abort the transaction; the last two are what `committedRecordId` resolves
 * against, and resolving before they exist would null every commitment and
 * still report success.
 */
export async function restoreDocumentFilingData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: DocumentFilingRestoreInput,
  refs: DocumentFilingRestoreRefs,
  skips: RestoreSkipLog,
): Promise<DocumentFilingRestoreCleared> {
  const [clearedLinks, clearedFacts, clearedKeys] = await Promise.all([
    tx.documentConditionLink.deleteMany({ where: { userId: ownerId } }),
    tx.extractedFact.deleteMany({ where: { userId: ownerId } }),
    tx.documentImportKey.deleteMany({ where: { userId: ownerId } }),
  ]);
  await restoreDeletedImportKeys(tx, ownerId, payload);

  const droppedFilings: string[] = [];
  const writableLinks = payload.documentConditionLinks.filter((link) => {
    if (
      refs.documentIds.has(link.documentId) &&
      refs.episodeIds.has(link.episodeId)
    ) {
      return true;
    }
    // Reported under the end that is missing, so an operator reading the list
    // can tell "the page is gone" from "the condition is gone".
    droppedFilings.push(
      refs.documentIds.has(link.documentId) ? link.episodeId : link.documentId,
    );
    return false;
  });
  if (writableLinks.length > 0) {
    await tx.documentConditionLink.createMany({
      data: writableLinks.map((link) => ({
        userId: ownerId,
        documentId: link.documentId,
        episodeId: link.episodeId,
        createdAt: new Date(link.createdAt),
      })),
    });
  }
  recordUnknownKeys(
    skips,
    "documentConditionLink",
    [...new Set(droppedFilings)],
    droppedFilings,
  );

  const droppedFacts: string[] = [];
  const danglingCommitments: string[] = [];
  const writableFacts = payload.extractedFacts.filter((fact) => {
    if (refs.documentIds.has(fact.documentId)) return true;
    droppedFacts.push(fact.documentId);
    return false;
  });
  if (writableFacts.length > 0) {
    await tx.extractedFact.createMany({
      data: writableFacts.map((fact) => {
        // Nulled as a PAIR. A type with no id claims the fact was committed
        // somewhere and cannot say where, which sends a reader looking for a
        // row that is not there.
        let committedRecordId = fact.committedRecordId ?? null;
        let committedRecordType = fact.committedRecordType ?? null;
        if (
          committedRecordId &&
          !refs.committedRecordIds.has(committedRecordId)
        ) {
          danglingCommitments.push(committedRecordId);
          committedRecordId = null;
          committedRecordType = null;
        }
        return {
          id: fact.id,
          userId: ownerId,
          documentId: fact.documentId,
          factType: fact.factType as never,
          status: fact.status as never,
          confidence: fact.confidence,
          needsReview: fact.needsReview,
          committedRecordId,
          committedRecordType,
          dataEncrypted: resolveFactBytes(fact.dataEncrypted, fact.data),
          provenanceEncrypted: resolveFactBytes(
            fact.provenanceEncrypted,
            fact.provenance,
          ),
          createdAt: new Date(fact.createdAt),
          updatedAt: new Date(fact.updatedAt),
        };
      }),
    });
  }
  recordUnknownKeys(
    skips,
    "extractedFact",
    [...new Set(droppedFacts)],
    droppedFacts,
  );
  recordUnknownKeys(
    skips,
    "factCommitment",
    [...new Set(danglingCommitments)],
    danglingCommitments,
  );

  return {
    documentConditionLinks: clearedLinks.count,
    extractedFacts: clearedFacts.count,
    documentImportKeys: clearedKeys.count,
  };
}

/**
 * The import ledger back, as the file carries it, minus any key a restored
 * live document holds: the ledger says "the person deleted this", and a
 * document in the vault under that key says otherwise. A file written before
 * the ledger travelled carries none, and the restore then remembers no
 * deletion, as before.
 */
async function restoreDeletedImportKeys(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: DocumentFilingRestoreInput,
): Promise<void> {
  const keyOf = (k: {
    sourceSystem?: string | null;
    sourceId?: string | null;
    sourceInstance?: string | null;
  }) => JSON.stringify([k.sourceSystem, k.sourceInstance ?? null, k.sourceId]);
  const live = new Set(
    payload.documents
      .filter((d) => d.sourceSystem && d.sourceId)
      .map((d) => keyOf(d)),
  );
  const keys = payload.documentImportKeys.filter((k) => !live.has(keyOf(k)));
  if (keys.length === 0) return;
  await tx.documentImportKey.createMany({
    data: keys.map((k) => ({
      userId: ownerId,
      sourceSystem: k.sourceSystem,
      sourceId: k.sourceId,
      sourceInstance: k.sourceInstance ?? null,
      ...(k.createdAt ? { createdAt: new Date(k.createdAt) } : {}),
    })),
    skipDuplicates: true,
  });
}

/**
 * A fact column's stored bytes, whichever end of the contract the file came
 * from.
 *
 * A disaster-recovery file carries ciphertext that decodes straight back into
 * the column. A portable file carries the decrypted JSON, which has to be
 * encrypted on the way in under the TARGET instance's key — that is what makes
 * a portable file portable. An absent column encrypts `null` rather than
 * throwing, because the column is NOT NULL and a fact with unreadable
 * provenance is still a fact.
 */
function resolveFactBytes(
  ciphertext: string | undefined,
  json: unknown,
): Uint8Array<ArrayBuffer> {
  if (ciphertext !== undefined) {
    const decoded = Buffer.from(ciphertext, "base64");
    const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength));
    bytes.set(decoded);
    return bytes;
  }
  return encryptToBytes(JSON.stringify(json ?? null));
}
