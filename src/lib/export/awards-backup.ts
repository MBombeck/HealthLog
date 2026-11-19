/**
 * What the account EARNED: its personal bests and its unlocked badges, with
 * both backup ends in one file.
 *
 * Same arrangement as `reminders-backup.ts` and `coach-backup.ts`, for the same
 * reason: a reader asking "is this carried at both ends?" answers it here, and
 * a reader who greps only the restore ROUTE gets a false negative because the
 * route delegates.
 *
 * Two models ride. The register called the bests "recomputable in principle
 * from measurements and workouts, but nothing recomputes them today, so in
 * practice they are lost", and the badges "milestones the account earned, with
 * the date each was reached. The date is the part that cannot be recovered".
 * Both entries understate it slightly, and the difference is worth writing
 * down because it decides what this file has to carry.
 *
 * ## Neither one is really recomputable
 *
 * A best is a claim about a history, and the history a restored account has is
 * not the one the best was found in. Workout sample series and GPS routes do
 * not travel at all (disclosed in the file's own manifest), a portable export
 * omits soft-deleted measurements, and a record found in a reading that has
 * since been corrected can never be found again. So a "recomputation" would
 * not reproduce these rows; it would produce different ones and call them the
 * same.
 *
 * The badge is worse, because the date is load-bearing and half the dates have
 * no source left. `achievements-result.ts` merges persisted unlock dates with
 * dates it can still derive, and persisted wins. Several metrics it derives
 * from are things this backup deliberately does not carry: passkey and
 * password login counts, the doctor-PDF and locale-flip counters. Drop the
 * rows and those badges do not come back with an older date; they come back
 * with today's, or they relock.
 *
 * ## The one reference that can take the whole restore down
 *
 * `PersonalRecord.sourceMeasurementId` looks like a bare id column in
 * `prisma/schema.prisma`, which declares no relation for it. The DATABASE
 * disagrees: migration 0054 created it as
 * `REFERENCES "measurements"("id") ON DELETE SET NULL`, so it is a real
 * foreign key that the Prisma client does not know about.
 *
 * That is the dangerous combination rather than the harmless one. The client
 * writes whatever value it is handed, and Postgres refuses the statement,
 * which rolls back the whole transaction and returns an account with NOTHING
 * in it over a single provenance pointer. The mood categories were the same
 * shape of defect measured a release earlier: a 500 and an empty account.
 *
 * So the restore resolves the pointer against the measurements it actually
 * wrote, NULLS what it cannot resolve, and reports the miss. Nulling rather
 * than dropping is the point: the record itself is the historical fact, which
 * is exactly why the column was declared `ON DELETE SET NULL` in the first
 * place. Losing the pointer costs an audit trail nothing reads; losing the row
 * costs a best that cannot be found again.
 *
 * The ordinary way a pointer fails to resolve is a portable file: the
 * measurement behind the record was soft-deleted, so the file omits it while
 * the record still names it.
 *
 * ## An unlocked badge is not judged against the catalogue
 *
 * `UserAchievement.achievementId` names a definition in
 * `src/lib/gamification/achievements.ts`. That is code, not a table, so nothing in
 * the database constrains it and an unknown value costs no error. It is
 * carried and written back verbatim, and the restore does not check it against
 * the catalogue this build ships. The catalogue is the part that drifts: a
 * file can be older than the release reading it, or newer. A row is evidence
 * that a person earned something on a day, and a build that no longer defines
 * the badge is not evidence that they did not. The same decision the
 * vaccination restore makes for an antigen slug it cannot resolve, for the
 * same reason.
 *
 * ## One wire shape, both purposes
 *
 * Neither model has a tombstone column and neither holds ciphertext, so a
 * portable export and a disaster-recovery payload carry byte-identical
 * sections. This builder therefore takes no `purpose`: a parameter that
 * changes nothing would advertise a distinction the file does not have.
 */
import { isLegacyRmssdRow } from "@/lib/export/legacy-rmssd";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type {
  MeasurementSource,
  MeasurementType,
  PersonalRecordDirection,
} from "@/generated/prisma/client";

import {
  recordUnknownKeys,
  type RestoreSkipLog,
} from "@/lib/export/restore-skips";

