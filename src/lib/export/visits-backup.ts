/**
 * Visits and the address book behind them, with both backup ends in one file.
 *
 * The builder and the restore live together deliberately, the way
 * `health-score-backup.ts` and `src/lib/cycle/backup.ts` do: a reader asking
 * "is this carried at both ends?" answers it here, and a reader who greps only
 * the restore ROUTE gets a false negative, because the route delegates.
 *
 * Five models ride: the practitioners, the encounters, and the three link
 * tables between an encounter and a document, a lab result or a condition
 * episode. All five are carried rather than owed. A neighbour on the debt
 * register already says what the alternative costs — the filing between
 * documents and conditions is lost — and a restore that returned visits and
 * documents with nothing between them would be the same loss one layer
 * deeper.
 *
 * Every read is scoped to the owner. Each model uses its own named select
 * constant and its own delegate call rather than riding a parent's `include`:
 * `documentLinks` is a relation field name on two different models, so a
 * relation-shaped write here would be attributed to whichever of them a
 * matcher happened to find first. Delegate calls cannot be confused that way.
 *
 * Two references can fail to resolve on a restore, and both are reported
 * rather than dropped in silence:
 *
 *   - `Encounter.reminderId` points at a `MeasurementReminder`, which restores
 *     in the same run (v1.37.20, #223 / iOS #68 — it was on the
 *     coverage-pending register before that and every reference was a known
 *     drop). It remaps against the restored reminders and resolves to NULL,
 *     never to a dangling id, only when the file genuinely lacks the reminder
 *     — a portable export omits tombstoned ones.
 *   - A link whose far side was not restored. A portable export carries no lab
 *     result ids, so a lab link in one cannot resolve; a disaster-recovery
 *     payload carries every id and they all do.
 */
import { Buffer } from "node:buffer";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type {
  EncounterKind,
  EncounterStatus,
  Laterality,
} from "@/generated/prisma/client";

import {
  recordUnknownKeys,
  type RestoreSkipLog,
} from "@/lib/export/restore-skips";

export interface VisitsBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

