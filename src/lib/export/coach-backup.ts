/**
 * The Coach's conversations, with both backup ends in one file.
 *
 * Same arrangement as `reminders-backup.ts`, `visits-backup.ts` and
 * `vaccinations-backup.ts`, for the same reason: a reader asking "is this
 * carried at both ends?" answers it here, and a reader who greps only the
 * restore ROUTE gets a false negative because the route delegates.
 *
 * Three models ride: the conversation, its messages, and the join naming which
 * vault documents a conversation was grounded in. All three sat on the
 * coverage-pending register, where the entry for the messages read "the largest
 * volume of free text an account owns after its documents". A restore without
 * this section hands back an account whose Coach has never spoken to it.
 *
 * ## Three things this file is careful about
 *
 * **The fence flag is the important field.** `documentScoped` is a PERMANENT
 * marker: it goes true when a conversation is created through the fenced
 * endpoint or gets its first document, and no code path anywhere sets it back
 * to false — not detaching every document, not deleting the document. A
 * conversation whose history may contain document-derived text must never
 * regain the tool loop. So it is carried verbatim and restored verbatim. A
 * restore that let it default to false would hand the tool loop back to exactly
 * the conversations the fence exists to keep away from it, and nothing in the
 * interface would look wrong afterwards. It is the one field here where losing
 * the value is a security regression rather than lost history.
 *
 * **Ids are carried in both modes**, as the reminders are, and for the same
 * kind of reason: a message addresses its conversation, an attachment addresses
 * both a conversation and a document, and the Coach's facts, plans and
 * reminders carry a `sourceConversationId` that has to land somewhere real.
 *
 * **The prose follows the contract every other encrypted column here uses.** A
 * disaster-recovery payload carries the stored ciphertext verbatim as base64,
 * because the same instance's key reads it back unchanged. A portable export
 * decrypts it, because a portable export exists to be readable by the person
 * who owns it, exactly as it already decrypts medication notes, mood notes and
 * document summaries. There is no third mode where a person's own words are
 * withheld from their own export.
 *
 * ## The one reference that needs care
 *
 * `CoachConversationDocument.documentId` addresses a vault document, which is
 * restored by the route BEFORE this section runs. A DR payload carries every
 * document, so the reference always resolves. A portable payload never reaches
 * a restore at all while the account has documents — the route refuses it
 * ahead of the wipe, because document ciphertext is not in the file — so an
 * attachment cannot survive into a restore whose document is missing. That
 * leaves the hand-edited or truncated file, and there the row is dropped and
 * REPORTED rather than invented, the same answer the ledger gives for a
 * reminder it cannot find.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { UNREADABLE_EXPORT_MARKER } from "./unreadable-marker";
import {
  recordUnknownKeys,
  type RestoreSkipLog,
} from "@/lib/export/restore-skips";

export interface CoachBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

/**
 * One turn. `role` is the app-side pair "user" | "assistant", stored as a
 * plain string rather than an enum, so it travels as written.
 */
export interface CoachMessageBackupEntry {
  id: string;
  role: string;
  /** Ciphertext as base64. Present on a disaster-recovery payload only. */
  contentEncrypted?: string;
  /** Plaintext. Present on a portable payload only. */
  content?: string;
  metricSourceJson: string | null;
  providerType: string | null;
  promptVersion: string | null;
  tokensUsed: number | null;
  model: string | null;
  /**
   * v1.39.4 — the tables of values the turn read, as ciphertext in base64.
   * Present on a disaster-recovery payload only; null on a turn without one.
   */
  resultsEncrypted?: string | null;
  /**
   * v1.39.4 — the same tables as readable JSON (a `CoachResultTable[]`
   * array), on a portable payload only; null on a turn without one. The
   * unreadable-row marker stands in for tables that did not decrypt.
   */
  resultsJson?: string | null;
  /**
   * v1.41 — the model text of the turn's trail, as ciphertext in base64.
   * Present on a disaster-recovery payload only; null on a turn without one.
   */
  trailEncrypted?: string | null;
  /**
   * v1.41 — the same trail as readable JSON (a `CoachTrail`), on a portable
   * payload only; null on a turn without one.
   */
  trailJson?: string | null;
  createdAt: string;
}

/** Which vault document a conversation was grounded in. */
export interface CoachConversationDocumentBackupEntry {
  documentId: string;
  addedAt: string;
}

