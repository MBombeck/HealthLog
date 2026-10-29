/**
 * The `DataBackup.type` of a copy an admin uploaded.
 *
 * A file uploaded for the account it names is `MANUAL_UPLOAD_<ms>`. A file
 * uploaded into another account (the copy of an erased account, put into the
 * account chosen for it) is `RETARGETED_UPLOAD_<ms>`, and the mark stays with
 * the stored copy: its settings were written by the file's author, not by the
 * account it now belongs to, so its restore never takes them on the
 * operator's word, whatever that account's role is by then. The millisecond
 * suffix keeps the `(userId, type)` unique constraint free for several
 * uploads beside the rolling `WEEKLY_AUTO` copy.
 */
const MANUAL_UPLOAD_PREFIX = "MANUAL_UPLOAD_";
const RETARGETED_UPLOAD_PREFIX = "RETARGETED_UPLOAD_";

export function uploadedBackupType(retargeted: boolean, now: number): string {
  return `${retargeted ? RETARGETED_UPLOAD_PREFIX : MANUAL_UPLOAD_PREFIX}${now}`;
}

/** Whether a stored copy was uploaded into an account other than its own. */
export function isRetargetedUploadType(type: string): boolean {
  return type.startsWith(RETARGETED_UPLOAD_PREFIX);
}
