/**
 * Life events (v1.42, #613), with both backup ends in one file.
 *
 * Same arrangement as `symptoms-backup.ts`: a reader asking "is this carried
 * at both ends?" answers it here, and a reader who greps only the restore
 * route gets a false negative because the route delegates.
 *
 * ## Free text follows the note contract
 *
 * A disaster-recovery payload carries the title and note ciphertext verbatim
 * as base64, which the same instance's key reads back unchanged, and keeps
 * the soft-deleted rows with their tombstones so an undo window survives the
 * round trip. A portable export decrypts both, because a portable file exists
 * to be readable by the person who owns it and to restore under another
 * instance's key, and leaves the deleted rows out. A title this instance
 * cannot decrypt travels as the visible unreadable marker rather than as
 * nothing, the rule `records-backup.ts` states for notes.
 *
 * Nothing references a life event and a life event references nothing but
 * its owner, so the section restores in any order against the others.
 */
import { Buffer } from "node:buffer";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type {
  LifeEventCategory,
  LifeEventPrecision,
} from "@/generated/prisma/client";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { getEvent } from "@/lib/logging/context";

import { UNREADABLE_EXPORT_MARKER } from "./unreadable-marker";

export interface LifeEventsBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

/** One life event as the backup carries it. */
export interface LifeEventBackupEntry {
  /** Present in a disaster-recovery payload. */
  id?: string;
  category: LifeEventCategory;
  startDate: string;
  endDate: string | null;
  precision: LifeEventPrecision;
  /** Plaintext; present on a portable payload. */
  title?: string;
  /** Ciphertext as base64; present on a disaster-recovery payload. */
  titleEncrypted?: string;
  /** Plaintext; present on a portable payload. */
  note?: string | null;
  /** Ciphertext as base64; present on a disaster-recovery payload. */
  noteEncrypted?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present on a disaster-recovery payload. */
  deletedAt?: string | null;
}

export interface LifeEventsBackupSection {
  lifeEvents: LifeEventBackupEntry[];
}

export interface LifeEventsBackupCounts {
  lifeEvents: number;
}

function base64(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64");
}

function readTextForExport(buf: Uint8Array, field: string): string {
  try {
    return decryptFromBytes(buf);
  } catch (err) {
    getEvent()?.addWarning(
      `life event ${field} decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return UNREADABLE_EXPORT_MARKER;
  }
}

/** Build the life-event slice of a user's full backup. */
export async function buildLifeEventsBackupSection(
  prisma: Pick<PrismaClient, "lifeEvent">,
  userId: string,
  options: LifeEventsBackupOptions = {},
): Promise<LifeEventsBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";
  const rows = await prisma.lifeEvent.findMany({
    where: disasterRecovery ? { userId } : { userId, deletedAt: null },
    orderBy: [{ startDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });

  return {
    lifeEvents: rows.map((row) => ({
      ...(disasterRecovery
        ? {
            id: row.id,
            titleEncrypted: base64(row.titleEncrypted),
            noteEncrypted: row.noteEncrypted ? base64(row.noteEncrypted) : null,
          }
        : {
            title: readTextForExport(row.titleEncrypted, "title"),
            note: row.noteEncrypted
              ? readTextForExport(row.noteEncrypted, "note")
              : null,
          }),
      category: row.category,
      startDate: row.startDate,
      endDate: row.endDate,
      precision: row.precision,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ...(disasterRecovery
        ? { deletedAt: row.deletedAt?.toISOString() ?? null }
        : {}),
    })),
  };
}

export function countLifeEventsBackupSection(
  section: LifeEventsBackupSection,
): LifeEventsBackupCounts {
  return { lifeEvents: section.lifeEvents.length };
}

/** Counts the life-event restore wiped, for the audit trail. */
export interface LifeEventsRestoreCleared {
  lifeEvents: number;
}

/**
 * What the parser hands over, which is looser than what the builder writes:
 * a file from before v1.42 carries no key at all, and optional columns arrive
 * as `undefined` rather than `null`.
 */
export interface LifeEventsRestoreInput {
  lifeEvents: Array<{
    id?: string | undefined;
    category: LifeEventCategory;
    startDate: string;
    endDate?: string | null | undefined;
    precision: LifeEventPrecision;
    title?: string | undefined;
    titleEncrypted?: string | undefined;
    note?: string | null | undefined;
    noteEncrypted?: string | null | undefined;
    createdAt: string;
    updatedAt: string;
    deletedAt?: string | null | undefined;
  }>;
}

function decodeBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(encoded, "base64");
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength));
  bytes.set(decoded);
  return bytes;
}

/**
 * Re-create the account's life events. Delete-then-recreate inside the
 * caller's transaction, like every other section.
 */
export async function restoreLifeEventsData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: LifeEventsRestoreInput,
): Promise<LifeEventsRestoreCleared> {
  const cleared = await tx.lifeEvent.deleteMany({ where: { userId: ownerId } });

  if (payload.lifeEvents.length > 0) {
    await tx.lifeEvent.createMany({
      data: payload.lifeEvents.map((event) => ({
        ...(event.id ? { id: event.id } : {}),
        userId: ownerId,
        category: event.category,
        startDate: event.startDate,
        endDate: event.endDate ?? null,
        precision: event.precision,
        titleEncrypted:
          event.titleEncrypted !== undefined
            ? decodeBytes(event.titleEncrypted)
            : encryptToBytes(event.title ?? ""),
        noteEncrypted:
          event.noteEncrypted !== undefined
            ? event.noteEncrypted === null
              ? null
              : decodeBytes(event.noteEncrypted)
            : event.note
              ? encryptToBytes(event.note)
              : null,
        createdAt: new Date(event.createdAt),
        updatedAt: new Date(event.updatedAt),
        deletedAt: event.deletedAt ? new Date(event.deletedAt) : null,
      })),
    });
  }

  return { lifeEvents: cleared.count };
}
