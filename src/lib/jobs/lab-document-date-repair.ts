/**
 * One-shot repair: lab values confirmed from a document before the confirm
 * step learned to date an undated value by its document.
 *
 * A lab report usually prints the collection date once, in its header. The
 * extraction stores that date on the document (`reportDate`) and leaves each
 * value's own date empty, and the confirm step used to file such a value
 * under the moment it was confirmed. The confirm step now takes the
 * document's day (`documentDay` in `src/lib/documents/commit.ts`); this pass
 * moves the values it filed wrongly before, by the same rule.
 *
 * A value is moved only when every link in the chain is certain:
 *   - the lab result was written by the document confirm path
 *     (`source = 'DOCUMENT'`, which no other writer sets) and is live;
 *   - exactly one APPROVED observation fact names it as its committed record,
 *     so the document it came from is known;
 *   - its `takenAt` still sits within a few seconds of its own `createdAt`,
 *     which is what a value filed under its confirmation moment looks like
 *     (both were stamped in the same create). A value the person re-dated
 *     since, or one that carried its own date, sits elsewhere;
 *   - the staged fact states no calendar date of its own (decrypted here;
 *     SQL cannot see it);
 *   - the document has a report date, else a filing date, and that day is
 *     not the day the value is filed under in the owner's time zone. A value
 *     really taken on the day it was confirmed stays where it is.
 *
 * The moved value lands at noon UTC on the document's day, the anchor every
 * date-only lab value uses. Idempotent: a moved value no longer sits at its
 * creation moment, so a second run finds nothing, and a boot with nothing to
 * repair costs one query.
 */
import type { Job } from "pg-boss";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { activeAccountSql } from "@/lib/account-deletion/active-account";
import { invalidateUserHealthScore } from "@/lib/cache/invalidate";
import { prisma as defaultPrisma } from "@/lib/db";
import { documentDay, statedDay } from "@/lib/documents/commit";
import { decryptFactData } from "@/lib/documents/store";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { workerLog } from "@/lib/jobs/reminder/shared";
import { annotate } from "@/lib/logging/context";
import { withBackgroundEvent } from "@/lib/logging/background";
import { dateOnlyAtNoonUtc } from "@/lib/tz/date-only";
import { userDayKey } from "@/lib/tz/format";
import { DEFAULT_TIMEZONE, resolveUserTimezone } from "@/lib/tz/resolver";
import type { ObservationFactData } from "@/lib/validations/inbound-documents";

import {
  LAB_DOCUMENT_DATE_REPAIR_QUEUE,
  LAB_DOCUMENT_DATE_REPAIR_SINGLETON_KEY,
} from "./lab-document-date-repair-queue";

/**
 * How far `takenAt` may sit from `createdAt` and still count as the moment of
 * confirmation. The two are stamped a few milliseconds apart in one create; a
 * few seconds leaves room for a clock step and nothing a person would type.
 */
const CONFIRM_MOMENT_TOLERANCE_SECONDS = 5;

interface CandidateRow {
  id: string;
  userId: string;
  takenAt: Date;
  dataEncrypted: Uint8Array;
  reportDate: Date | null;
  documentDate: Date | null;
}

/**
 * The SQL half of the rule. `limit` turns it into the boot's existence
 * check. `.planning/v1.46.2-fragments/lab-repair-count.sql` is the same
 * predicate as a read-only count.
 */
function candidateQuery(limit: number | null): Prisma.Sql {
  // The day comparison runs here as well as in the repair, so a value that
  // really was taken on its confirmation day drops out of the boot check and
  // the pass converges to an empty set. Both must read the same zone: a
  // stored zone Postgres does not know falls back the way
  // `resolveUserTimezone` falls back, to the instance default and then to
  // `DEFAULT_TIMEZONE`. Reading it as UTC instead kept a value confirmed
  // near midnight in the candidate set that the repair, in the app's zone,
  // left alone, so every boot enqueued the job again. The repair still
  // re-checks every row in the zone the app resolves.
  return Prisma.sql`
    WITH "known_zones" AS (SELECT "name" FROM pg_timezone_names),
    "instance_zone" AS (
      SELECT COALESCE(
        (
          SELECT s."default_user_timezone" FROM "app_settings" s
          WHERE s."id" = 'singleton'
            AND s."default_user_timezone" IN (SELECT "name" FROM "known_zones")
        ),
        ${DEFAULT_TIMEZONE}
      ) AS "name"
    )
    SELECT r."id",
           r."user_id"       AS "userId",
           r."taken_at"      AS "takenAt",
           f."data_encrypted" AS "dataEncrypted",
           d."report_date"   AS "reportDate",
           d."document_date" AS "documentDate"
    FROM "lab_results" r
    JOIN "extracted_facts" f
      ON f."committed_record_id" = r."id"
     AND f."committed_record_type" = 'labResult'
     AND f."status" = 'APPROVED'
     AND f."fact_type" = 'OBSERVATION'
     AND f."user_id" = r."user_id"
    JOIN "inbound_documents" d
      ON d."id" = f."document_id"
     AND d."user_id" = r."user_id"
    JOIN "users" u ON u."id" = r."user_id"
    WHERE r."source" = 'DOCUMENT'
      AND r."deleted_at" IS NULL
      AND abs(extract(epoch FROM (r."taken_at" - r."created_at"))) <= ${CONFIRM_MOMENT_TOLERANCE_SECONDS}
      AND COALESCE(d."report_date", d."document_date") IS NOT NULL
      AND to_char(COALESCE(d."report_date", d."document_date"), 'YYYY-MM-DD')
          <> to_char(
               (r."taken_at" AT TIME ZONE 'UTC') AT TIME ZONE (
                 CASE WHEN u."timezone" IN (SELECT "name" FROM "known_zones")
                      THEN u."timezone"
                      ELSE (SELECT "name" FROM "instance_zone") END
               ),
               'YYYY-MM-DD'
             )
      AND (
        SELECT count(*) FROM "extracted_facts" other
        WHERE other."committed_record_id" = r."id"
          AND other."committed_record_type" = 'labResult'
      ) = 1
      AND ${activeAccountSql('r."user_id"')}
    ORDER BY r."id"
    ${limit === null ? Prisma.empty : Prisma.sql`LIMIT ${limit}`}
  `;
}

