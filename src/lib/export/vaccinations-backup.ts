/**
 * The immunization log, with both backup ends in one file.
 *
 * Same arrangement as `visits-backup.ts` and for the same reason: a reader
 * asking "is this carried at both ways?" answers it here, and a reader who
 * greps only the restore ROUTE gets a false negative because the route
 * delegates.
 *
 * Three models ride: the dose, the link that keeps the scanned Impfpass page
 * beside it, and since v1.42 (#1005) the person's own vaccine definitions a
 * dose may name. Both are carried rather than owed. `DocumentConditionLink` on the
 * debt register says what the alternative costs — documents and conditions
 * both restore, the filing between them does not — and an immunization history
 * is the record with the least chance of being reconstructed from anywhere
 * else, so the same regret is not repeated here.
 *
 * Each model uses its own named select constant and its own delegate call
 * rather than riding a parent's `include`: `documentLinks` is a relation field
 * name on three different models now, so a relation-shaped write would be
 * attributed to whichever of them a matcher happened to find first.
 *
 * Three references need care on the way back:
 *
 *   - `practitionerId` and `encounterId` point at models that restore in the
 *     same run. They remap to the restored rows, and drop to NULL when the
 *     file references a row it does not carry.
 *   - `reminderId` points at a `MeasurementReminder`, which also restores in
 *     the same run (v1.37.20, #223 / iOS #68 — it was on the coverage-pending
 *     register before that and every reference was a known drop). It remaps
 *     the same way, and resolves to NULL, with the drop reported, only when
 *     the file genuinely lacks the reminder — a portable export omits
 *     tombstoned ones.
 *   - `customVaccineId` points at a definition restored by this same section
 *     first. It drops to NULL, with the drop named, when the file lacks the
 *     definition; the dose then keeps its own `vaccineName`.
 *   - `antigenSlug` is restored verbatim with no validation against the
 *     current catalogue. A slug this release no longer resolves must still
 *     come back; the renderer degrades to the free-text arm, which is the
 *     guarantee `src/lib/vaccinations/__tests__/catalog-integrity.test.ts`
 *     holds.
 */
import {
  encodeSealedBytes,
  openSealedBytesForExport,
  sealBytesForRestore,
} from "@/lib/export/sealed-text";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { VaccinationSite } from "@/generated/prisma/client";

import {
  recordUnknownKeys,
  type RestoreSkipLog,
} from "@/lib/export/restore-skips";

export interface VaccinationsBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

