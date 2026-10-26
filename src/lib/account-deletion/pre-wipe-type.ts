/**
 * The `DataBackup.type` of the account copy a data wipe takes first
 * (`PRE_WIPE_<unix-ms>`, see `pre-wipe-copy.ts`). A leaf module, so the wipe
 * plan, the purge job and the admin backups list can name it without loading
 * the copy writer.
 */
export const PRE_WIPE_BACKUP_TYPE_PREFIX = "PRE_WIPE_";

/** Whether a `DataBackup.type` names a copy taken before a data wipe. */
export function isPreWipeBackupType(type: string): boolean {
  return type.startsWith(PRE_WIPE_BACKUP_TYPE_PREFIX);
}