/** One best, as the detection worker recorded it. */
export interface PersonalRecordBackupEntry {
  metricType: MeasurementType;
  /**
   * The sport dimension for a workout-driven best (`running_5km_time`), NULL
   * for a measurement-driven one. Carried because it is what separates two
   * bests that share a metric: without it a best 5k and a best 10k are the
   * same row said twice.
   */
  metricSlot: string | null;
  /**
   * Whether higher or lower wins. Not derivable from the row: the read path
   * orders by `value` in the direction this column names, so a best time
   * restored as MAX becomes the account's WORST time, presented as its record.
   */
  direction: PersonalRecordDirection;
  value: number;
  unit: string;
  /** The day the best was set. The whole point of the row. */
  achievedAt: string;
  /**
   * The measurement the record was found in. A real foreign key in the
   * database despite the schema declaring no relation; see the file header.
   */
  sourceMeasurementId: string | null;
  source: MeasurementSource;
  externalId: string | null;
  createdAt: string;
}

/** One badge, and the day it was earned. */
export interface UserAchievementBackupEntry {
  /** A definition id in the code catalogue. Carried verbatim, never judged. */
  achievementId: string;
  /**
   * When the badge was earned. The irreplaceable field: the evaluator prefers
   * a persisted date over a derived one, and for several metrics no derivable
   * date survives a restore at all.
   */
  unlockedAt: string;
  createdAt: string;
}

export interface AwardsBackupSection {
  personalRecords: PersonalRecordBackupEntry[];
  userAchievements: UserAchievementBackupEntry[];
}

export interface AwardsBackupCounts {
  personalRecords: number;
  userAchievements: number;
}

/**
 * Named select constants, one per model, because a structural matcher binds a model
 * to the literal beside its delegate call, matching the other section files.
 *
 * No `id` on either. Nothing in the file addresses a best or a badge, so a
 * stable id would be carried for its own sake; the one id that IS carried is
 * the measurement a best points at, because that one is a reference the
 * restore has to resolve.
 */
const PERSONAL_RECORD_BACKUP_SELECT = {
  metricType: true,
  metricSlot: true,
  direction: true,
  value: true,
  unit: true,
  achievedAt: true,
  sourceMeasurementId: true,
  source: true,
  externalId: true,
  createdAt: true,
} as const satisfies Prisma.PersonalRecordSelect;

const USER_ACHIEVEMENT_BACKUP_SELECT = {
  achievementId: true,
  unlockedAt: true,
  createdAt: true,
} as const satisfies Prisma.UserAchievementSelect;

/**
 * Build the awards slice of a user's full backup.
 *
 * Takes the delegates it uses rather than a whole client, matching the other
 * section builders.
 */
