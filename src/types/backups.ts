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

export interface BackupsList {
  rows: BackupRow[];
  /**
   * Soft retention hint — the worker is configured for weekly backups
   * (see `DATA_BACKUP_CRON` in `src/lib/jobs/reminder-worker.ts`), and
   * the model upserts in-place per (userId, type), so each user has
   * exactly one current snapshot. The frontend uses this to label the
   * grid; no server-side enforcement.
   */
  retentionDays: number;
}
