/**
 * Turn each domain's rows into its wire block: tombstones for the
 * soft-deleted rows, upserts for the live ones.
 */
import { prisma } from "@/lib/db";
import {
  findCompactionTombstones,
  isFoldedWindowCandidate,
  loadFoldTimezone,
} from "@/lib/measurements/folded-window";
import { readNote } from "@/lib/crypto/note-cipher";
import { resolveAppleHealthMirror } from "@/lib/measurements/apple-health-mirror";
import { levelAForWire } from "@/lib/mood/level-a";
import { contextForWire } from "@/lib/mood/context";
import {
  toCycleDayLogDTO,
  toMenstrualCycleDTO,
  type CycleDayLogDTO,
  type MenstrualCycleDTO,
} from "@/lib/cycle/dto";

import type {
  CycleDayRow,
  CycleRow,
  IntakeRow,
  MeasurementMirrorRow,
  MeasurementRow,
  MoodRow,
} from "./read-rows";
import type {
  CycleDayTombstone,
  DomainBlock,
  IdTombstone,
  IntakeUpsert,
  MeasurementMirrorUpsert,
  MeasurementTombstone,
  MeasurementUpsert,
  MoodUpsert,
} from "./wire";

/** A domain's page: the rows inside the limit, and whether more follow. */
export function pageOf<R>(
  rows: R[],
  limit: number,
): { page: R[]; hasMore: boolean } {
  const hasMore = rows.length > limit;
  return { page: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

function idTombstone(row: {
  id: string;
  syncVersion: number;
  deletedAt: Date;
  updatedAt: Date;
}): IdTombstone {
  return {
    id: row.id,
    syncVersion: row.syncVersion,
    deletedAt: row.deletedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Compaction tombstones are not deletions anyone made. The folds used to
 * soft-delete the raw Apple Health samples they folded into an hourly or
 * daily `stats:` row, and those rows rode this feed as tombstones for 75
 * days. They are left out, by the same classifier the backlog purge uses
 * (`folded-window.ts`); the cursor still advances past them, so the keyset
 * walk is unchanged. A person's own deletions are reported exactly as
 * before.
 */
async function compactionIds(
  userId: string,
  page: MeasurementRow[],
): Promise<Set<string>> {
  const compaction = new Set<string>();
  const tombstonesOnPage = page.filter((row) => row.deletedAt !== null);
  if (tombstonesOnPage.length === 0) return compaction;
  const candidates = tombstonesOnPage.map((row) => ({
    type: row.type,
    source: row.source,
    externalId: row.externalId,
    measuredAt: row.measuredAt,
    deletedAt: row.deletedAt,
  }));
  if (candidates.some((row) => isFoldedWindowCandidate(row, row.deletedAt!))) {
    const classA = await findCompactionTombstones(
      prisma,
      userId,
      await loadFoldTimezone(prisma, userId),
      candidates,
    );
    for (const index of classA) compaction.add(tombstonesOnPage[index].id);
  }
  return compaction;
}

export async function measurementBlock(
  userId: string,
  page: MeasurementRow[],
): Promise<DomainBlock<MeasurementUpsert, MeasurementTombstone>> {
  const compaction = await compactionIds(userId, page);
  const upserts: MeasurementUpsert[] = [];
  const tombstones: MeasurementTombstone[] = [];
  for (const row of page) {
    if (compaction.has(row.id)) continue;
    if (row.deletedAt) {
      tombstones.push({
        id: row.id,
        externalId: row.externalId,
        syncVersion: row.syncVersion,
        deletedAt: row.deletedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
    } else {
      // Every row carries its `source`. RECOVERY_SCORE is written by BOTH the
      // WHOOP-native sync (`source = WHOOP`) and the COMPUTED proxy job
      // (`source = COMPUTED`) for the same day; the client must resolve to ONE
      // canonical recovery series (WHOOP wins when present, COMPUTED is the
      // fallback) and never chart the proxy and the native value as two
      // competing series. The feed faithfully mirrors both rows (a delta-sync
      // mirror cannot drop a row mid-keyset without a tombstone); the
      // canonical pick is the same WHOOP-over-COMPUTED rule the server's
      // wellness tile + doctor PDF apply (`resolveCanonicalRecovery`).
      upserts.push({
        id: row.id,
        externalId: row.externalId,
        type: row.type,
        value: row.value,
        unit: row.unit,
        measuredAt: row.measuredAt.toISOString(),
        source: row.source,
        notes: readNote(row.notesEncrypted, row.notes),
        appleHealthMirror: resolveAppleHealthMirror(row),
        syncVersion: row.syncVersion,
        updatedAt: row.updatedAt.toISOString(),
      });
    }
  }
  return { upserts, tombstones };
}

export function measurementMirrorBlock(
  page: MeasurementMirrorRow[],
): DomainBlock<MeasurementMirrorUpsert, never> {
  return {
    upserts: page.map((row) => ({
      id: row.id,
      appleHealthMirror: resolveAppleHealthMirror(row),
    })),
    tombstones: [],
  };
}

export function moodBlock(
  page: MoodRow[],
): DomainBlock<MoodUpsert, IdTombstone> {
  const upserts: MoodUpsert[] = [];
  const tombstones: IdTombstone[] = [];
  for (const row of page) {
    if (row.deletedAt) {
      tombstones.push(idTombstone({ ...row, deletedAt: row.deletedAt }));
    } else {
      upserts.push({
        id: row.id,
        date: row.date,
        mood: row.mood,
        score: row.score,
        // Under the same wire keys the write path accepts, so a client reads
        // back exactly what it can post.
        ...levelAForWire(row),
        context: row.context ? contextForWire(row.context) : null,
        tags: row.tags,
        note: readNote(row.noteEncrypted, row.note),
        moodLoggedAt: row.moodLoggedAt.toISOString(),
        source: row.source,
        syncVersion: row.syncVersion,
        updatedAt: row.updatedAt.toISOString(),
      });
    }
  }
  return { upserts, tombstones };
}

export function intakeBlock(
  page: IntakeRow[],
): DomainBlock<IntakeUpsert, IdTombstone> {
  const upserts: IntakeUpsert[] = [];
  const tombstones: IdTombstone[] = [];
  for (const row of page) {
    if (row.deletedAt) {
      tombstones.push(idTombstone({ ...row, deletedAt: row.deletedAt }));
    } else {
      upserts.push({
        id: row.id,
        medicationId: row.medicationId,
        scheduledFor: row.scheduledFor.toISOString(),
        takenAt: row.takenAt?.toISOString() ?? null,
        skipped: row.skipped,
        source: row.source,
        autoRecorded: row.autoRecorded,
        syncVersion: row.syncVersion,
        updatedAt: row.updatedAt.toISOString(),
      });
    }
  }
  return { upserts, tombstones };
}

export function cycleDayBlock(
  page: CycleDayRow[],
): DomainBlock<CycleDayLogDTO, CycleDayTombstone> {
  const upserts: CycleDayLogDTO[] = [];
  const tombstones: CycleDayTombstone[] = [];
  for (const row of page) {
    if (row.deletedAt) {
      tombstones.push({
        id: row.id,
        externalId: row.externalId,
        syncVersion: row.syncVersion,
        deletedAt: row.deletedAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
    } else {
      upserts.push(toCycleDayLogDTO(row));
    }
  }
  return { upserts, tombstones };
}

export function cycleBlock(
  page: CycleRow[],
): DomainBlock<MenstrualCycleDTO, IdTombstone> {
  const upserts: MenstrualCycleDTO[] = [];
  const tombstones: IdTombstone[] = [];
  for (const row of page) {
    if (row.deletedAt) {
      tombstones.push(idTombstone({ ...row, deletedAt: row.deletedAt }));
    } else {
      upserts.push(toMenstrualCycleDTO(row));
    }
  }
  return { upserts, tombstones };
}
