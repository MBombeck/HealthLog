/**
 * Which application keys the backups still need.
 *
 * Rotation re-encrypts every row in the database and re-seals every stored
 * backup's envelope, but the content INSIDE a backup keeps the key it was
 * written under: a restore writes it back verbatim. So "every row is on the
 * active key" is not the same as "the old key can go". This answers the second
 * question per key id, from what each copy recorded as it was written: the
 * stored copies that need it and the oldest of them, and for the off-host
 * bucket the last night an object needing it went in, plus how long the
 * bucket's lifecycle rule keeps objects after that.
 *
 * Two readers ask it: the admin encryption view, which shows the table, and
 * the recovery kit, which lists every key a restore needs. One definition, so
 * the kit cannot drop a key the encryption view still calls needed.
 */
import { prisma } from "@/lib/db";
import {
  offhostBackupConfigured,
  probeOffhostLifecycle,
} from "@/lib/jobs/offhost-backup";
import { neededKeyIds } from "@/lib/recovery/kit-rules";

export interface BackupKeyNeeds {
  stored: Array<{ keyId: string; copies: number; oldestAt: string }>;
  /** Copies written before v1.39.3, which recorded no key ids. */
  unrecorded: { copies: number; oldestAt: string | null };
  offhost: Array<{
    keyId: string;
    firstWrittenAt: string;
    lastWrittenAt: string;
    /** When the last object needing this key expires; null when unknown. */
    neededUntil: string | null;
  }>;
  /** The bucket's expiry, when it has one the credential may read. */
  offhostExpirationDays: number | null;
  /** Retired key ids some backup still needs (never the active one). */
  retiredKeysStillNeeded: string[];
}

export async function readBackupKeyNeeds(
  activeKeyId: string,
  now: Date,
): Promise<BackupKeyNeeds> {
  const [stored, unrecorded, offhostRows] = await Promise.all([
    prisma.$queryRaw<
      Array<{ key_id: string; copies: number; oldest_at: Date }>
    >`
      SELECT k AS key_id, count(*)::int AS copies, min(created_at) AS oldest_at
      FROM data_backups, unnest(inner_key_ids) AS k
      WHERE inner_key_ids_recorded
      GROUP BY k
      ORDER BY k
    `,
    prisma.dataBackup.aggregate({
      where: { innerKeyIdsRecorded: false },
      _count: { _all: true },
      _min: { createdAt: true },
    }),
    prisma.offhostBackupKeyUse.findMany({ orderBy: { keyId: "asc" } }),
  ]);
  const lifecycle =
    offhostRows.length > 0 && offhostBackupConfigured()
      ? await probeOffhostLifecycle()
      : null;
  const expirationDays =
    lifecycle?.state === "configured" ? lifecycle.expirationDays : null;

  const offhost = offhostRows.map((row) => ({
    keyId: row.keyId,
    firstWrittenAt: row.firstWrittenAt.toISOString(),
    lastWrittenAt: row.lastWrittenAt.toISOString(),
    neededUntil:
      expirationDays === null
        ? null
        : new Date(
            row.lastWrittenAt.getTime() + (expirationDays + 1) * 86_400_000,
          ).toISOString(),
  }));

  const needs: BackupKeyNeeds = {
    stored: stored.map((row) => ({
      keyId: row.key_id,
      copies: row.copies,
      oldestAt: row.oldest_at.toISOString(),
    })),
    unrecorded: {
      copies: unrecorded._count._all,
      oldestAt: unrecorded._min.createdAt?.toISOString() ?? null,
    },
    offhost,
    offhostExpirationDays: expirationDays,
    retiredKeysStillNeeded: [],
  };
  const retired = neededKeyIds(needs, now);
  retired.delete(activeKeyId);
  needs.retiredKeysStillNeeded = [...retired].sort();
  return needs;
}
