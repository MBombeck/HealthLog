/**
 * Treatment series in the backup, both ends in one file.
 *
 * They ride the visits section (`visits-backup.ts` calls in here) and restore
 * between the address book and the visits: a series names two practitioners
 * and a condition, and a visit names its series. A reference the file does not
 * carry drops to NULL and is named in the skip report, never left dangling.
 */
import type { EncounterKind, Prisma } from "@/generated/prisma/client";

import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  encodeSealedBytes,
  openSealedBytesForExport,
  sealBytesForRestore,
} from "@/lib/export/sealed-text";
import {
  recordUnknownKeys,
  type RestoreSkipLog,
} from "@/lib/export/restore-skips";
import { dayToDate } from "@/lib/treatment-series/service";
import { dateOnlyKey } from "@/lib/tz/date-only";

/** A course of several visits. */
export interface TreatmentSeriesBackupEntry {
  /** Always carried: the sessions address it by id. */
  id: string;
  kind: EncounterKind;
  plannedSessions: number | null;
  /** `YYYY-MM-DD`. */
  startsOn: string;
  validUntil: string | null;
  endedOn: string | null;
  prescriberId: string | null;
  performerId: string | null;
  episodeId: string | null;
  /** Base64 ciphertext; disaster-recovery payloads only. */
  titleEncrypted?: string | null;
  noteEncrypted?: string | null;
  /** The readable title and note; portable payloads only. */
  title?: string | null;
  note?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

type OptionalNullable<T> = { [K in keyof T]?: T[K] | undefined };

/** What a restore may be handed: older files and portable ones omit keys. */
export type RestoredTreatmentSeries = Pick<
  TreatmentSeriesBackupEntry,
  "id" | "kind" | "startsOn" | "createdAt" | "updatedAt"
> &
  OptionalNullable<
    Pick<
      TreatmentSeriesBackupEntry,
      | "plannedSessions"
      | "validUntil"
      | "endedOn"
      | "prescriberId"
      | "performerId"
      | "episodeId"
      | "titleEncrypted"
      | "noteEncrypted"
      | "title"
      | "note"
    >
  > & { deletedAt?: string | null };

export const TREATMENT_SERIES_BACKUP_SELECT = {
  id: true,
  titleEncrypted: true,
  kind: true,
  plannedSessions: true,
  startsOn: true,
  validUntil: true,
  endedOn: true,
  prescriberId: true,
  performerId: true,
  episodeId: true,
  noteEncrypted: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

type SeriesRow = Prisma.TreatmentSeriesGetPayload<{
  select: typeof TREATMENT_SERIES_BACKUP_SELECT;
}>;

/** One row as the file carries it: ciphertext on DR, readable on portable. */
export function toTreatmentSeriesBackupEntry(
  row: SeriesRow,
  disasterRecovery: boolean,
): TreatmentSeriesBackupEntry {
  return {
    id: row.id,
    kind: row.kind,
    plannedSessions: row.plannedSessions,
    startsOn: dateOnlyKey(row.startsOn),
    validUntil: row.validUntil ? dateOnlyKey(row.validUntil) : null,
    endedOn: row.endedOn ? dateOnlyKey(row.endedOn) : null,
    prescriberId: row.prescriberId,
    performerId: row.performerId,
    episodeId: row.episodeId,
    ...(disasterRecovery
      ? {
          titleEncrypted: encodeSealedBytes(row.titleEncrypted),
          noteEncrypted: encodeSealedBytes(row.noteEncrypted),
        }
      : {
          title: openSealedBytesForExport(
            row.titleEncrypted,
            "treatment series title",
          ),
          note: openSealedBytesForExport(
            row.noteEncrypted,
            "treatment series note",
          ),
        }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(disasterRecovery
      ? { deletedAt: row.deletedAt?.toISOString() ?? null }
      : {}),
  };
}

/**
 * Write the file's series back, after the practitioners and the condition
 * episodes, and answer which ids came back so the visits can remap theirs.
 */
export async function restoreTreatmentSeries(
  tx: Prisma.TransactionClient,
  ownerId: string,
  entries: readonly RestoredTreatmentSeries[],
  restoredPractitioners: ReadonlySet<string>,
  skips: RestoreSkipLog,
  unopened: string[],
): Promise<Set<string>> {
  const episodeRows = await tx.illnessEpisode.findMany({
    where: { userId: ownerId },
    select: { id: true },
  });
  const restoredEpisodes = new Set(episodeRows.map((row) => row.id));
  const dropped: string[] = [];
  const keep = (
    value: string | null | undefined,
    known: ReadonlySet<string>,
  ): string | null => {
    if (!value) return null;
    if (known.has(value)) return value;
    dropped.push(value);
    return null;
  };
  if (entries.length > 0) {
    await tx.treatmentSeries.createMany({
      data: entries.map((entry) => ({
        id: entry.id,
        userId: ownerId,
        // The title is the one required column: one this host cannot open
        // comes back as an empty sealed string, and the path is named.
        titleEncrypted:
          sealBytesForRestore(
            entry.titleEncrypted,
            entry.title,
            `treatmentSeries.${entry.id}.titleEncrypted`,
            unopened,
          ) ?? encryptToBytes(""),
        kind: entry.kind,
        plannedSessions: entry.plannedSessions ?? null,
        startsOn: dayToDate(entry.startsOn),
        validUntil: entry.validUntil ? dayToDate(entry.validUntil) : null,
        endedOn: entry.endedOn ? dayToDate(entry.endedOn) : null,
        prescriberId: keep(entry.prescriberId, restoredPractitioners),
        performerId: keep(entry.performerId, restoredPractitioners),
        episodeId: keep(entry.episodeId, restoredEpisodes),
        noteEncrypted: sealBytesForRestore(
          entry.noteEncrypted,
          entry.note,
          `treatmentSeries.${entry.id}.noteEncrypted`,
          unopened,
        ),
        createdAt: new Date(entry.createdAt),
        updatedAt: new Date(entry.updatedAt),
        deletedAt: entry.deletedAt ? new Date(entry.deletedAt) : null,
      })),
    });
  }
  recordUnknownKeys(skips, "visitReference", [...new Set(dropped)], dropped);
  return new Set(entries.map((entry) => entry.id));
}