/** One entry in the account's own address book of doctors and practices. */
export interface PractitionerBackupEntry {
  /** Always carried: an encounter references a practitioner by id and nothing
   *  else about the row is unique enough to rebuild the reference from. */
  id: string;
  name: string;
  specialty: string | null;
  practice: string | null;
  location: string | null;
  phone: string | null;
  /** Base64 ciphertext, carried verbatim — never decrypted into the file. */
  noteEncrypted: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

/** One contact with the healthcare system: happened, or booked. */
export interface EncounterBackupEntry {
  /** Always carried, for the same reason as the practitioner id above: the
   *  three link tables address an encounter by it. */
  id: string;
  occurredAt: string;
  status: EncounterStatus;
  kind: EncounterKind;
  practitionerId: string | null;
  reasonEncrypted: string | null;
  outcomeEncrypted: string | null;
  /** The procedure's body site, ciphertext like the two above (v1.39.1). */
  bodySiteEncrypted: string | null;
  laterality: Laterality | null;
  /**
   * The appointment's reminder row, which restores in the same run since
   * v1.37.20. The restore remaps it against the restored reminders and drops
   * it to NULL, with the drop named, only when the file lacks the reminder.
   */
  reminderId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

/** One edge from a visit to something it produced. */
export interface EncounterLinkBackupEntry {
  encounterId: string;
  targetId: string;
  createdAt: string;
}

export interface VisitsBackupSection {
  practitioners: PractitionerBackupEntry[];
  encounters: EncounterBackupEntry[];
  encounterDocumentLinks: EncounterLinkBackupEntry[];
  encounterLabLinks: EncounterLinkBackupEntry[];
  encounterConditionLinks: EncounterLinkBackupEntry[];
}

export interface VisitsBackupCounts {
  practitioners: number;
  encounters: number;
  encounterLinks: number;
}

/** Base64 for a `Bytes` ciphertext column, or null when the column is empty. */
function encodeCiphertext(value: Uint8Array | null): string | null {
  if (!value || value.byteLength === 0) return null;
  return Buffer.from(value).toString("base64");
}

/**
 * Named select constants, one per model.
 *
 * Named rather than inline because a structural matcher binds a model to the
 * literal beside its delegate call, and an inline object inside a `Promise.all`
 * is a shape earlier work in this repository had to refactor away from for
 * exactly that reason.
 */
const PRACTITIONER_BACKUP_SELECT = {
  id: true,
  name: true,
  specialty: true,
  practice: true,
  location: true,
  phone: true,
  noteEncrypted: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

const ENCOUNTER_BACKUP_SELECT = {
  id: true,
  occurredAt: true,
  status: true,
  kind: true,
  practitionerId: true,
  reasonEncrypted: true,
  outcomeEncrypted: true,
  bodySiteEncrypted: true,
  laterality: true,
  reminderId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

const ENCOUNTER_DOCUMENT_LINK_BACKUP_SELECT = {
  encounterId: true,
  documentId: true,
  createdAt: true,
} as const;

const ENCOUNTER_LAB_LINK_BACKUP_SELECT = {
  encounterId: true,
  labResultId: true,
  createdAt: true,
} as const;

const ENCOUNTER_CONDITION_LINK_BACKUP_SELECT = {
  encounterId: true,
  episodeId: true,
  createdAt: true,
} as const;

/**
 * Build the visits slice of a user's full backup.
 *
 * Takes the delegates it uses rather than a whole client, matching the other
 * section builders. A portable export omits tombstones so a restore cannot
 * resurrect them; a disaster-recovery payload keeps them so the account comes
 * back as itself.
 */
export async function buildVisitsBackupSection(
  prisma: Pick<
    PrismaClient,
    | "practitioner"
    | "encounter"
    | "encounterDocumentLink"
    | "encounterLabLink"
    | "encounterConditionLink"
  >,
  userId: string,
  options: VisitsBackupOptions = {},
): Promise<VisitsBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";

  const [
    practitionerRows,
    encounterRows,
    documentLinkRows,
    labLinkRows,
    conditionLinkRows,
  ] = await Promise.all([
    prisma.practitioner.findMany({
      where: disasterRecovery ? { userId } : { userId, deletedAt: null },
      orderBy: { name: "asc" },
      select: PRACTITIONER_BACKUP_SELECT,
    }),
    prisma.encounter.findMany({
      where: disasterRecovery ? { userId } : { userId, deletedAt: null },
      orderBy: { occurredAt: "desc" },
      select: ENCOUNTER_BACKUP_SELECT,
    }),
    prisma.encounterDocumentLink.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: ENCOUNTER_DOCUMENT_LINK_BACKUP_SELECT,
    }),
    prisma.encounterLabLink.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: ENCOUNTER_LAB_LINK_BACKUP_SELECT,
    }),
    prisma.encounterConditionLink.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: ENCOUNTER_CONDITION_LINK_BACKUP_SELECT,
    }),
  ]);

  return {
    practitioners: practitionerRows.map((row) => ({
      id: row.id,
      name: row.name,
      specialty: row.specialty,
      practice: row.practice,
      location: row.location,
      phone: row.phone,
      noteEncrypted: encodeCiphertext(row.noteEncrypted),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ...(disasterRecovery
        ? { deletedAt: row.deletedAt?.toISOString() ?? null }
        : {}),
    })),
    encounters: encounterRows.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      status: row.status,
      kind: row.kind,
      practitionerId: row.practitionerId,
      reasonEncrypted: encodeCiphertext(row.reasonEncrypted),
      outcomeEncrypted: encodeCiphertext(row.outcomeEncrypted),
      bodySiteEncrypted: encodeCiphertext(row.bodySiteEncrypted),
      laterality: row.laterality,
      reminderId: row.reminderId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ...(disasterRecovery
        ? { deletedAt: row.deletedAt?.toISOString() ?? null }
        : {}),
    })),
    encounterDocumentLinks: documentLinkRows.map((row) => ({
      encounterId: row.encounterId,
      targetId: row.documentId,
      createdAt: row.createdAt.toISOString(),
    })),
    encounterLabLinks: labLinkRows.map((row) => ({
      encounterId: row.encounterId,
      targetId: row.labResultId,
      createdAt: row.createdAt.toISOString(),
    })),
    encounterConditionLinks: conditionLinkRows.map((row) => ({
      encounterId: row.encounterId,
      targetId: row.episodeId,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/** Row counts for the audit trail, mirroring the other section counters. */
export function countVisitsBackupSection(
  section: VisitsBackupSection,
): VisitsBackupCounts {
  return {
    practitioners: section.practitioners.length,
    encounters: section.encounters.length,
    encounterLinks:
      section.encounterDocumentLinks.length +
      section.encounterLabLinks.length +
      section.encounterConditionLinks.length,
  };
}

/** Counts the visit restore wiped, for the audit trail. */
export interface VisitsRestoreCleared {
  practitioners: number;
  encounters: number;
  encounterLinks: number;
}

/**
 * The slice of a parsed backup this restore consumes.
 *
 * Required rather than optional: the payload schema defaults every key, so
 * every caller already satisfies this, and one that stops satisfying it fails
 * to compile instead of passing `undefined` into a loop that iterates zero
 * times and reports success.
 */
export interface VisitsRestoreInput {
  practitioners: RestoredPractitioner[];
  encounters: RestoredEncounter[];
  encounterDocumentLinks: EncounterLinkBackupEntry[];
  encounterLabLinks: EncounterLinkBackupEntry[];
  encounterConditionLinks: EncounterLinkBackupEntry[];
}

/**
 * What the restore reads, as the parsed file actually presents it.
 *
 * The builder's entry types above describe what this release WRITES. These
 * describe what a restore may be handed, which is a wider set: a portable
 * export omits the tombstone, and every optional column in the payload schema
 * arrives as `undefined` rather than `null`. Modelling the read side as the
 * write side would compile only because the two happen to agree today, and
 * would break the first time an older file reached it.
 */
type OptionalNullable<T> = { [K in keyof T]?: T[K] | undefined };

export type RestoredPractitioner = Pick<
  PractitionerBackupEntry,
  "id" | "name" | "createdAt" | "updatedAt"
> &
  OptionalNullable<
    Pick<
      PractitionerBackupEntry,
      "specialty" | "practice" | "location" | "phone" | "noteEncrypted"
    >
  > & { deletedAt?: string | null };

export type RestoredEncounter = Pick<
  EncounterBackupEntry,
  "id" | "occurredAt" | "status" | "kind" | "createdAt" | "updatedAt"
> &
  OptionalNullable<
    Pick<
      EncounterBackupEntry,
      | "practitionerId"
      | "reasonEncrypted"
      | "outcomeEncrypted"
      | "bodySiteEncrypted"
      | "laterality"
      | "reminderId"
    >
  > & { deletedAt?: string | null };

function decodeCiphertext(encoded: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(encoded, "base64");
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength));
  bytes.set(decoded);
  return bytes;
}

/**
 * Re-create the account's visits, address book and link rows.
 *
 * Delete-then-recreate inside the caller's transaction, matching every other
 * section. Parents first — practitioners, then encounters, then the links —
 * because a link addresses both of its ends by id.
 *
 * MUST be called after the documents, lab results, condition episodes AND the
 * measurement reminders have been restored: a link is written only when both
 * of its ends exist, the encounter's `reminderId` remaps against the restored
 * reminders, and the existence check is what decides. Calling it earlier would
 * report every one of those references as unresolvable and be counted as a
 * successful restore of a thinner record.
 */
export async function restoreVisitsData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: VisitsRestoreInput,
  skips: RestoreSkipLog,
): Promise<VisitsRestoreCleared> {
  const clearedLinks =
    (await tx.encounterDocumentLink.deleteMany({ where: { userId: ownerId } }))
      .count +
    (await tx.encounterLabLink.deleteMany({ where: { userId: ownerId } }))
      .count +
    (await tx.encounterConditionLink.deleteMany({ where: { userId: ownerId } }))
      .count;
  const clearedEncounters = await tx.encounter.deleteMany({
    where: { userId: ownerId },
  });
  const clearedPractitioners = await tx.practitioner.deleteMany({
    where: { userId: ownerId },
  });

  if (payload.practitioners.length > 0) {
    await tx.practitioner.createMany({
      data: payload.practitioners.map((entry) => ({
        id: entry.id,
        userId: ownerId,
        name: entry.name,
        specialty: entry.specialty ?? null,
        practice: entry.practice ?? null,
        location: entry.location ?? null,
        phone: entry.phone ?? null,
        noteEncrypted:
          entry.noteEncrypted == null
            ? null
            : decodeCiphertext(entry.noteEncrypted),
        createdAt: new Date(entry.createdAt),
        updatedAt: new Date(entry.updatedAt),
        deletedAt: entry.deletedAt ? new Date(entry.deletedAt) : null,
      })),
    });
  }

  // A practitioner the file references but does not carry cannot be invented,
  // and a dangling id would fail the foreign key and roll the whole restore
  // back over one visit. The reference is dropped to NULL instead — the visit
  // itself, its date, its reason and its outcome all survive.
  const restoredPractitioners = new Set(
    payload.practitioners.map((entry) => entry.id),
  );
  const droppedPractitioners: string[] = [];

  // The reminders are restored by another branch of the same transaction
  // (v1.37.20 — they used to be on the coverage-pending register, when every
  // reference was a known drop), so the check is against the database rather
  // than against the payload. A reference the file genuinely lacks — a
  // portable export omits tombstoned reminders — still drops to NULL and is
  // still reported.
  const reminderRows = await tx.measurementReminder.findMany({
    where: { userId: ownerId },
    select: { id: true },
  });
  const restoredReminders = new Set(reminderRows.map((row) => row.id));
  const droppedReminders: string[] = [];

  if (payload.encounters.length > 0) {
    await tx.encounter.createMany({
      data: payload.encounters.map((entry) => {
        const practitionerId =
          entry.practitionerId &&
          restoredPractitioners.has(entry.practitionerId)
            ? entry.practitionerId
            : null;
        if (entry.practitionerId && practitionerId === null) {
          droppedPractitioners.push(entry.practitionerId);
        }
        const reminderId =
          entry.reminderId && restoredReminders.has(entry.reminderId)
            ? entry.reminderId
            : null;
        if (entry.reminderId && reminderId === null) {
          droppedReminders.push(entry.reminderId);
        }
        return {
          id: entry.id,
          userId: ownerId,
          occurredAt: new Date(entry.occurredAt),
          status: entry.status,
          kind: entry.kind,
          practitionerId,
          reasonEncrypted:
            entry.reasonEncrypted == null
              ? null
              : decodeCiphertext(entry.reasonEncrypted),
          outcomeEncrypted:
            entry.outcomeEncrypted == null
              ? null
              : decodeCiphertext(entry.outcomeEncrypted),
          // Absent in a file written before v1.39.1: the visit comes back
          // with no site, which is what it had.
          bodySiteEncrypted:
            entry.bodySiteEncrypted == null
              ? null
              : decodeCiphertext(entry.bodySiteEncrypted),
          laterality: entry.laterality ?? null,
          reminderId,
          createdAt: new Date(entry.createdAt),
          updatedAt: new Date(entry.updatedAt),
          deletedAt: entry.deletedAt ? new Date(entry.deletedAt) : null,
        };
      }),
    });
  }

  recordUnknownKeys(
    skips,
    "visitReference",
    [...new Set(droppedPractitioners)],
    droppedPractitioners,
  );
  recordUnknownKeys(
    skips,
    "visitReference",
    [...new Set(droppedReminders)],
    droppedReminders,
  );

  const restoredEncounters = new Set(payload.encounters.map((e) => e.id));

  /**
   * Write the links whose far side actually came back, and name the rest.
   *
   * The far side is checked against the database rather than against the
   * payload, because the document, the lab result and the episode are restored
   * by other branches in the same transaction and this is the only place that
   * can see all three.
   */
  async function restoreLinks(
    entries: EncounterLinkBackupEntry[],
    existingTargetIds: Set<string>,
    write: (
      rows: Array<{
        encounterId: string;
        targetId: string;
        createdAt: Date;
      }>,
    ) => Promise<void>,
  ): Promise<void> {
    const writable: Array<{
      encounterId: string;
      targetId: string;
      createdAt: Date;
    }> = [];
    const dropped: string[] = [];
    for (const entry of entries) {
      if (
        restoredEncounters.has(entry.encounterId) &&
        existingTargetIds.has(entry.targetId)
      ) {
        writable.push({
          encounterId: entry.encounterId,
          targetId: entry.targetId,
          createdAt: new Date(entry.createdAt),
        });
      } else {
        dropped.push(entry.targetId);
      }
    }
    if (writable.length > 0) await write(writable);
    recordUnknownKeys(skips, "visitReference", [...new Set(dropped)], dropped);
  }

  const [documentIds, labResultIds, episodeIds] = await Promise.all([
    tx.inboundDocument.findMany({
      where: { userId: ownerId },
      select: { id: true },
    }),
    tx.labResult.findMany({
      where: { userId: ownerId },
      select: { id: true },
    }),
    tx.illnessEpisode.findMany({
      where: { userId: ownerId },
      select: { id: true },
    }),
  ]);

  await restoreLinks(
    payload.encounterDocumentLinks,
    new Set(documentIds.map((row) => row.id)),
    async (rows) => {
      await tx.encounterDocumentLink.createMany({
        data: rows.map((row) => ({
          userId: ownerId,
          encounterId: row.encounterId,
          documentId: row.targetId,
          createdAt: row.createdAt,
        })),
      });
    },
  );

  await restoreLinks(
    payload.encounterLabLinks,
    new Set(labResultIds.map((row) => row.id)),
    async (rows) => {
      await tx.encounterLabLink.createMany({
        data: rows.map((row) => ({
          userId: ownerId,
          encounterId: row.encounterId,
          labResultId: row.targetId,
          createdAt: row.createdAt,
        })),
      });
    },
  );

  await restoreLinks(
    payload.encounterConditionLinks,
    new Set(episodeIds.map((row) => row.id)),
    async (rows) => {
      await tx.encounterConditionLink.createMany({
        data: rows.map((row) => ({
          userId: ownerId,
          encounterId: row.encounterId,
          episodeId: row.targetId,
          createdAt: row.createdAt,
        })),
      });
    },
  );

  return {
    practitioners: clearedPractitioners.count,
    encounters: clearedEncounters.count,
    encounterLinks: clearedLinks,
  };
}