export interface CoachConversationBackupEntry {
  /** Always carried: messages, attachments and the Coach's own facts, plans
   *  and reminders all address a conversation by it. */
  id: string;
  /**
   * The readable title. Present on a portable payload, on every file written
   * before v1.39.3, and on a disaster-recovery payload for a row the free-text
   * backfill had not reached yet.
   */
  title?: string;
  /** v1.39.3 — the title's ciphertext as base64. Disaster-recovery only. */
  titleEncrypted?: string;
  /**
   * The permanent fence marker. Carried and restored verbatim; see the file
   * header for why letting this default is a security regression and not a
   * cosmetic one.
   */
  documentScoped: boolean;
  /** Rolling summary of elided older turns. Same codec as a message. */
  summaryEncrypted?: string | null;
  summary?: string | null;
  summaryUpdatedAt: string | null;
  summaryTurnCount: number;
  createdAt: string;
  updatedAt: string;
  messages: CoachMessageBackupEntry[];
  attachments: CoachConversationDocumentBackupEntry[];
}

export interface CoachBackupSection {
  coachConversations: CoachConversationBackupEntry[];
}

export interface CoachBackupCounts {
  coachConversations: number;
  coachMessages: number;
  coachConversationDocuments: number;
}

/**
 * Every restorable `CoachConversation` scalar plus its two child relations.
 *
 * Named rather than inlined so a structural test can read the field list, and
 * so a column added to the model shows up as a diff here rather than as a
 * silent omission from the file.
 */
const COACH_CONVERSATION_BACKUP_SELECT = {
  id: true,
  title: true,
  titleEncrypted: true,
  documentScoped: true,
  summaryEncrypted: true,
  summaryUpdatedAt: true,
  summaryTurnCount: true,
  createdAt: true,
  updatedAt: true,
  messages: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      role: true,
      encryptedContent: true,
      metricSourceJson: true,
      providerType: true,
      promptVersion: true,
      tokensUsed: true,
      model: true,
      resultsEncrypted: true,
      trailEncrypted: true,
      createdAt: true,
    },
  },
  attachments: {
    orderBy: { addedAt: "asc" },
    select: { documentId: true, addedAt: true },
  },
} satisfies Prisma.CoachConversationSelect;

/**
 * Decrypt for a reader, or say plainly that this one turn could not be read.
 *
 * A single row encrypted under a key the instance has since dropped must not
 * take the export down with it: the rest of the transcript is still the
 * person's, and a thrown error would cost them all of it. The placeholder is
 * deliberately a sentence rather than an empty string, because an empty string
 * reads as "they said nothing here" and that is not what happened.
 */
function decryptTurnSoft(bytes: Uint8Array | null): string | null {
  if (!bytes) return null;
  try {
    return decryptFromBytes(bytes);
  } catch {
    return UNREADABLE_EXPORT_MARKER;
  }
}

/** A title for a reader: ciphertext first, legacy readable column after. */
function readTitleSoft(row: {
  title: string | null;
  titleEncrypted: Uint8Array | null;
}): string {
  if (row.titleEncrypted && row.titleEncrypted.byteLength > 0) {
    return decryptTurnSoft(row.titleEncrypted) ?? "";
  }
  return row.title ?? "";
}