/** One administered dose, as the Pass recorded it. */
export interface VaccinationBackupEntry {
  /** Always carried: the document link addresses a dose by it. */
  id: string;
  occurredAt: string;
  /**
   * Carried verbatim, never checked against the catalogue this release ships.
   * A slug that stopped resolving still describes what the person was given.
   */
  antigenSlug: string | null;
  vaccineName: string | null;
  doseNumber: number | null;
  seriesDoses: number | null;
  lotNumber: string | null;
  site: VaccinationSite | null;
  practitionerId: string | null;
  encounterId: string | null;
  /**
   * The booster reminder this dose recorded satisfying, which restores in the
   * same run since v1.37.20. The restore remaps it against the restored
   * reminders and drops it to NULL, with the drop named, only when the file
   * lacks the reminder.
   */
  reminderId: string | null;
  /** The person's own definition the dose names (v1.42, #1005). */
  customVaccineId: string | null;
  /** Base64 ciphertext; disaster-recovery payloads only. */
  noteEncrypted?: string | null;
  /** The note readable; portable payloads only. */
  note?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

/**
 * One of the person's own vaccine definitions (v1.42, #1005). `components`
 * travels verbatim, never checked against the antigen list this release
 * ships, for the same reason a dose's `antigenSlug` does.
 */
export interface CustomVaccineBackupEntry {
  id: string;
  name: string;
  components: string[];
  typicalSeriesDoses: number | null;
  boosterIntervalMonths: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

/** One edge from a dose to the page it was transcribed from. */
export interface VaccinationDocumentLinkBackupEntry {
  vaccinationId: string;
  targetId: string;
  createdAt: string;
}

export interface VaccinationsBackupSection {
  customVaccines: CustomVaccineBackupEntry[];
  vaccinations: VaccinationBackupEntry[];
  vaccinationDocumentLinks: VaccinationDocumentLinkBackupEntry[];
}

export interface VaccinationsBackupCounts {
  customVaccines: number;
  vaccinations: number;
  vaccinationLinks: number;
}

/**
 * Named select constants, one per model — a structural matcher binds a model
 * to the literal beside its delegate call, and an inline object inside a
 * `Promise.all` is the shape earlier work here had to refactor away from.
 */
const VACCINATION_BACKUP_SELECT = {
  id: true,
  occurredAt: true,
  antigenSlug: true,
  vaccineName: true,
  doseNumber: true,
  seriesDoses: true,
  lotNumber: true,
  site: true,
  practitionerId: true,
  encounterId: true,
  reminderId: true,
  customVaccineId: true,
  noteEncrypted: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

const CUSTOM_VACCINE_BACKUP_SELECT = {
  id: true,
  name: true,
  components: true,
  typicalSeriesDoses: true,
  boosterIntervalMonths: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

const VACCINATION_DOCUMENT_LINK_BACKUP_SELECT = {
  vaccinationId: true,
  documentId: true,
  createdAt: true,
} as const;

/**
 * Build the immunization slice of a user's full backup.
 *
 * Takes the delegates it uses rather than a whole client, matching the other
 * section builders. A portable export omits tombstones so a restore cannot
 * resurrect them; a disaster-recovery payload keeps them so the account comes
 * back as itself.
 */
export async function buildVaccinationsBackupSection(
  prisma: Pick<
    PrismaClient,
    "vaccinationRecord" | "vaccinationDocumentLink" | "customVaccine"
  >,
  userId: string,
  options: VaccinationsBackupOptions = {},
): Promise<VaccinationsBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";

  const [customVaccineRows, vaccinationRows, documentLinkRows] =
    await Promise.all([
      prisma.customVaccine.findMany({
        where: disasterRecovery ? { userId } : { userId, deletedAt: null },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: CUSTOM_VACCINE_BACKUP_SELECT,
      }),
      prisma.vaccinationRecord.findMany({
        where: disasterRecovery ? { userId } : { userId, deletedAt: null },
        orderBy: { occurredAt: "desc" },
        select: VACCINATION_BACKUP_SELECT,
      }),
      prisma.vaccinationDocumentLink.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: VACCINATION_DOCUMENT_LINK_BACKUP_SELECT,
      }),
    ]);

