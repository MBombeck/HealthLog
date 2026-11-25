/**
 * The stored health score days, with both backup ends in one file.
 *
 * `HealthScoreRecord` looks derived and is not. The live computation answers
 * for today from today's rows, so a day whose readings have since been
 * corrected, re-synced or simply extended cannot be recomputed as it stood;
 * the row is the only copy of the number the account actually saw. Classifying
 * it `DERIVED` and leaving it out would produce a restore that comes back with
 * a blank history and reports success, which is the shape of defect the
 * nutrient day totals, the custom mood tags and the custom cycle symptoms each
 * shipped in turn.
 *
 * The builder and the restore live together deliberately, the way
 * `intraday-profile-backup.ts` and `src/lib/cycle/backup.ts` do: a reader
 * asking "is this carried at both ends?" answers it in one file, and a reader
 * who greps only the restore ROUTE gets a false negative, because the route
 * delegates.
 *
 * Nothing here is encrypted, so there is no portable/disaster-recovery split
 * on the values. The only difference between the two purposes is identity: a
 * canonical disaster-recovery payload carries the row id and its timestamps so
 * the row comes back as itself, a portable export carries the day alone.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import type { ScoreBand } from "@/lib/analytics/score/types";

export interface HealthScoreBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

/** One local day's score, exactly as it was shown. */
export interface HealthScoreRecordBackupEntry {
  /** Present in canonical DR payloads so the row keeps a stable identity. */
  id?: string;
  /** Local calendar day (`YYYY-MM-DD`) in `timezone`. */
  dayKey: string;
  /**
   * The zone the day was cut on. Carried for the same reason the intraday
   * curves carry theirs: an account that moved zones has days of different
   * lengths behind it, and a restore that guessed would make them look
   * comparable.
   */
  timezone: string;
  composite: number;
  band: ScoreBand;
  scoreVersion: number;
  composition: string[];
  /** Each counted pillar's own score, keyed by pillar id. */
  pillarScores: Record<string, number>;
  inputFingerprint: string;
  configVersion: number | null;
  configChangedAt: string | null;
  computedAt: string;
  createdAt?: string;
}

export interface HealthScoreBackupSection {
  healthScoreRecords: HealthScoreRecordBackupEntry[];
}

export interface HealthScoreBackupCounts {
  healthScoreRecords: number;
}

/**
 * Read the stored score days as JSON-safe entries.
 *
 * `pillarScores` arrives as an opaque `JsonValue`; it is narrowed here rather
 * than cast, so a row holding something other than a flat id-to-number map
 * reaches the payload as an empty map instead of as a shape the restore's
 * schema would reject at the worst possible moment.
 */
function readPillarScores(value: Prisma.JsonValue): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (pair): pair is [string, number] => typeof pair[1] === "number",
    ),
  );
}

/**
 * Build the stored-score slice of a user's full backup.
 *
 * Takes the delegate it uses rather than a whole `PrismaClient`, matching the
 * other section builders, so the route's global client and the worker's local
 * one share one read.
 */
export async function buildHealthScoreBackupSection(
  prisma: Pick<PrismaClient, "healthScoreRecord">,
  userId: string,
  options: HealthScoreBackupOptions = {},
): Promise<HealthScoreBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";

  // The table carries no tombstone — a day is written once and never deleted
  // short of a wipe — so both purposes read the same set.
  const rows = await prisma.healthScoreRecord.findMany({
    where: { userId },
    orderBy: [{ dayKey: "desc" }, { id: "asc" }],
  });

  return {
    healthScoreRecords: rows.map((row) => ({
      ...(disasterRecovery
        ? { id: row.id, createdAt: row.createdAt.toISOString() }
        : {}),
      dayKey: row.dayKey,
      timezone: row.timezone,
      composite: row.composite,
      band: row.band,
      scoreVersion: row.scoreVersion,
      composition: row.composition,
      pillarScores: readPillarScores(row.pillarScores),
      inputFingerprint: row.inputFingerprint,
      configVersion: row.configVersion,
      configChangedAt: row.configChangedAt?.toISOString() ?? null,
      computedAt: row.computedAt.toISOString(),
    })),
  };
}

/** Row counts for the audit trail, mirroring the other section counters. */
export function countHealthScoreBackupSection(
  section: HealthScoreBackupSection,
): HealthScoreBackupCounts {
  return { healthScoreRecords: section.healthScoreRecords.length };
}

/** Counts the score-record restore wiped, for the audit trail. */
export interface HealthScoreRestoreCleared {
  healthScoreRecords: number;
}

/**
 * The slice of a parsed backup this restore consumes.
 *
 * Required rather than optional: `BackupPayload` defaults it, so every caller
 * already satisfies this, and a caller that stops satisfying it fails to
 * compile instead of passing `undefined` into a loop that iterates zero times
 * and reports success.
 */
export interface HealthScoreRestoreInput {
  healthScoreRecords: HealthScoreRecordBackupEntry[];
}

/**
 * Re-create the account's stored score days.
 *
 * Delete-then-recreate inside the caller's transaction, matching every other
 * section. Note the asymmetry with the live write path next door: THAT one
 * yields on conflict, because a second computation of a day it already holds
 * must change nothing. This one does not, because the file is the authority
 * here and a day it carries twice is a corrupt file, not a race. Two entries
 * claiming the same local day therefore throw with a sentence rather than
 * letting `skipDuplicates` pick a winner and report success.
 */
export async function restoreHealthScoreData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: HealthScoreRestoreInput,
): Promise<HealthScoreRestoreCleared> {
  const cleared = await tx.healthScoreRecord.deleteMany({
    where: { userId: ownerId },
  });

  const seen = new Set<string>();
  for (const record of payload.healthScoreRecords) {
    if (seen.has(record.dayKey)) {
      throw new Error(
        `Duplicate health score record for ${record.dayKey}. One account has ` +
          "at most one score per local day, and picking a winner here would " +
          "silently discard the other reading of that day.",
      );
    }
    seen.add(record.dayKey);
  }

  if (payload.healthScoreRecords.length > 0) {
    await tx.healthScoreRecord.createMany({
      data: payload.healthScoreRecords.map((record) => ({
        ...(record.id ? { id: record.id } : {}),
        userId: ownerId,
        dayKey: record.dayKey,
        timezone: record.timezone,
        composite: record.composite,
        band: record.band,
        scoreVersion: record.scoreVersion,
        composition: record.composition,
        pillarScores: record.pillarScores as Prisma.InputJsonValue,
        inputFingerprint: record.inputFingerprint,
        configVersion: record.configVersion,
        configChangedAt: record.configChangedAt
          ? new Date(record.configChangedAt)
          : null,
        computedAt: new Date(record.computedAt),
        ...(record.createdAt ? { createdAt: new Date(record.createdAt) } : {}),
      })),
    });
  }

  return { healthScoreRecords: cleared.count };
}
