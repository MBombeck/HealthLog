/**
 * The scheduled database dump, as the recovery readiness model sees it.
 *
 * The dump is the one artifact that rebuilds a lost host: it holds every
 * account, every grant and every credential, and a schema change cannot leave
 * anything out of it. Its health is a signal of its own in the readiness
 * model, read through a provider so the model does not reach into the dump's
 * module and a test can hand in any state it wants.
 *
 * A provider that answers `null` means "this build does not schedule a dump",
 * which the model reports as not available rather than as healthy or broken.
 */

/**
 * What the dump module reports about its own schedule. Mirrors
 * `DatabaseBackupHealth` in `src/lib/database-backup/health.ts` field for
 * field, so the provider below becomes that module's
 * `getDatabaseBackupHealth` without a translation.
 */
export interface DatabaseBackupHealth {
  /** `DB_BACKUP_ENABLED` is not off. */
  enabled: boolean;
  /** The directory dumps are kept in (`DB_BACKUP_DIR`). */
  directory: string;
  /** This process can write there. False means dumps only go off-host. */
  localDirWritable: boolean;
  /** The off-host bucket is configured, or a dump has been uploaded to it. */
  offhostConfigured: boolean;
  /** The newest dump that was kept on the server or reached the bucket. */
  lastGood: {
    at: string;
    fileName: string;
    sizeBytes: number | null;
    local: boolean;
    offhost: boolean;
  } | null;
  /** The newest run that failed, or that a dying process left unfinished. */
  lastFailure: { at: string; error: string } | null;
}

export type DatabaseBackupHealthProvider = (
  now?: Date,
) => Promise<DatabaseBackupHealth | null>;

/**
 * The provider every caller uses unless it passes its own: the dump's health,
 * or `null` while no dump is scheduled by this build.
 */
export const readDatabaseBackupHealth: DatabaseBackupHealthProvider =
  async () => null;
