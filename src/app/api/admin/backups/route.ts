/**
 * GET /api/admin/backups — admin-only listing of `DataBackup` rows.
 *
 * Returns one row per (userId, type) pair. The `data` payload is NOT
 * shipped — only metadata (id, userId, username, type, size in bytes,
 * createdAt). The encrypted blob remains server-side; admins can trigger
 * a re-snapshot but not download another user's payload from the UI.
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
// v1.4.41 W-ORG — `BackupRow` / `BackupsList` moved to `src/types/backups.ts`
// so callers (in particular `components/admin/backups-section.tsx`) don't
// have to reach across the component → route-handler layer boundary.
import type { BackupRow, BackupsList } from "@/types/backups";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.backups.list" } });

  // Pull metadata only — `data` would balloon the response and reveal
  // ciphertext we don't need on the listing page.
  const backups = await prisma.dataBackup.findMany({
    include: { user: { select: { id: true, username: true } } },
    orderBy: { createdAt: "desc" },
  });

  const rows: BackupRow[] = backups.map((b) => ({
    id: b.id,
    userId: b.userId,
    username: b.user.username,
    type: b.type,
    sizeBytes: Buffer.byteLength(b.data, "utf8"),
    createdAt: b.createdAt.toISOString(),
  }));

  const payload: BackupsList = {
    rows,
    // Matches the retention window the backup-prune job enforces so the
    // backups page states the same number the worker acts on.
    retentionDays: 90,
  };

  return apiSuccess(payload);
});
