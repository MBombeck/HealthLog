/**
 * GET /api/admin/backups — admin-only listing of `DataBackup` rows.
 *
 * Returns one row per (userId, type) pair. The `data` payload is NOT
 * shipped by THIS route — only metadata (id, userId, username, type, size in
 * bytes, createdAt), so the listing costs a count and not a decrypt. The
 * payload has its own route: `/api/admin/backups/<id>/download` decrypts one
 * snapshot for the admin who asks for it, and the ciphertext stays in the
 * database either way.
 *
 * Alongside the rows, the response says whether the SCHEDULE is still alive:
 * how old the newest scheduled copy is and how the last scheduled run ended.
 * Without those two the page cannot tell a working backup from one that
 * stopped six weeks ago — every row it lists has a perfectly ordinary
 * timestamp either way.
 *
 * And alongside both, the off-host leg: one row per account saying when this
 * host last put that account's encrypted copy in the operator's bucket and how
 * stale that is against the nightly schedule. It comes from the ledger the
 * worker writes, never from a bucket listing — the answer has to hold on a host
 * whose worker grant is PutObject and nothing else.
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { DATA_BACKUP_QUEUE } from "@/lib/jobs/data-backup-policy";
import { readLastQueueRun } from "@/lib/jobs/job-failures";
import { summariseBackupSchedule } from "@/lib/jobs/backup-schedule-status";
import { offhostBackupConfigured } from "@/lib/jobs/offhost-backup";
import {
  classifyOffhostBackup,
  OFFHOST_BACKUP_PERIOD_HOURS,
} from "@/lib/jobs/offhost-backup-freshness";
// v1.4.41 W-ORG — `BackupRow` / `BackupsList` moved to `src/types/backups.ts`
// so callers (in particular `components/admin/backups-section.tsx`) don't
// have to reach across the component → route-handler layer boundary.
import type {
  BackupRow,
  BackupsList,
  OffhostAccountRow,
} from "@/types/backups";

export const dynamic = "force-dynamic";

/** The type the weekly worker writes; anything else was uploaded by hand. */
const SCHEDULED_BACKUP_TYPE = "WEEKLY_AUTO";

interface BackupMetaRow {
  id: string;
  user_id: string;
  username: string;
  type: string;
  size_bytes: number;
  created_at: Date;
}

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.backups.list" } });

  // Metadata only, and the size read as `octet_length` in the database rather
  // than by pulling every blob into this process to measure it. The listing
  // needs a number, not the ciphertext, and on an instance with large records
  // fetching them all was its own way of running out of memory. Base64 is
  // ASCII, so the column's byte length is exactly what the wire reports.
  const rows = await prisma.$queryRaw<BackupMetaRow[]>`
    SELECT b.id, b.user_id, u.username, b.type,
           octet_length(b.data) AS size_bytes,
           b.created_at
    FROM data_backups b
    JOIN users u ON u.id = b.user_id
    ORDER BY b.created_at DESC
  `;

  const list: BackupRow[] = rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    username: row.username,
    type: row.type,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at.toISOString(),
  }));

  // The off-host leg, per account, read from the ledger the nightly worker
  // writes rather than from the bucket. The page must be able to answer "which
  // account has no recent copy off-host" on a host whose worker grant is
  // PutObject and nothing else, and a listing call from a page render would
  // put the operator's credentials on the request path of every page view.
  const now = new Date();
  const configured = offhostBackupConfigured();
  const offhostAccounts = configured
    ? await prisma.user.findMany({
        select: {
          id: true,
          username: true,
          offhostBackupState: {
            select: { lastSuccessAt: true, sizeBytes: true },
          },
        },
        orderBy: { username: "asc" },
      })
    : [];

  const offhostRows: OffhostAccountRow[] = offhostAccounts.map((account) => {
    const state = account.offhostBackupState;
    const verdict = classifyOffhostBackup({
      lastSuccessAt: state?.lastSuccessAt ?? null,
      now,
    });
    return {
      userId: account.id,
      username: account.username,
      lastSuccessAt: state?.lastSuccessAt.toISOString() ?? null,
      // BigInt column -> number on the wire. The value is bytes of one
      // object, capped by the uploader at 80 GB, so it is nowhere near
      // Number.MAX_SAFE_INTEGER and JSON has no BigInt.
      sizeBytes: state ? Number(state.sizeBytes) : null,
      ageHours: verdict.ageHours,
      freshness: verdict.freshness,
    };
  });

  const payload: BackupsList = {
    rows: list,
    // Matches the retention window the backup-prune job enforces so the
    // backups page states the same number the worker acts on.
    retentionDays: 90,
    schedule: summariseBackupSchedule({
      scheduledCreatedAt: rows
        .filter((row) => row.type === SCHEDULED_BACKUP_TYPE)
        .map((row) => row.created_at),
      lastRun: await readLastQueueRun(DATA_BACKUP_QUEUE),
      now,
    }),
    offhost: {
      configured,
      periodHours: OFFHOST_BACKUP_PERIOD_HOURS,
      rows: offhostRows,
    },
  };

  return apiSuccess(payload);
});