  return {
    customVaccines: customVaccineRows.map((row) => ({
      id: row.id,
      name: row.name,
      components: [...row.components],
      typicalSeriesDoses: row.typicalSeriesDoses,
      boosterIntervalMonths: row.boosterIntervalMonths,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ...(disasterRecovery
        ? { deletedAt: row.deletedAt?.toISOString() ?? null }
        : {}),
    })),
    vaccinations: vaccinationRows.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      antigenSlug: row.antigenSlug,
      vaccineName: row.vaccineName,
      doseNumber: row.doseNumber,
      seriesDoses: row.seriesDoses,
      lotNumber: row.lotNumber,
      site: row.site,
      practitionerId: row.practitionerId,
      encounterId: row.encounterId,
      reminderId: row.reminderId,
      customVaccineId: row.customVaccineId,
      ...(disasterRecovery
        ? { noteEncrypted: encodeSealedBytes(row.noteEncrypted) }
        : {
            note: openSealedBytesForExport(
              row.noteEncrypted,
              "vaccination note",
            ),
          }),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ...(disasterRecovery
        ? { deletedAt: row.deletedAt?.toISOString() ?? null }
        : {}),
    })),
    vaccinationDocumentLinks: documentLinkRows.map((row) => ({
      vaccinationId: row.vaccinationId,
      targetId: row.documentId,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/** Row counts for the audit trail, mirroring the other section counters. */
export function countVaccinationsBackupSection(
  section: VaccinationsBackupSection,
): VaccinationsBackupCounts {
  return {
    customVaccines: section.customVaccines.length,
    vaccinations: section.vaccinations.length,
    vaccinationLinks: section.vaccinationDocumentLinks.length,
  };
}

/** Counts the immunization restore wiped, for the audit trail. */
export interface VaccinationsRestoreCleared {
  customVaccines: number;
  vaccinations: number;
  vaccinationLinks: number;
}

/**
 * The slice of a parsed backup this restore consumes.
 *
 * Required rather than optional: the payload schema defaults every key, so
 * every caller already satisfies this, and one that stops satisfying it fails
 * to compile instead of passing `undefined` into a loop that iterates zero
 * times and reports success.
 */
export interface VaccinationsRestoreInput {
  customVaccines: RestoredCustomVaccine[];
  vaccinations: RestoredVaccination[];
  vaccinationDocumentLinks: VaccinationDocumentLinkBackupEntry[];
}

/** A definition as the parsed file presents it. */
export type RestoredCustomVaccine = Pick<
  CustomVaccineBackupEntry,
  "id" | "name" | "createdAt" | "updatedAt"
> & {
  components?: string[] | undefined;
  typicalSeriesDoses?: number | null | undefined;
  boosterIntervalMonths?: number | null | undefined;
  deletedAt?: string | null | undefined;
};

/**
 * What the restore reads, as the parsed file actually presents it — a wider
 * set than what this release writes: a portable export omits the tombstone,
 * and every optional column arrives as `undefined` rather than `null`.
 */
type OptionalNullable<T> = { [K in keyof T]?: T[K] | undefined };

export type RestoredVaccination = Pick<
  VaccinationBackupEntry,
  "id" | "occurredAt" | "createdAt" | "updatedAt"
> &
  OptionalNullable<
    Pick<
      VaccinationBackupEntry,
      | "antigenSlug"
      | "vaccineName"
      | "doseNumber"
      | "seriesDoses"
      | "lotNumber"
      | "site"
      | "practitionerId"
      | "encounterId"
      | "reminderId"
      | "customVaccineId"
      | "noteEncrypted"
      | "note"
    >
  > & { deletedAt?: string | null };

/**
 * Re-create the account's immunization log and its document links.
 *
 * Delete-then-recreate inside the caller's transaction, matching every other
 * section. The dose first, then the link, because a link addresses both of its
 * ends by id.
 *
 * MUST be called after the practitioners, encounters, documents and
 * measurement reminders have been restored: the dose remaps three of those
 * references against the database and the link is written only when the
 * document actually came back. Calling it earlier would drop every reference
 * and be counted as a successful restore of a thinner record.
 */
export async function restoreVaccinationsData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: VaccinationsRestoreInput,
  skips: RestoreSkipLog,
): Promise<VaccinationsRestoreCleared> {
  const clearedLinks = await tx.vaccinationDocumentLink.deleteMany({
    where: { userId: ownerId },
  });
  const clearedVaccinations = await tx.vaccinationRecord.deleteMany({
    where: { userId: ownerId },
  });
  // After the doses that point at them, so neither count reads short.
  const clearedCustomVaccines = await tx.customVaccine.deleteMany({
    where: { userId: ownerId },
  });

  // The definitions first: a dose addresses one by id.
  if (payload.customVaccines.length > 0) {
    await tx.customVaccine.createMany({
      data: payload.customVaccines.map((entry) => ({
        id: entry.id,
        userId: ownerId,
        name: entry.name,
        // Verbatim, like a dose's slug: an antigen this release does not know
        // still says what the person meant, and the resolver skips it.
        components: entry.components ?? [],
        typicalSeriesDoses: entry.typicalSeriesDoses ?? null,
        boosterIntervalMonths: entry.boosterIntervalMonths ?? null,
        createdAt: new Date(entry.createdAt),
        updatedAt: new Date(entry.updatedAt),
        deletedAt: entry.deletedAt ? new Date(entry.deletedAt) : null,
      })),
    });
  }
  const restoredCustomVaccines = new Set(
    payload.customVaccines.map((entry) => entry.id),
  );

  // All three far sides are restored by other branches of the same
  // transaction, so the check is against the database rather than against the
  // payload — this is the only place that can see every section at once.
  const [practitionerIds, encounterIds, reminderIds] = await Promise.all([
    tx.practitioner.findMany({
      where: { userId: ownerId },
      select: { id: true },
    }),
    tx.encounter.findMany({
      where: { userId: ownerId },
      select: { id: true },
    }),
    tx.measurementReminder.findMany({
      where: { userId: ownerId },
      select: { id: true },
    }),
  ]);
  const restoredPractitioners = new Set(practitionerIds.map((row) => row.id));
  const restoredEncounters = new Set(encounterIds.map((row) => row.id));
  const restoredReminders = new Set(reminderIds.map((row) => row.id));

  // A row the file references but the restore did not bring back cannot be
  // invented, and a dangling id would fail the foreign key and roll the whole
  // restore back over one dose. The reference drops to NULL instead — the
  // dose, its date, its antigen and its batch code all survive. That includes
  // the reminder since v1.37.20: it restores in the same run, so a drop here
  // now means the file genuinely lacked it (a portable export omits
  // tombstoned reminders), not that reminders never travel.
  const droppedPractitioners: string[] = [];
  const droppedEncounters: string[] = [];
  const droppedReminders: string[] = [];
  const droppedCustomVaccines: string[] = [];
  // Sealed notes this host's keys do not open, by file path.
  const unopened: string[] = [];

  if (payload.vaccinations.length > 0) {
    await tx.vaccinationRecord.createMany({
      data: payload.vaccinations.map((entry) => {
        const practitionerId =
          entry.practitionerId &&
          restoredPractitioners.has(entry.practitionerId)
            ? entry.practitionerId
            : null;
        if (entry.practitionerId && practitionerId === null) {
          droppedPractitioners.push(entry.practitionerId);
        }
        const encounterId =
          entry.encounterId && restoredEncounters.has(entry.encounterId)
            ? entry.encounterId
            : null;
        if (entry.encounterId && encounterId === null) {
          droppedEncounters.push(entry.encounterId);
        }
        const reminderId =
          entry.reminderId && restoredReminders.has(entry.reminderId)
            ? entry.reminderId
            : null;
        if (entry.reminderId && reminderId === null) {
          droppedReminders.push(entry.reminderId);
        }
        const customVaccineId =
          entry.customVaccineId &&
          restoredCustomVaccines.has(entry.customVaccineId)
            ? entry.customVaccineId
            : null;
        if (entry.customVaccineId && customVaccineId === null) {
          droppedCustomVaccines.push(entry.customVaccineId);
        }
        return {
          id: entry.id,
          userId: ownerId,
          occurredAt: new Date(entry.occurredAt),
          // Verbatim, deliberately: a slug the current catalogue no longer
          // resolves still describes what was given, and the renderer falls
          // back to `vaccineName`.
          antigenSlug: entry.antigenSlug ?? null,
          vaccineName: entry.vaccineName ?? null,
          doseNumber: entry.doseNumber ?? null,
          seriesDoses: entry.seriesDoses ?? null,
          lotNumber: entry.lotNumber ?? null,
          site: entry.site ?? null,
          practitionerId,
          encounterId,
          reminderId,
          customVaccineId,
          noteEncrypted: sealBytesForRestore(
            entry.noteEncrypted,
            entry.note,
            `vaccinations.${entry.id}.noteEncrypted`,
            unopened,
          ),
          createdAt: new Date(entry.createdAt),
          updatedAt: new Date(entry.updatedAt),
          deletedAt: entry.deletedAt ? new Date(entry.deletedAt) : null,
        };
      }),
    });
  }

  recordUnknownKeys(
    skips,
    "vaccinationReference",
    [...new Set(droppedPractitioners)],
    droppedPractitioners,
  );
  recordUnknownKeys(
    skips,
    "vaccinationReference",
    [...new Set(droppedEncounters)],
    droppedEncounters,
  );
  recordUnknownKeys(
    skips,
    "vaccinationReference",
    [...new Set(droppedReminders)],
    droppedReminders,
  );
  recordUnknownKeys(
    skips,
    "vaccinationReference",
    [...new Set(droppedCustomVaccines)],
    droppedCustomVaccines,
  );
  recordUnknownKeys(skips, "vaccinationCiphertext", unopened, unopened);

  const restoredVaccinations = new Set(
    payload.vaccinations.map((entry) => entry.id),
  );
  const documentIds = await tx.inboundDocument.findMany({
    where: { userId: ownerId },
    select: { id: true },
  });
  const restoredDocuments = new Set(documentIds.map((row) => row.id));

  const writableLinks: Array<{
    vaccinationId: string;
    documentId: string;
    createdAt: Date;
  }> = [];
  const droppedLinks: string[] = [];
  for (const entry of payload.vaccinationDocumentLinks) {
    if (
      restoredVaccinations.has(entry.vaccinationId) &&
      restoredDocuments.has(entry.targetId)
    ) {
      writableLinks.push({
        vaccinationId: entry.vaccinationId,
        documentId: entry.targetId,
        createdAt: new Date(entry.createdAt),
      });
    } else {
      droppedLinks.push(entry.targetId);
    }
  }
  if (writableLinks.length > 0) {
    await tx.vaccinationDocumentLink.createMany({
      data: writableLinks.map((row) => ({
        userId: ownerId,
        vaccinationId: row.vaccinationId,
        documentId: row.documentId,
        createdAt: row.createdAt,
      })),
    });
  }
  recordUnknownKeys(
    skips,
    "vaccinationReference",
    [...new Set(droppedLinks)],
    droppedLinks,
  );

  return {
    customVaccines: clearedCustomVaccines.count,
    vaccinations: clearedVaccinations.count,
    vaccinationLinks: clearedLinks.count,
  };
}
