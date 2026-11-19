/**
 * Person-defined symptoms, with both backup ends in one file (v1.40).
 *
 * Same arrangement as `ecg-backup.ts` and `reminders-backup.ts`: a reader
 * asking "is this carried at both ends?" answers it here, and a reader who
 * greps only the restore route gets a false negative because the route
 * delegates.
 *
 * ## Events ride inside their definition
 *
 * An occurrence means nothing without the symptom it is an occurrence of, so
 * the file nests each definition's events under it, the way a medication's
 * side effects ride inside the medication. A nested create binds the child to
 * whatever id the parent row actually got, so there is no definition reference
 * to resolve and none that can dangle.
 *
 * ## Free text follows the note contract
 *
 * A disaster-recovery payload carries the label and note ciphertext verbatim
 * as base64 (the same instance's key reads it back unchanged). A portable
 * export decrypts both, because a portable file exists to be readable by the
 * person who owns it and to restore under another instance's key. A label this
 * instance cannot decrypt travels as the visible unreadable marker rather than
 * as nothing, the rule `records-backup.ts` states for notes: the definition is
 * still the person's, and an empty name would read as one they never gave.
 *
 * ## The one reference that needs care
 *
 * `episodeId` addresses an illness episode and is a real foreign key. A
 * portable export omits soft-deleted episodes, so an occurrence filed against
 * an episode the person has since deleted names a row the file does not carry.
 * The restore resolves the reference against the episodes it actually wrote
 * and NULLS a miss (reported as `symptomEpisodeReference`) rather than writing
 * it and rolling the whole restore back. The occurrence is the record; the
 * episode link is a cross-reference.
 */
import { Buffer } from "node:buffer";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { getEvent } from "@/lib/logging/context";
import { isSymptomBuiltinCode } from "@/lib/symptoms/builtin";
import {
  recordUnknownKeys,
  type RestoreSkipLog,
} from "@/lib/export/restore-skips";

import { UNREADABLE_EXPORT_MARKER } from "./unreadable-marker";

export interface SymptomsBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

