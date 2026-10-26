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
 * The database dumps count too. A dump is restored only with the key its rows
 * were written under (its manifest's active key; `db-restore` refuses without
 * it), so that key is needed for as long as the dump exists: a dump kept on
 * this server until retention removes it, an off-host one until the bucket's
 * rule for `database/` expires it. Without them, a rotation read as safe to
 * finish a week later while every dump from before it, the pre-migration
 * dumps that are the way back from an update among them, still needed the
 * retired key.
 *
 * Two readers ask it: the admin encryption view, which shows the table, and
 * the recovery kit, which lists every key a restore needs. One definition, so
 * the kit cannot drop a key the encryption view still calls needed.
 */
import {
  isGoodSet,
  listDumpSets,
  readManifestFile,
  resolveBackupDir,
} from "@/lib/database-backup/dump-core.mjs";
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
  /**
   * Per key id, the database dumps written under it: how many are kept on
   * this server, and the newest one that went off-host with when the bucket
   * expires it (`neededUntil` null when that cannot be read).
   */
  dumps: Array<{
    keyId: string;
    local: number;
    offhost: { lastWrittenAt: string; neededUntil: string | null } | null;
  }>;
  /** The bucket's expiry, when it has one the credential may read. */
  offhostExpirationDays: number | null;
  /** Retired key ids some backup still needs (never the active one). */
  retiredKeysStillNeeded: string[];
}

/**
 * The active key of every good dump in `dir`, one entry per dump. A manifest
 * that cannot be read names no key; `db-restore` refuses such a dump anyway.
 */
export async function localDumpKeyIds(dir: string): Promise<string[]> {
  const keys: string[] = [];
  for (const set of listDumpSets(dir).filter(isGoodSet)) {
    try {
      const manifest = await readManifestFile(set.manifest as string);
      const id = manifest.keys.encryption.activeKeyId;
      if (id) keys.push(id);
    } catch {
      // Unreadable: no key to name.
    }
  }
  return keys;
}

export async function readBackupKeyNeeds(
  activeKeyId: string,
  now: Date,
  options: { dumpDir?: string } = {},
): Promise<BackupKeyNeeds> {
  const [stored, unrecorded, offhostRows, dumpUploads, localDumpKeys] =
    await Promise.all([
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
      prisma.databaseBackupRun.groupBy({
        by: ["activeKeyId"],
        where: { offhostResult: "uploaded", activeKeyId: { not: null } },
        _max: { startedAt: true },
      }),
      localDumpKeyIds(options.dumpDir ?? resolveBackupDir()),
    ]);
  const lifecycle =
    (offhostRows.length > 0 || dumpUploads.length > 0) &&
    offhostBackupConfigured()
      ? await probeOffhostLifecycle()
      : null;
  const expirationDays =
    lifecycle?.state === "configured" ? lifecycle.expirationDays : null;
  const dumpExpirationDays =
    lifecycle?.database.state === "configured"
      ? lifecycle.database.expirationDays
      : null;
  const expiresAfter = (writtenAt: Date, days: number | null) =>
    days === null
      ? null
      : new Date(writtenAt.getTime() + (days + 1) * 86_400_000).toISOString();

  const dumpKeyIds = new Set([
    ...localDumpKeys,
    ...dumpUploads.map((row) => row.activeKeyId as string),
  ]);
  const dumps = [...dumpKeyIds].sort().map((keyId) => {
    const upload = dumpUploads.find((row) => row.activeKeyId === keyId);
    const writtenAt = upload?._max.startedAt ?? null;
    return {
      keyId,
      local: localDumpKeys.filter((id) => id === keyId).length,
      offhost: writtenAt
        ? {
            lastWrittenAt: writtenAt.toISOString(),
            neededUntil: expiresAfter(writtenAt, dumpExpirationDays),
          }
        : null,
    };
  });

  const offhost = offhostRows.map((row) => ({
    keyId: row.keyId,
    firstWrittenAt: row.firstWrittenAt.toISOString(),
    lastWrittenAt: row.lastWrittenAt.toISOString(),
    neededUntil: expiresAfter(row.lastWrittenAt, expirationDays),
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
    dumps,
    offhostExpirationDays: expirationDays,
    retiredKeysStillNeeded: [],
  };
  const retired = neededKeyIds(needs, now);
  retired.delete(activeKeyId);
  needs.retiredKeysStillNeeded = [...retired].sort();
  return needs;
}