export async function buildCoachBackupSection(
  prisma: Pick<PrismaClient, "coachConversation">,
  userId: string,
  options: CoachBackupOptions = {},
): Promise<CoachBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";

  const rows = await prisma.coachConversation.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: COACH_CONVERSATION_BACKUP_SELECT,
  });

  return {
    coachConversations: rows.map((row) => ({
      id: row.id,
      // A disaster-recovery file carries the stored bytes: the ciphertext,
      // or, for a row the free-text backfill has not reached yet, the old
      // readable title exactly as stored (the restore seals it). Sealing it
      // here instead would make the export non-deterministic, and the
      // streaming writer and this builder must produce the same file.
      ...(disasterRecovery && row.titleEncrypted
        ? {
            titleEncrypted: Buffer.from(row.titleEncrypted).toString("base64"),
          }
        : disasterRecovery
          ? { title: row.title ?? "" }
          : { title: readTitleSoft(row) }),
      documentScoped: row.documentScoped,
      ...(disasterRecovery
        ? {
            summaryEncrypted: row.summaryEncrypted
              ? Buffer.from(row.summaryEncrypted).toString("base64")
              : null,
          }
        : { summary: decryptTurnSoft(row.summaryEncrypted) }),
      summaryUpdatedAt: row.summaryUpdatedAt?.toISOString() ?? null,
      summaryTurnCount: row.summaryTurnCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      messages: row.messages.map((message) => ({
        id: message.id,
        role: message.role,
        ...(disasterRecovery
          ? {
              contentEncrypted: Buffer.from(message.encryptedContent).toString(
                "base64",
              ),
            }
          : { content: decryptTurnSoft(message.encryptedContent) ?? "" }),
        metricSourceJson: message.metricSourceJson,
        providerType: message.providerType,
        promptVersion: message.promptVersion,
        tokensUsed: message.tokensUsed,
        model: message.model,
        // v1.39.4 — the tables follow the same contract as the prose.
        ...(disasterRecovery
          ? {
              resultsEncrypted: message.resultsEncrypted
                ? Buffer.from(message.resultsEncrypted).toString("base64")
                : null,
            }
          : { resultsJson: decryptTurnSoft(message.resultsEncrypted) }),
        // v1.41 — and so does the trail.
        ...(disasterRecovery
          ? {
              trailEncrypted: message.trailEncrypted
                ? Buffer.from(message.trailEncrypted).toString("base64")
                : null,
            }
          : { trailJson: decryptTurnSoft(message.trailEncrypted) }),
        createdAt: message.createdAt.toISOString(),
      })),
      attachments: row.attachments.map((attachment) => ({
        documentId: attachment.documentId,
        addedAt: attachment.addedAt.toISOString(),
      })),
    })),
  };
}

/** Row counts for the audit trail, mirroring the other section counters. */
export function countCoachBackupSection(
  section: CoachBackupSection,
): CoachBackupCounts {
  return {
    coachConversations: section.coachConversations.length,
    coachMessages: section.coachConversations.reduce(
      (total, conversation) => total + conversation.messages.length,
      0,
    ),
    coachConversationDocuments: section.coachConversations.reduce(
      (total, conversation) => total + conversation.attachments.length,
      0,
    ),
  };
}

/** Counts the Coach restore wiped, for the audit trail. */
export interface CoachRestoreCleared {
  coachConversations: number;
  coachMessages: number;
  coachConversationDocuments: number;
}

/**
 * The slice of a parsed backup this restore consumes.
 *
 * Required rather than optional: the payload schema defaults the key, so every
 * caller already satisfies this, and one that stops satisfying it fails to
 * compile instead of quietly restoring nothing.
 */
export interface CoachRestoreInput {
  coachConversations: RestoredCoachConversation[];
}

/**
 * What the parser hands over, which is looser than what the builder writes.
 *
 * The wire schema defaults or leaves optional every field an older file might
 * not carry, so the restore reads that shape rather than the builder's. The
 * one field kept strictly required is `documentScoped`: a file that does not
 * state the fence must not be silently re-fenced to the permissive value, and
 * making it optional here would let exactly that compile.
 */
type OptionalNullable<T> = { [K in keyof T]?: T[K] | undefined };

export type RestoredCoachMessage = Pick<
  CoachMessageBackupEntry,
  "id" | "role" | "createdAt"
> &
  OptionalNullable<
    Pick<
      CoachMessageBackupEntry,
      | "contentEncrypted"
      | "content"
      | "metricSourceJson"
      | "providerType"
      | "promptVersion"
      | "tokensUsed"
      | "model"
      | "resultsEncrypted"
      | "resultsJson"
      | "trailEncrypted"
      | "trailJson"
    >
  >;

export type RestoredCoachConversation = Pick<
  CoachConversationBackupEntry,
  "id" | "documentScoped" | "createdAt" | "updatedAt"
> &
  OptionalNullable<
    Pick<
      CoachConversationBackupEntry,
      | "title"
      | "titleEncrypted"
      | "summaryEncrypted"
      | "summary"
      | "summaryUpdatedAt"
      | "summaryTurnCount"
    >
  > & {
    messages: RestoredCoachMessage[];
    attachments: CoachConversationDocumentBackupEntry[];
  };

/**
 * Re-create the account's Coach conversations, turns and document links.
 *
 * Delete-then-recreate inside the caller's transaction, matching every other
 * section. Messages and attachments cascade from the conversation, so deleting
 * the conversations is enough to empty them — they are counted first anyway, so
 * the cleared numbers are truthful rather than "whatever the cascade took".
 *
 * MUST be called AFTER the vault documents are restored: an attachment carries
 * a `documentId` that is a foreign key against them, and running earlier would
 * make every attachment unresolvable.
 *
 * `documentIds` is the set of documents the restore actually put back, passed
 * in rather than re-queried so this stays a pure function of the transaction it
 * was handed. An attachment naming anything outside it is dropped and reported.
 */
