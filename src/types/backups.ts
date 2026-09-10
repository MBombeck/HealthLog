/**
 * v1.4.41 W-ORG (org-audit rec #2) — DTOs for `/api/admin/backups`.
 *
 * Pre-v1.4.41 these interfaces lived inside the route handler at
 * `src/app/api/admin/backups/route.ts` and were imported directly from
 * the route module by `src/components/admin/backups-section.tsx`. That
 * was a textbook layer violation (component → route handler) and the
 * only one of its kind in the codebase. Hoisting the shapes here gives
 * both sides a route-handler-independent shared type home; the route
 * keeps owning the HTTP contract, the component keeps owning the UI.
 */
import type { BackupScheduleStatus } from "@/lib/jobs/backup-schedule-status";
import type { OffhostBackupFreshness } from "@/lib/jobs/offhost-backup-freshness";

export interface BackupRow {
  id: string;
  userId: string;
  username: string;
  type: string;
  /**
   * Size of the encrypted blob in bytes — useful for capacity planning.
   * The blob itself is never returned.
   */
  sizeBytes: number;
  createdAt: string;
}

/** One account's newest object in the operator's off-host bucket. */
export interface OffhostAccountRow {
  userId: string;
  username: string;
  /**
   * ISO instant a run last walked this account, or null when none has. Null
   * is what the whole cohort reads until the first run after the upgrade that
   * adds the ledger, and the card says so rather than claiming `never`.
   */
  lastAttemptAt: string | null;
  /** ISO instant the newest object landed, or null when there is none. */
  lastSuccessAt: string | null;
  /** Size of that object in bytes, or null when there is none. */
  sizeBytes: number | null;
  /** Whole hours since it landed, or null when there is none. */
  ageHours: number | null;
  freshness: OffhostBackupFreshness;
}

/**
 * The off-host picture, per account.
 *
 * Computed from the ledger the nightly worker writes, never from the bucket:
 * the page must be able to answer "does this account have a recent copy
 * off-host" on a host whose worker holds PutObject and nothing else.
 */
export interface OffhostBackupOverview {
  /** Whether this host has the variables the nightly job needs. */
  configured: boolean;
  /** Hours between two scheduled runs — the number behind the verdicts. */
  periodHours: number;
  /** One row per account. Empty when off-host backup is not configured. */
  rows: OffhostAccountRow[];
}

export interface BackupsList {
  rows: BackupRow[];
  /**
   * Whether the weekly schedule is still producing copies, and how the last
   * scheduled run ended. A row's own timestamp cannot answer that — a copy
   * made six weeks ago and one made on Sunday look identical in a table.
   */
  schedule: BackupScheduleStatus;
  /**
   * The off-host leg. A weekly row in this table says the copy that lives in
   * this database is current; it says nothing about whether anything reached
   * the operator's bucket, and those two fail independently.
   */
  offhost: OffhostBackupOverview;
  /**
   * Soft retention hint — the worker is configured for weekly backups
   * (see `DATA_BACKUP_CRON` in `src/lib/jobs/reminder-worker.ts`), and
   * the model upserts in-place per (userId, type), so each user has
   * exactly one current snapshot. The frontend uses this to label the
   * grid; no server-side enforcement.
   */
  retentionDays: number;
}
