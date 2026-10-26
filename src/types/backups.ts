/**
 * v1.4.41 (org-audit rec #2) — DTOs for `/api/admin/backups`.
 *
 * Pre-v1.4.41 these interfaces lived inside the route handler at
 * `src/app/api/admin/backups/route.ts` and were imported directly from
 * the route module by `src/components/admin/backups-section.tsx`. That
 * was a textbook layer violation (component → route handler) and the
 * only one of its kind in the codebase. Hoisting the shapes here gives
 * both sides a route-handler-independent shared type home; the route
 * keeps owning the HTTP contract, the component keeps owning the UI.
 */
import type { DatabaseBackupHealth } from "@/lib/database-backup/health";
import type { OffhostLifecycle } from "@/lib/jobs/offhost-lifecycle";
import type { BackupPassActivity } from "@/lib/jobs/backup-pass-attempts";
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
 * off-host" on a host whose worker holds no listing grant on the bucket.
 */
export interface OffhostBackupOverview {
  /** Whether this host has the variables the nightly job needs. */
  configured: boolean;
  /** The run in progress, and accounts a run died under. */
  activity: BackupPassActivity;
  /** Hours between two scheduled runs — the number behind the verdicts. */
  periodHours: number;
  /** One row per account. Empty when off-host backup is not configured. */
  rows: OffhostAccountRow[];
  /**
   * Deleted or wiped accounts whose copies are still in the bucket. A count
   * above zero with an error means the bucket refused the deletion (most
   * often a credential without DeleteObject); the job retries nightly.
   */
  pendingDeletions: {
    count: number;
    oldestRequestedAt: string | null;
    lastFailure: string | null;
  };
  /**
   * Whether the bucket retires old copies by itself. Read from the bucket
   * (`GetBucketLifecycleConfiguration`), cached for ten minutes; `unknown`
   * when the credential may not read it.
   */
  lifecycle: OffhostLifecycle;
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
   * The weekly run in progress, and accounts a run died under: a start
   * without a finish, which a crash leaves and a caught failure does not.
   */
  scheduleActivity: BackupPassActivity;
  /**
   * The off-host leg. A weekly row in this table says the copy that lives in
   * this database is current; it says nothing about whether anything reached
   * the operator's bucket, and those two fail independently.
   */
  offhost: OffhostBackupOverview;
  /**
   * The nightly whole-database dump, the copy that rebuilds a lost server:
   * the newest good dump (kept here, off-host, or both), the newest failed
   * run, and whether this server can keep dumps at all.
   */
  database: DatabaseBackupHealth;
  /**
   * How long a copy taken before "Delete all data" is kept: the deletion
   * grace window, after which the account-deletion purge deletes it. 0 when
   * there is no window and no such copy is taken. Nothing else ages a stored
   * copy out: the weekly copy is replaced in place, one per account, and an
   * uploaded copy stays until its account is erased. The page states exactly
   * that.
   */
  preWipeCopyDays: number;
}
