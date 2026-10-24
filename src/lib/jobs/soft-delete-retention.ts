/**
 * How long a soft-deleted row is kept, for every model that soft-deletes.
 *
 * A delete in HealthLog tombstones the row (`deletedAt`) so the undo and the
 * restore endpoints can bring it back and the `/api/sync/changes` feed can
 * tell an offline phone about it. Without a horizon the tombstone is forever:
 * a deleted lab result, visit or allergy stayed in the database, in every
 * backup and in every key rotation, for as long as the instance ran.
 *
 * Every model with a `deletedAt` column has exactly one entry here
 * (`src/lib/jobs/__tests__/soft-delete-retention-register.test.ts` derives the
 * set from the schema). An entry says which job removes the tombstones and
 * after how long:
 *
 * - `sync-feed`: the three dense sync domains, purged by the nightly
 *   `measurement-tombstone-cleanup` job after `TOMBSTONE_RETENTION_DAYS`.
 * - `document-grace`: the document vault, purged by `document-tombstone-purge`
 *   after its 30-day undo grace (it also carries the import keys over).
 * - `purge`: everything else, purged here by `soft-delete-purge`. The horizon
 *   is `TOMBSTONE_RETENTION_DAYS` unless the entry says otherwise: the same as
 *   the sync feed's (two of these models ride it, and a cursor older than the
 *   horizon is already answered with `cursorExpired`), and long past any undo.
 *   A restore endpoint asked for a purged row finds nothing, as it does for a
 *   purged measurement.
 *
 * The delete runs per account under the restore lock, in bounded batches
 * (`purgeTombstonesByAccount`). A key that cascades belongs to the row it
 * points at: a purged visit takes its link rows with it. A key that does not
 * cascade is a live record's reference, and a live record keeps what it shows:
 * a visit still names the practitioner it was with after the address-book
 * entry is deleted, so that entry is not purged while a live visit or dose
 * names it. Those references are each entry's `referencedBy`, and
 * `soft-delete-retention-register.test.ts` derives the set from the schema,
 * so a new nulling key into a purged model cannot ship without one.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { TOMBSTONE_RETENTION_DAYS } from "@/lib/auth/native-client";
import { getCoachMessageRetentionDays } from "@/lib/jobs/coach-message-cleanup";
import { DOCUMENT_PURGE_GRACE_DAYS } from "@/lib/jobs/document-purge-queue";
import {
  purgeTombstonesByAccount,
  type TombstonePurgeOutcome,
} from "@/lib/jobs/measurement-tombstone-cleanup";

/**
 * A key into a purged model that does not cascade. While a row that is not
 * itself tombstoned holds it, the row it names stays.
 */
export interface LiveReferrer {
  /** The physical table holding the key; a literal, spliced into the SQL. */
  table: string;
  /** The key column; a literal, spliced into the SQL. */
  column: string;
  /** Whether the referring table soft-deletes (a tombstoned row is not live). */
  softDeletes: boolean;
}

export type SoftDeleteRetention =
  | { kind: "sync-feed"; days: number }
  | { kind: "document-grace"; days: number }
  | {
      kind: "purge";
      /** The physical table; a literal, spliced into the purge SQL. */
      table: string;
      /** Days a tombstone is kept. */
      days: () => number;
      /**
       * Extra condition a purgeable row must meet, a literal SQL fragment over
       * the alias `t`. For a tombstone something live still depends on.
       */
      keep?: string;
      /** The live references that hold a tombstone back. */
      referencedBy?: readonly LiveReferrer[];
      /** Why the horizon or the condition differs from the default. */
      why?: string;
    };

const standard = (
  table: string,
  referencedBy?: readonly LiveReferrer[],
): SoftDeleteRetention => ({
  kind: "purge",
  table,
  days: () => TOMBSTONE_RETENTION_DAYS,
  ...(referencedBy ? { referencedBy } : {}),
});

const live = (table: string, column: string): LiveReferrer => ({
  table,
  column,
  softDeletes: true,
});
const always = (table: string, column: string): LiveReferrer => ({
  table,
  column,
  softDeletes: false,
});

export const SOFT_DELETE_RETENTION: Readonly<
  Record<string, SoftDeleteRetention>
