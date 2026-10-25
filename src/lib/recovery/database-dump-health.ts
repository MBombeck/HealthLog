/**
 * The scheduled database dump, as the recovery readiness model sees it.
 *
 * The dump is the one artifact that rebuilds a lost host: it holds every
 * account, every grant and every credential, and a schema change cannot leave
 * anything out of it. Its health is a signal of its own in the readiness
 * model, read through a provider so the model does not reach into the dump's
 * module and a test can hand in any state it wants.
 *
 * A provider that answers `null` means "no dump is scheduled", which the model
 * reports as not available rather than as healthy or broken; the default
 * provider is the dump module's own health read.
 */

import {
  getDatabaseBackupHealth,
  type DatabaseBackupHealth,
} from "@/lib/database-backup/health";

export type { DatabaseBackupHealth };

export type DatabaseBackupHealthProvider = (
  now?: Date,
) => Promise<DatabaseBackupHealth | null>;

/** The provider every caller uses unless it passes its own. */
export const readDatabaseBackupHealth: DatabaseBackupHealthProvider = (now) =>
  getDatabaseBackupHealth(now);