export async function restoreCoachData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: CoachRestoreInput,
  documentIds: ReadonlySet<string>,
  skips: RestoreSkipLog,
): Promise<CoachRestoreCleared> {
  const [clearedMessages, clearedAttachments] = await Promise.all([
    tx.coachMessage.count({ where: { conversation: { userId: ownerId } } }),
    tx.coachConversationDocument.count({
      where: { conversation: { userId: ownerId } },
    }),
  ]);
  const clearedConversations = await tx.coachConversation.deleteMany({
    where: { userId: ownerId },
  });

  for (const conversation of payload.coachConversations) {
    await tx.coachConversation.create({
      data: {
        id: conversation.id,
        userId: ownerId,
        // v1.39.3 — the title is stored encrypted; the readable column is
        // never written on a restore.
        titleEncrypted: resolveTitleBytes(conversation),
        // Verbatim. See the file header: this is the one field whose loss is a
        // security regression rather than a gap in the history.
        documentScoped: conversation.documentScoped,
        summaryEncrypted: resolveSummaryBytes(conversation),
        summaryUpdatedAt: conversation.summaryUpdatedAt
          ? new Date(conversation.summaryUpdatedAt)
          : null,
        summaryTurnCount: conversation.summaryTurnCount ?? 0,
        createdAt: new Date(conversation.createdAt),
        updatedAt: new Date(conversation.updatedAt),
        messages: {
          create: conversation.messages.map((message) => ({
            id: message.id,
            role: message.role,
            encryptedContent: resolveTurnBytes(message),
            metricSourceJson: message.metricSourceJson ?? null,
            providerType: message.providerType ?? null,
            promptVersion: message.promptVersion ?? null,
            tokensUsed: message.tokensUsed ?? null,
            model: message.model ?? null,
            resultsEncrypted: resolveResultsBytes(message),
            trailEncrypted: resolveTrailBytes(message),
            createdAt: new Date(message.createdAt),
          })),
        },
      },
    });
  }

  // The attachments go in a second pass so a dropped document reference costs
  // one link rather than the conversation that held it.
  const droppedDocumentRefs: string[] = [];
  for (const conversation of payload.coachConversations) {
    const writable = conversation.attachments.filter((attachment) => {
      if (documentIds.has(attachment.documentId)) return true;
      droppedDocumentRefs.push(attachment.documentId);
      return false;
    });
    if (writable.length === 0) continue;
    await tx.coachConversationDocument.createMany({
      data: writable.map((attachment) => ({
        conversationId: conversation.id,
        documentId: attachment.documentId,
        addedAt: new Date(attachment.addedAt),
      })),
    });
  }
  recordUnknownKeys(
    skips,
    "coachAttachment",
    [...new Set(droppedDocumentRefs)],
    droppedDocumentRefs,
  );

  return {
    coachConversations: clearedConversations.count,
    coachMessages: clearedMessages,
    coachConversationDocuments: clearedAttachments,
  };
}

/**
 * A turn's stored bytes, whichever end of the contract the file came from.
 *
 * A disaster-recovery file carries ciphertext that decodes straight back into
 * the column. A portable file carries plaintext, which has to be encrypted on
 * the way in — the target instance's key, not the source's, which is the whole
 * point of a portable file being portable.
 */
function resolveTurnBytes(
  message: RestoredCoachMessage,
): Uint8Array<ArrayBuffer> {
  if (message.contentEncrypted !== undefined) {
    return decodeBase64(message.contentEncrypted);
  }
  return encryptToBytes(message.content ?? "");
}

/**
 * v1.39.4 — a turn's stored tables, from either end of the contract. A
 * disaster-recovery file carries the ciphertext; a portable file carries the
 * JSON, sealed here under the target instance's key. Neither end writes a
 * zero-byte ciphertext for a turn without tables.
 */
function resolveResultsBytes(
  message: RestoredCoachMessage,
): Uint8Array<ArrayBuffer> | null {
  if (message.resultsEncrypted !== undefined) {
    return message.resultsEncrypted === null
      ? null
      : decodeBase64(message.resultsEncrypted);
  }
  return message.resultsJson ? encryptToBytes(message.resultsJson) : null;
}