export async function buildAwardsBackupSection(
  prisma: Pick<PrismaClient, "personalRecord" | "userAchievement">,
  userId: string,
): Promise<AwardsBackupSection> {
  const [recordRows, achievementRows] = await Promise.all([
    prisma.personalRecord.findMany({
      where: { userId },
      orderBy: [{ achievedAt: "asc" }, { id: "asc" }],
      select: PERSONAL_RECORD_BACKUP_SELECT,
    }),
    prisma.userAchievement.findMany({
      where: { userId },
      orderBy: [{ unlockedAt: "asc" }, { id: "asc" }],
      select: USER_ACHIEVEMENT_BACKUP_SELECT,
    }),
  ]);

  return {
    personalRecords: recordRows.map((row) => ({
      metricType: row.metricType,
      metricSlot: row.metricSlot,
      direction: row.direction,
      value: row.value,
      unit: row.unit,
      achievedAt: row.achievedAt.toISOString(),
      sourceMeasurementId: row.sourceMeasurementId,
      source: row.source,
      externalId: row.externalId,
      createdAt: row.createdAt.toISOString(),
    })),
    userAchievements: achievementRows.map((row) => ({
      achievementId: row.achievementId,
      unlockedAt: row.unlockedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/** Row counts for the audit trail, mirroring the other section counters. */
export function countAwardsBackupSection(
  section: AwardsBackupSection,
): AwardsBackupCounts {
  return {
    personalRecords: section.personalRecords.length,
    userAchievements: section.userAchievements.length,
  };
}

/** Counts the awards restore wiped, for the audit trail. */
export interface AwardsRestoreCleared {
  personalRecords: number;
  userAchievements: number;
}

/**
 * What the restore reads, as the parsed file actually presents it. Wider than
 * what this release writes, because every optional column arrives as
 * `undefined` rather than `null` from a file written before it existed.
 *
 * `unlockedAt` stays strictly required. A file that does not say when a badge
 * was earned must not be silently restored to restore-day, and making the
 * field optional here would let exactly that compile.
 */
type OptionalNullable<T> = { [K in keyof T]?: T[K] | undefined };

export type RestoredPersonalRecord = Pick<
  PersonalRecordBackupEntry,
  "metricType" | "direction" | "value" | "unit" | "achievedAt"
> &
  OptionalNullable<
    Pick<
      PersonalRecordBackupEntry,
      "metricSlot" | "sourceMeasurementId" | "source" | "externalId"
    >
  > & { createdAt?: string };

export type RestoredUserAchievement = Pick<
  UserAchievementBackupEntry,
  "achievementId" | "unlockedAt"
> & { createdAt?: string };

export interface AwardsRestoreInput {
  personalRecords: RestoredPersonalRecord[];
  userAchievements: RestoredUserAchievement[];
}

/**
 * Re-create the account's bests and badges.
 *
 * Delete-then-recreate inside the caller's transaction, matching every other
 * section.
 *
 * MUST be called AFTER the measurements are restored. `sourceMeasurementId` is
 * a foreign key the Prisma schema does not declare (see the file header), so
 * running earlier would not quietly drop the provenance. It would fail the
 * constraint and roll the entire restore back.
 *
 * `measurementIds` is the set of measurements the restore actually wrote with
 * a stable id, passed in rather than re-queried so this stays a pure function
 * of the transaction it was handed. Legacy v1 files carry measurements with no
 * id at all; those rows are minted fresh and are unaddressable by definition,
 * so a best that names one lands with a NULL pointer and a report.
 */
export async function restoreAwardsData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: AwardsRestoreInput,
  measurementIds: ReadonlySet<string>,
  skips: RestoreSkipLog,
  /** Workout keys the workout step changed (old key to new key). */
  workoutKeyByLegacyKey: ReadonlyMap<string, string> = new Map(),
): Promise<AwardsRestoreCleared> {
  const [clearedRecords, clearedAchievements] = await Promise.all([
    tx.personalRecord.deleteMany({ where: { userId: ownerId } }),
    tx.userAchievement.deleteMany({ where: { userId: ownerId } }),
  ]);

  const danglingMeasurementRefs: string[] = [];
  // A file written before migration 0420 can hold an SDNN best that a
  // Fitbit or Google Health RMSSD reading set. The migration deleted those
  // (that series keeps no records, and the detector re-derives the SDNN bests
  // from what remains), so the restore leaves them out too.
  const records = payload.personalRecords.filter(
    (entry) =>
      !isLegacyRmssdRow({
        type: entry.metricType,
        source: entry.source ?? null,
      }),
  );
  if (records.length > 0) {
    await tx.personalRecord.createMany({
      data: records.map((entry) => {
        let sourceMeasurementId = entry.sourceMeasurementId ?? null;
        if (sourceMeasurementId && !measurementIds.has(sourceMeasurementId)) {
          danglingMeasurementRefs.push(sourceMeasurementId);
          sourceMeasurementId = null;
        }
        return {
          userId: ownerId,
          metricType: entry.metricType,
          metricSlot: entry.metricSlot ?? null,
          direction: entry.direction,
          value: entry.value,
          unit: entry.unit,
          achievedAt: new Date(entry.achievedAt),
          sourceMeasurementId,
          // A file written before the column existed says nothing about it,
          // and the schema default is what those rows were living as.
          source: entry.source ?? "MANUAL",
          // A best set by an export workout the restore collapsed names the
          // row that was kept.
          externalId:
            entry.source === "APPLE_HEALTH" && entry.externalId
              ? (workoutKeyByLegacyKey.get(entry.externalId) ??
                entry.externalId)
              : (entry.externalId ?? null),
          ...(entry.createdAt ? { createdAt: new Date(entry.createdAt) } : {}),
        };
      }),
    });
  }
  recordUnknownKeys(
    skips,
    "personalRecordReference",
    [...new Set(danglingMeasurementRefs)],
    danglingMeasurementRefs,
  );

  if (payload.userAchievements.length > 0) {
    await tx.userAchievement.createMany({
      data: payload.userAchievements.map((entry) => ({
        userId: ownerId,
        // Verbatim, and not checked against this build's catalogue. See the
        // file header: the catalogue is code and drifts, the row is evidence.
        achievementId: entry.achievementId,
        // Verbatim, and the reason this section exists at all.
        unlockedAt: new Date(entry.unlockedAt),
        ...(entry.createdAt ? { createdAt: new Date(entry.createdAt) } : {}),
      })),
    });
  }

  return {
    personalRecords: clearedRecords.count,
    userAchievements: clearedAchievements.count,
  };
}