export interface LabDocumentDateRepairResult {
  /** Rows the SQL predicate returned. */
  scanned: number;
  /** Rows moved to their document's day. */
  updated: number;
  /** Rows left alone: an own date, or already on the document's day. */
  unchanged: number;
  /**
   * Rows whose staged fact would not decrypt (a key retired too early, a
   * damaged row). Skipped: without the fact there is no telling whether the
   * value carries a date of its own, and one such row must not stop the
   * repair of every other account.
   */
  undecryptable: number;
}

/** The repair itself, across every account. */
export async function repairUndatedDocumentLabValues(
  prisma: PrismaClient = defaultPrisma,
): Promise<LabDocumentDateRepairResult> {
  const rows = await prisma.$queryRaw<CandidateRow[]>(candidateQuery(null));
  const touchedUsers = new Set<string>();
  let updated = 0;
  let unchanged = 0;
  // Reported as `undecryptable` in the outcome facts.
  let decryptFailed = 0;

  for (const row of rows) {
    let data: ObservationFactData;
    try {
      data = decryptFactData(row.dataEncrypted) as ObservationFactData;
    } catch {
      decryptFailed += 1;
      continue;
    }
    // A value with a date of its own is never touched, whatever its row says.
    if (statedDay(data.effectiveDate ?? null) !== null) {
      unchanged += 1;
      continue;
    }
    const day = documentDay({
      reportDate: row.reportDate,
      documentDate: row.documentDate,
    });
    const tz = await resolveUserTimezone(row.userId);
    if (!day || userDayKey(row.takenAt, tz) === day) {
      unchanged += 1;
      continue;
    }
    // Conditional on the value read: a re-date that landed since the read
    // wins over the repair.
    const moved = await prisma.labResult.updateMany({
      where: {
        id: row.id,
        userId: row.userId,
        takenAt: row.takenAt,
        deletedAt: null,
      },
      data: { takenAt: dateOnlyAtNoonUtc(day) },
    });
    if (moved.count === 0) {
      unchanged += 1;
      continue;
    }
    updated += 1;
    touchedUsers.add(row.userId);
  }

  for (const userId of touchedUsers) invalidateUserHealthScore(userId);
  return {
    scanned: rows.length,
    updated,
    unchanged,
    undecryptable: decryptFailed,
  };
}

/** The queue handler: one run over every account. */
export async function handleLabDocumentDateRepair(
  _jobs: Job<Record<string, never>>[],
  prisma: PrismaClient = defaultPrisma,
): Promise<JobOutcome> {
  return withBackgroundEvent("job.lab_document_date_repair", async () => {
    let result: LabDocumentDateRepairResult;
    try {
      result = await repairUndatedDocumentLabValues(prisma);
    } catch (err) {
      workerLog("error", "[lab-document-date-repair] failed", err);
      return jobFailed("lab document date repair failed", err);
    }
    workerLog(
      "info",
      `[lab-document-date-repair] scanned=${result.scanned} updated=${result.updated} unchanged=${result.unchanged} undecryptable=${result.undecryptable}`,
    );
    annotate({
      action: { name: "labs.documentDate.repair" },
      meta: { ...result },
    });
    return jobDone({
      candidates_scanned: result.scanned,
      updated: result.updated,
      unchanged: result.unchanged,
      undecryptable: result.undecryptable,
    });
  });
}

/**
 * Boot discovery: one existence query, and the one job only when there is
 * something to repair.
 */
export async function enqueueBootTimeLabDocumentDateRepair(
  prisma: PrismaClient = defaultPrisma,
): Promise<{ enqueued: boolean; error: string | null }> {
  const boss = getGlobalBoss();
  if (!boss) return { enqueued: false, error: null };
  try {
    const any = await prisma.$queryRaw<CandidateRow[]>(candidateQuery(1));
    if (any.length === 0) return { enqueued: false, error: null };
    const id = await boss.send(
      LAB_DOCUMENT_DATE_REPAIR_QUEUE,
      {},
      { singletonKey: LAB_DOCUMENT_DATE_REPAIR_SINGLETON_KEY, retryLimit: 2 },
    );
    return { enqueued: id !== null, error: null };
  } catch (err) {
    return {
      enqueued: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