/** v1.41 — a turn's stored trail, from either end of the contract. */
function resolveTrailBytes(
  message: RestoredCoachMessage,
): Uint8Array<ArrayBuffer> | null {
  if (message.trailEncrypted !== undefined) {
    return message.trailEncrypted === null
      ? null
      : decodeBase64(message.trailEncrypted);
  }
  return message.trailJson ? encryptToBytes(message.trailJson) : null;
}

function resolveTitleBytes(
  conversation: RestoredCoachConversation,
): Uint8Array<ArrayBuffer> {
  if (conversation.titleEncrypted !== undefined) {
    return decodeBase64(conversation.titleEncrypted);
  }
  return encryptToBytes(conversation.title ?? "");
}

function resolveSummaryBytes(
  conversation: RestoredCoachConversation,
): Uint8Array<ArrayBuffer> | null {
  if (conversation.summaryEncrypted !== undefined) {
    return conversation.summaryEncrypted === null
      ? null
      : decodeBase64(conversation.summaryEncrypted);
  }
  // A portable file with no summary and one with an empty summary are the same
  // thing to a reader, and neither should write a zero-byte ciphertext.
  return conversation.summary ? encryptToBytes(conversation.summary) : null;
}

function decodeBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(encoded, "base64");
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength));
  bytes.set(decoded);
  return bytes;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The Coach's MEMORY: the facts, plans and reminders it carries BETWEEN
 * threads.
 *
 * The transcript above is what was said. This is what the Coach was asked to
 * keep. Without it a restored account has every word of every conversation and
 * a Coach that has to be told its own history again — which the register named
 * exactly: "a restore makes the account re-tell its history", "keeps the talk
 * and loses the commitment", "a restored account silently stops sending them".
 *
 * ## Tombstones ride, but only in a disaster-recovery file
 *
 * All three soft-delete. A deleted fact is hidden from injection and kept for
 * audit, which is a distinction only the owning instance can act on, so a
 * disaster-recovery payload carries the tombstone and a portable export omits
 * it — the same split the Vorsorge reminders use. A portable file that carried
 * them would hand a person rows their own app refuses to show them, and a
 * restore that resurrected one would put a fact back into the Coach's mouth
 * that the person had deliberately taken out of it.
 *
 * ## Two references, neither of them a foreign key
 *
 * `sourceConversationId` and `relatedPlanId` are bare id columns — the schema
 * declares no relation for either, so nothing in the database refuses a value
 * that points at nothing. That makes them more dangerous than a real key, not
 * less: a dangling reference costs no error, it just quietly stops meaning
 * anything, and the row goes on looking complete.
 *
 * So the restore resolves both against what it actually wrote and NULLS what it
 * cannot resolve, then reports the count. Nulling rather than dropping is the
 * point: a live reminder must not be lost because the plan it mentions was
 * tombstoned out of a portable file. The reminder is still the person's, and it
 * still fires. What it loses is a pointer that was already going nowhere.
 * ──────────────────────────────────────────────────────────────────────────── */

/** One durable fact the Coach was told to remember. */
export interface CoachFactBackupEntry {
  id: string;
  /** Ciphertext as base64. Present on a disaster-recovery payload only. */
  factEncrypted?: string;
  /** Plaintext. Present on a portable payload only. */
  fact?: string;
  category: string;
  confidence: number;
  sourceConversationId: string | null;
  /** v1.41 — `user`, `coach`, `extracted` or `pattern`. */
  source: string;
  /** v1.41 */
  lastUsedAt: string | null;
  /**
   * v1.41 — the message the fact came out of. A bare id like
   * `sourceConversationId`, resolved the same way on restore.
   */
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

/** One implementation intention: "if <cue>, then <action>". */
export interface CoachPlanBackupEntry {
  id: string;
  metric: string;
  ifCueEncrypted?: string;
  ifCue?: string;
  thenActionEncrypted?: string;
  thenAction?: string;
  targetEncrypted?: string | null;
  target?: string | null;
  outcomeEncrypted?: string | null;
  outcome?: string | null;
  status: string;
  reviewDate: string | null;
  sourceConversationId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

/** One thing to bring back up, in the person's own framing. */
export interface CoachReminderBackupEntry {
  id: string;
  noteEncrypted?: string;
  note?: string;
  metric: string | null;
  relatedPlanId: string | null;
  triggerKind: string;
  dueAt: string | null;
  contextCue: string | null;
  status: string;
  source: string;
  sourceConversationId: string | null;
  lastSurfacedAt: string | null;
  surfaceCount: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface CoachMemoryBackupSection {
  coachFacts: CoachFactBackupEntry[];
  coachPlans: CoachPlanBackupEntry[];
  coachReminders: CoachReminderBackupEntry[];
}

export interface CoachMemoryBackupCounts {
  coachFacts: number;
  coachPlans: number;
  coachReminders: number;
}

export async function buildCoachMemoryBackupSection(
  prisma: Pick<PrismaClient, "coachFact" | "coachPlan" | "coachReminder">,
  userId: string,
  options: CoachBackupOptions = {},
): Promise<CoachMemoryBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";
  const scope = disasterRecovery ? { userId } : { userId, deletedAt: null };