/** One occurrence, nested under its definition. */
export interface SymptomEventBackupEntry {
  /** Present in a disaster-recovery payload. */
  id?: string;
  occurredAt: string;
  intensity: number;
  /** Plaintext; present on a portable payload. */
  note?: string | null;
  /** Ciphertext as base64; present on a disaster-recovery payload. */
  noteEncrypted?: string | null;
  episodeId: string | null;
  endAt: string | null;
  source: string;
  externalId: string | null;
  /** Present in a disaster-recovery payload: the tombstone of an import. */
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One definition and every occurrence of it. */
export interface SymptomDefinitionBackupEntry {
  /** Present in a disaster-recovery payload. */
  id?: string;
  /** Plaintext; present on a portable payload. */
  label?: string;
  /** Ciphertext as base64; present on a disaster-recovery payload. */
  labelEncrypted?: string;
  icon: string | null;
  sortOrder: number;
  isActive: boolean;
  code: string | null;
  createdAt: string;
  updatedAt: string;
  events: SymptomEventBackupEntry[];
}

export interface SymptomsBackupSection {
  symptomDefinitions: SymptomDefinitionBackupEntry[];
}

export interface SymptomsBackupCounts {
  symptomDefinitions: number;
  symptomEvents: number;
}

function base64(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64");
}

function readTextForExport(buf: Uint8Array, field: string): string {
  try {
    return decryptFromBytes(buf);
  } catch (err) {
    getEvent()?.addWarning(
      `symptom ${field} decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return UNREADABLE_EXPORT_MARKER;
  }
}

/**
 * Build the symptoms slice of a user's full backup. A disaster-recovery
 * payload carries every occurrence, the tombstones of deleted Apple Health
 * imports included, so a restored instance still answers a late re-post of
 * such a sample `duplicate`. A portable export carries only the live ones,
 * as it omits every other soft-deleted row. Otherwise the two purposes
 * differ only in how the free text travels.
 */
export async function buildSymptomsBackupSection(
  prisma: Pick<PrismaClient, "symptomDefinition">,
  userId: string,
  options: SymptomsBackupOptions = {},
): Promise<SymptomsBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";
  const rows = await prisma.symptomDefinition.findMany({
    where: { userId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    include: {
      events: {
        ...(disasterRecovery ? {} : { where: { deletedAt: null } }),
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      },
    },
  });

  return {
    symptomDefinitions: rows.map((row) => ({
      ...(disasterRecovery
        ? { id: row.id, labelEncrypted: base64(row.labelEncrypted) }
        : { label: readTextForExport(row.labelEncrypted, "label") }),
      icon: row.icon,
      sortOrder: row.sortOrder,
      isActive: row.isActive,
      code: row.code,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      events: row.events.map((event) => ({
        ...(disasterRecovery
          ? {
              id: event.id,
              deletedAt: event.deletedAt ? event.deletedAt.toISOString() : null,
              noteEncrypted: event.noteEncrypted
                ? base64(event.noteEncrypted)
                : null,
            }
          : {
              note: event.noteEncrypted
                ? readTextForExport(event.noteEncrypted, "note")
                : null,
            }),
        occurredAt: event.occurredAt.toISOString(),
        intensity: event.intensity,
        episodeId: event.episodeId,
        endAt: event.endAt ? event.endAt.toISOString() : null,
        source: event.source,
        externalId: event.externalId,
        createdAt: event.createdAt.toISOString(),
        updatedAt: event.updatedAt.toISOString(),
      })),
    })),
  };
}

export function countSymptomsBackupSection(
  section: SymptomsBackupSection,
): SymptomsBackupCounts {
  return {
    symptomDefinitions: section.symptomDefinitions.length,
    symptomEvents: section.symptomDefinitions.reduce(
      (sum, d) => sum + d.events.length,
      0,
    ),
  };
}

/** Counts the symptoms restore wiped, for the audit trail. */
export interface SymptomsRestoreCleared {
  symptomDefinitions: number;
}

/**
 * What the parser hands over, which is looser than what the builder writes:
 * an older file carries no key at all, and optional columns arrive as
 * `undefined` rather than `null`.
 */
export interface SymptomsRestoreInput {
  symptomDefinitions: Array<{
    id?: string | undefined;
    label?: string | undefined;
    labelEncrypted?: string | undefined;
    icon?: string | null | undefined;
    sortOrder: number;
    isActive: boolean;
    code?: string | null | undefined;
    createdAt: string;
    updatedAt: string;
    events: Array<{
      id?: string | undefined;
      occurredAt: string;
      intensity: number;
      note?: string | null | undefined;
      noteEncrypted?: string | null | undefined;
      episodeId?: string | null | undefined;
      endAt?: string | null | undefined;
      source?: string | undefined;
      externalId?: string | null | undefined;
      deletedAt?: string | null | undefined;
      createdAt: string;
      updatedAt: string;
    }>;
  }>;
}

function decodeBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(encoded, "base64");
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength));
  bytes.set(decoded);
  return bytes;
}

/**
 * Re-create the account's symptom definitions and their occurrences.
 *
 * Delete-then-recreate inside the caller's transaction, like every other
 * section; deleting a definition cascades its events. MUST run AFTER the
 * illness episodes are restored: `episodeIds` is the set the restore actually
 * wrote, passed in rather than re-queried so this stays a pure function of the
 * transaction it was handed.
 */
export async function restoreSymptomsData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: SymptomsRestoreInput,
  episodeIds: ReadonlySet<string>,
  skips: RestoreSkipLog,
): Promise<SymptomsRestoreCleared> {
  const cleared = await tx.symptomDefinition.deleteMany({
    where: { userId: ownerId },
  });

  const droppedEpisodeRefs: string[] = [];
  // A file can repeat what the unique indexes allow once: a built-in code
  // (`userId, code`) or an imported sample (`userId, source, externalId`), a
  // merged or hand-edited file most likely. One such row must not abort the
  // whole restore, so the first one keeps the code or the sample and the rest
  // are counted. A repeated code's definition still restores, as a symptom
  // the person named (code null), with its occurrences; a repeated sample is
  // the same occurrence again and is left out. A code this instance does not
  // know restores the same way, as a named symptom.
  const seenCodes = new Set<string>();
  const seenSamples = new Set<string>();
  const repeated: string[] = [];
  for (const definition of payload.symptomDefinitions) {
    let code = definition.code ?? null;
    if (code !== null && !isSymptomBuiltinCode(code)) code = null;
    if (code !== null) {
      if (seenCodes.has(code)) {
        repeated.push(`symptomDefinitions.code.${code}`);
        code = null;
      } else {
        seenCodes.add(code);
      }
    }
    const events = definition.events.filter((event) => {
      if (!event.externalId) return true;
      const key = `symptomEvents.${event.source ?? "MANUAL"}.${event.externalId}`;
      if (seenSamples.has(key)) {
        repeated.push(key);
        return false;
      }
      seenSamples.add(key);
      return true;
    });
    const labelEncrypted =
      definition.labelEncrypted !== undefined
        ? decodeBytes(definition.labelEncrypted)
        : encryptToBytes(definition.label ?? "");
    await tx.symptomDefinition.create({
      data: {
        ...(definition.id ? { id: definition.id } : {}),
        userId: ownerId,
        labelEncrypted,
        icon: definition.icon ?? null,
        sortOrder: definition.sortOrder,
        isActive: definition.isActive,
        code,
        createdAt: new Date(definition.createdAt),
        updatedAt: new Date(definition.updatedAt),
        events: {
          create: events.map((event) => {
            let episodeId = event.episodeId ?? null;
            if (episodeId && !episodeIds.has(episodeId)) {
              droppedEpisodeRefs.push(episodeId);
              episodeId = null;
            }
            return {
              ...(event.id ? { id: event.id } : {}),
              userId: ownerId,
              occurredAt: new Date(event.occurredAt),
              intensity: event.intensity,
              noteEncrypted:
                event.noteEncrypted !== undefined
                  ? event.noteEncrypted === null
                    ? null
                    : decodeBytes(event.noteEncrypted)
                  : event.note
                    ? encryptToBytes(event.note)
                    : null,
              episodeId,
              endAt: event.endAt ? new Date(event.endAt) : null,
              source: event.source ?? "MANUAL",
              externalId: event.externalId ?? null,
              deletedAt: event.deletedAt ? new Date(event.deletedAt) : null,
              createdAt: new Date(event.createdAt),
              updatedAt: new Date(event.updatedAt),
            };
          }),
        },
      },
    });
  }

  recordUnknownKeys(
    skips,
    "symptomEpisodeReference",
    [...new Set(droppedEpisodeRefs)],
    droppedEpisodeRefs,
  );
  recordUnknownKeys(
    skips,
    "symptomDuplicate",
    [...new Set(repeated)],
    repeated,
  );

  return { symptomDefinitions: cleared.count };
}