> = {
  Measurement: { kind: "sync-feed", days: TOMBSTONE_RETENTION_DAYS },
  MoodEntry: { kind: "sync-feed", days: TOMBSTONE_RETENTION_DAYS },
  MedicationIntakeEvent: { kind: "sync-feed", days: TOMBSTONE_RETENTION_DAYS },
  InboundDocument: { kind: "document-grace", days: DOCUMENT_PURGE_GRACE_DAYS },

  // Both ride the sync feed; the default horizon is the feed's.
  CycleDayLog: standard("cycle_day_logs"),
  MenstrualCycle: {
    kind: "purge",
    table: "menstrual_cycles",
    days: () => TOMBSTONE_RETENTION_DAYS,
    referencedBy: [live("cycle_day_logs", "cycle_id")],
    keep: `NOT EXISTS (SELECT 1 FROM "menstrual_cycles" a
                        WHERE a."id" = t."absorbed_into_id"
                          AND a."deleted_at" IS NULL)`,
    why: "A start folded into a later cycle is tombstoned with `absorbedIntoId` and given back when that cycle is deleted (`cycle-boundaries.ts`), so it stays while the cycle that absorbed it is live.",
  },
  CoachFact: {
    kind: "purge",
    table: "coach_facts",
    days: getCoachMessageRetentionDays,
    why: "A stored answer's trail can name a removed medication fact, and the trail is withheld against the fact rows (`trail-read.ts`); the fact therefore outlives every message that may name it, which is the coach message retention.",
  },

  MentalHealthAssessment: standard("mental_health_assessments"),
  MeasurementReminder: standard("measurement_reminders", [
    live("encounters", "reminder_id"),
    live("vaccination_records", "reminder_id"),
  ]),
  LabResult: standard("lab_results"),
  CustomMetric: standard("custom_metrics"),
  CustomMetricEntry: standard("custom_metric_entries"),
  CoachPlan: standard("coach_plans"),
  CoachReminder: standard("coach_reminders"),
  IllnessEpisode: standard("illness_episodes", [
    live("illness_episodes", "parent_condition_id"),
    always("symptom_events", "episode_id"),
  ]),
  IllnessDayLog: standard("illness_day_logs"),
  Allergy: standard("allergies"),
  FamilyHistoryEntry: standard("family_history_entries"),
  Encounter: standard("encounters", [
    live("vaccination_records", "encounter_id"),
  ]),
  Practitioner: standard("practitioners", [
    live("encounters", "practitioner_id"),
    live("vaccination_records", "practitioner_id"),
  ]),
  VaccinationRecord: standard("vaccination_records"),
  CustomVaccine: standard("custom_vaccines", [
    live("vaccination_records", "custom_vaccine_id"),
  ]),
  LifeEvent: standard("life_events"),
};

const TABLE = /^[a-z_]+$/;
const DAY_MS = 86_400_000;

/**
 * The condition a purgeable row must meet, over the alias `t`: the entry's
 * own `keep`, and no live row holding a key to it. Every identifier comes
 * from the register's literals and is asserted against a closed pattern.
 */
export function purgeCondition(
  entry: Extract<SoftDeleteRetention, { kind: "purge" }>,
): string {
  const parts: string[] = [];
  if (entry.keep) parts.push(entry.keep);
  for (const ref of entry.referencedBy ?? []) {
    if (!TABLE.test(ref.table) || !TABLE.test(ref.column)) {
      throw new Error(`Bad referrer ${ref.table}.${ref.column}`);
    }
    const alive = ref.softDeletes ? ` AND r."deleted_at" IS NULL` : "";
    parts.push(
      `NOT EXISTS (SELECT 1 FROM "${ref.table}" r WHERE r."${ref.column}" = t."id"${alive})`,
    );
  }
  return parts.map((part) => `AND ${part}`).join(" ");
}

/** One table's purge, for the run report. */
export interface SoftDeletePurgeLeg extends TombstonePurgeOutcome {
  model: string;
  table: string;
}

/**
 * Purge one register entry's expired tombstones. The table name and the extra
 * condition come from the register's literals, never from input; the name is
 * asserted against a closed pattern before it is spliced.
 */
export async function purgeSoftDeletedTable(
  prisma: PrismaClient,
  model: string,
  now: Date = new Date(),
): Promise<SoftDeletePurgeLeg> {
  const entry = SOFT_DELETE_RETENTION[model];
  if (!entry || entry.kind !== "purge" || !TABLE.test(entry.table)) {
    throw new Error(`No purge entry for ${model}`);
  }
  const table = `"${entry.table}"`;
  const cutoff = new Date(now.getTime() - entry.days() * DAY_MS);
  const keep = purgeCondition(entry);
  const outcome = await purgeTombstonesByAccount({
    prisma,
    findRows: (take, skipUserIds) =>
      prisma.$queryRawUnsafe<Array<{ id: string; userId: string }>>(
        `SELECT t."id", t."user_id" AS "userId" FROM ${table} t
          WHERE t."deleted_at" IS NOT NULL AND t."deleted_at" < $1
            AND NOT (t."user_id" = ANY($2::text[])) ${keep}
          LIMIT $3`,
        cutoff,
        skipUserIds,
        take,
      ),
    // The row is re-checked inside the delete: a restore between the read and
    // the delete un-tombstones it, and then it stays.
    deleteIds: (tx, ids, userId) =>
      tx.$executeRawUnsafe(
        `DELETE FROM ${table} t
          WHERE t."id" = ANY($1::text[]) AND t."user_id" = $2
            AND t."deleted_at" IS NOT NULL AND t."deleted_at" < $3 ${keep}`,
        ids,
        userId,
        cutoff,
      ),
  });
  return { ...outcome, model, table: entry.table };
}

/** Every `purge` entry of the register, in declaration order. */
export function purgeModels(): string[] {
  return Object.entries(SOFT_DELETE_RETENTION)
    .filter(([, entry]) => entry.kind === "purge")
    .map(([model]) => model);
}

/** Run every `purge` entry, one table after the other. */
export async function purgeSoftDeletedRows(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<SoftDeletePurgeLeg[]> {
  const legs: SoftDeletePurgeLeg[] = [];
  for (const model of purgeModels()) {
    legs.push(await purgeSoftDeletedTable(prisma, model, now));
  }
  return legs;
}