  const [factRows, planRows, reminderRows] = await Promise.all([
    prisma.coachFact.findMany({
      where: scope,
      orderBy: { createdAt: "asc" },
      select: COACH_FACT_BACKUP_SELECT,
    }),
    prisma.coachPlan.findMany({
      where: scope,
      orderBy: { createdAt: "asc" },
      select: COACH_PLAN_BACKUP_SELECT,
    }),
    prisma.coachReminder.findMany({
      where: scope,
      orderBy: { createdAt: "asc" },
      select: COACH_REMINDER_BACKUP_SELECT,
    }),
  ]);

  const asBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
  const asBase64OrNull = (bytes: Uint8Array | null) =>
    bytes ? asBase64(bytes) : null;

  return {
    coachFacts: factRows.map((row) => ({
      id: row.id,
      ...(disasterRecovery
        ? {
            factEncrypted: asBase64(row.factEncrypted),
            deletedAt: row.deletedAt?.toISOString() ?? null,
          }
        : { fact: decryptTurnSoft(row.factEncrypted) ?? "" }),
      category: row.category,
      confidence: row.confidence,
      sourceConversationId: row.sourceConversationId,
      source: row.source,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      sourceMessageId: row.sourceMessageId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    coachPlans: planRows.map((row) => ({
      id: row.id,
      metric: row.metric,
      ...(disasterRecovery
        ? {
            ifCueEncrypted: asBase64(row.ifCueEncrypted),
            thenActionEncrypted: asBase64(row.thenActionEncrypted),
            targetEncrypted: asBase64OrNull(row.targetEncrypted),
            outcomeEncrypted: asBase64OrNull(row.outcomeEncrypted),
            deletedAt: row.deletedAt?.toISOString() ?? null,
          }
        : {
            ifCue: decryptTurnSoft(row.ifCueEncrypted) ?? "",
            thenAction: decryptTurnSoft(row.thenActionEncrypted) ?? "",
            target: decryptTurnSoft(row.targetEncrypted),
            outcome: decryptTurnSoft(row.outcomeEncrypted),
          }),
      status: row.status,
      reviewDate: row.reviewDate?.toISOString() ?? null,
      sourceConversationId: row.sourceConversationId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    coachReminders: reminderRows.map((row) => ({
      id: row.id,
      ...(disasterRecovery
        ? {
            noteEncrypted: asBase64(row.noteEncrypted),
            deletedAt: row.deletedAt?.toISOString() ?? null,
          }
        : { note: decryptTurnSoft(row.noteEncrypted) ?? "" }),
      metric: row.metric,
      relatedPlanId: row.relatedPlanId,
      triggerKind: row.triggerKind,
      dueAt: row.dueAt?.toISOString() ?? null,
      contextCue: row.contextCue,
      status: row.status,
      source: row.source,
      sourceConversationId: row.sourceConversationId,
      lastSurfacedAt: row.lastSurfacedAt?.toISOString() ?? null,
      surfaceCount: row.surfaceCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

const COACH_FACT_BACKUP_SELECT = {
  id: true,
  factEncrypted: true,
  category: true,
  confidence: true,
  sourceConversationId: true,
  source: true,
  lastUsedAt: true,
  sourceMessageId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} satisfies Prisma.CoachFactSelect;

const COACH_PLAN_BACKUP_SELECT = {
  id: true,
  metric: true,
  ifCueEncrypted: true,
  thenActionEncrypted: true,
  targetEncrypted: true,
  outcomeEncrypted: true,
  status: true,
  reviewDate: true,
  sourceConversationId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} satisfies Prisma.CoachPlanSelect;

const COACH_REMINDER_BACKUP_SELECT = {
  id: true,
  noteEncrypted: true,
  metric: true,
  relatedPlanId: true,
  triggerKind: true,
  dueAt: true,
  contextCue: true,
  status: true,
  source: true,
  sourceConversationId: true,
  lastSurfacedAt: true,
  surfaceCount: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} satisfies Prisma.CoachReminderSelect;

/** Row counts for the audit trail, mirroring the other section counters. */
export function countCoachMemoryBackupSection(
  section: CoachMemoryBackupSection,
): CoachMemoryBackupCounts {
  return {
    coachFacts: section.coachFacts.length,
    coachPlans: section.coachPlans.length,
    coachReminders: section.coachReminders.length,
  };
}

/** Counts the Coach-memory restore wiped, for the audit trail. */
export interface CoachMemoryRestoreCleared {
  coachFacts: number;
  coachPlans: number;
  coachReminders: number;
}

type OptionalMemory<T> = { [K in keyof T]?: T[K] | undefined };

export type RestoredCoachFact = Pick<
  CoachFactBackupEntry,
  "id" | "category" | "createdAt" | "updatedAt"
> &
  OptionalMemory<
    Pick<
      CoachFactBackupEntry,
      | "factEncrypted"
      | "fact"
      | "confidence"
      | "sourceConversationId"
      | "source"
      | "lastUsedAt"
      | "sourceMessageId"
      | "deletedAt"
    >
  >;

export type RestoredCoachPlan = Pick<
  CoachPlanBackupEntry,
  "id" | "metric" | "createdAt" | "updatedAt"
> &
  OptionalMemory<
    Pick<
      CoachPlanBackupEntry,
      | "ifCueEncrypted"
      | "ifCue"
      | "thenActionEncrypted"
      | "thenAction"
      | "targetEncrypted"
      | "target"
      | "outcomeEncrypted"
      | "outcome"
      | "status"
      | "reviewDate"
      | "sourceConversationId"
      | "deletedAt"
    >
  >;

export type RestoredCoachReminder = Pick<
  CoachReminderBackupEntry,
  "id" | "source" | "createdAt" | "updatedAt"
> &
  OptionalMemory<
    Pick<
      CoachReminderBackupEntry,
      | "noteEncrypted"
      | "note"
      | "metric"
      | "relatedPlanId"
      | "triggerKind"
      | "dueAt"
      | "contextCue"
      | "status"
      | "sourceConversationId"
      | "lastSurfacedAt"
      | "surfaceCount"
      | "deletedAt"
    >
  >;

export interface CoachMemoryRestoreInput {
  coachFacts: RestoredCoachFact[];
  coachPlans: RestoredCoachPlan[];
  coachReminders: RestoredCoachReminder[];
}

/**
 * Re-create the Coach's memory.
 *
 * MUST be called AFTER `restoreCoachData`: every one of the three carries a
 * `sourceConversationId`, and a reference resolved before the threads exist
 * would read as unresolvable and be nulled — a restore that reported success
 * while quietly cutting every fact loose from the conversation it came out of.
 *
 * Plans go in before reminders for the same reason one step down: a reminder's
 * `relatedPlanId` is resolved against the plans this function has just written.
 *
 * A fact's `sourceMessageId` (v1.41) is resolved against the messages the
 * conversation restore wrote, and nulled and reported the same way when it
 * names one the file did not carry.
 */
export async function restoreCoachMemoryData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: CoachMemoryRestoreInput,
  conversationIds: ReadonlySet<string>,
  messageIds: ReadonlySet<string>,
  skips: RestoreSkipLog,
): Promise<CoachMemoryRestoreCleared> {
  const [clearedFacts, clearedPlans, clearedReminders] = await Promise.all([
    tx.coachFact.deleteMany({ where: { userId: ownerId } }),
    tx.coachPlan.deleteMany({ where: { userId: ownerId } }),
    tx.coachReminder.deleteMany({ where: { userId: ownerId } }),
  ]);

  // Both references are nulled rather than dropped when they do not resolve,
  // and every miss is reported. See the section header: these are bare id
  // columns, so a dangling value costs no error and simply stops meaning
  // anything.
  const danglingRefs: string[] = [];
  const resolveConversation = (id: string | null | undefined) => {
    if (!id) return null;
    if (conversationIds.has(id)) return id;
    danglingRefs.push(id);
    return null;
  };
  const resolveMessage = (id: string | null | undefined) => {
    if (!id) return null;
    if (messageIds.has(id)) return id;
    danglingRefs.push(id);
    return null;
  };

  if (payload.coachFacts.length > 0) {
    await tx.coachFact.createMany({
      data: payload.coachFacts.map((fact) => ({
        id: fact.id,
        userId: ownerId,
        factEncrypted: resolveMemoryBytes(fact.factEncrypted, fact.fact),
        category: fact.category,
        confidence: fact.confidence ?? 50,
        sourceConversationId: resolveConversation(fact.sourceConversationId),
        // A file written before v1.41 states no source; every fact then came
        // from the extraction or the matcher, which is what the column's
        // default says too.
        source: fact.source ?? "extracted",
        lastUsedAt: fact.lastUsedAt ? new Date(fact.lastUsedAt) : null,
        sourceMessageId: resolveMessage(fact.sourceMessageId),
        createdAt: new Date(fact.createdAt),
        updatedAt: new Date(fact.updatedAt),
        deletedAt: fact.deletedAt ? new Date(fact.deletedAt) : null,
      })),
    });
  }

  if (payload.coachPlans.length > 0) {
    await tx.coachPlan.createMany({
      data: payload.coachPlans.map((plan) => ({
        id: plan.id,
        userId: ownerId,
        metric: plan.metric,
        ifCueEncrypted: resolveMemoryBytes(plan.ifCueEncrypted, plan.ifCue),
        thenActionEncrypted: resolveMemoryBytes(
          plan.thenActionEncrypted,
          plan.thenAction,
        ),
        targetEncrypted: resolveOptionalMemoryBytes(
          plan.targetEncrypted,
          plan.target,
        ),
        outcomeEncrypted: resolveOptionalMemoryBytes(
          plan.outcomeEncrypted,
          plan.outcome,
        ),
        status: plan.status ?? "proposed",
        reviewDate: plan.reviewDate ? new Date(plan.reviewDate) : null,
        sourceConversationId: resolveConversation(plan.sourceConversationId),
        createdAt: new Date(plan.createdAt),
        updatedAt: new Date(plan.updatedAt),
        deletedAt: plan.deletedAt ? new Date(plan.deletedAt) : null,
      })),
    });
  }

  const restoredPlanIds = new Set(payload.coachPlans.map((plan) => plan.id));
  if (payload.coachReminders.length > 0) {
    await tx.coachReminder.createMany({
      data: payload.coachReminders.map((reminder) => {
        let relatedPlanId = reminder.relatedPlanId ?? null;
        if (relatedPlanId && !restoredPlanIds.has(relatedPlanId)) {
          danglingRefs.push(relatedPlanId);
          relatedPlanId = null;
        }
        return {
          id: reminder.id,
          userId: ownerId,
          noteEncrypted: resolveMemoryBytes(
            reminder.noteEncrypted,
            reminder.note,
          ),
          metric: reminder.metric ?? null,
          relatedPlanId,
          triggerKind: reminder.triggerKind ?? "date",
          dueAt: reminder.dueAt ? new Date(reminder.dueAt) : null,
          contextCue: reminder.contextCue ?? null,
          status: reminder.status ?? "active",
          source: reminder.source,
          sourceConversationId: resolveConversation(
            reminder.sourceConversationId,
          ),
          lastSurfacedAt: reminder.lastSurfacedAt
            ? new Date(reminder.lastSurfacedAt)
            : null,
          surfaceCount: reminder.surfaceCount ?? 0,
          createdAt: new Date(reminder.createdAt),
          updatedAt: new Date(reminder.updatedAt),
          deletedAt: reminder.deletedAt ? new Date(reminder.deletedAt) : null,
        };
      }),
    });
  }

  recordUnknownKeys(
    skips,
    "coachReference",
    [...new Set(danglingRefs)],
    danglingRefs,
  );

  return {
    coachFacts: clearedFacts.count,
    coachPlans: clearedPlans.count,
    coachReminders: clearedReminders.count,
  };
}

function resolveMemoryBytes(
  ciphertext: string | undefined,
  plaintext: string | undefined,
): Uint8Array<ArrayBuffer> {
  if (ciphertext !== undefined) return decodeBase64(ciphertext);
  return encryptToBytes(plaintext ?? "");
}

function resolveOptionalMemoryBytes(
  ciphertext: string | null | undefined,
  plaintext: string | null | undefined,
): Uint8Array<ArrayBuffer> | null {
  if (ciphertext !== undefined) {
    return ciphertext === null ? null : decodeBase64(ciphertext);
  }
  return plaintext ? encryptToBytes(plaintext) : null;
}
