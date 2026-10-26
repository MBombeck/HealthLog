/**
 * The queue facts of `offhost-backup.ts`: its name and, where it has them, its
 * schedule, concurrency and send options. They live apart from the job so the
 * worker registry and every sender can read them without loading it.
 */
import { BACKUP_HEARTBEAT_SECONDS } from "@/lib/jobs/data-backup-policy";

/**
 * The off-host pass's expiry: four hours. It uploads every account and
 * already stopped between accounts at three quarters of the default fifteen
 * minutes, which on an instance of any size meant a retry per night; one
 * large account past the default was retried beside itself. Four hours with
 * the same budget and a lock (`lockedPass`) leaves room for the night's pass.
 */
export const OFFHOST_BACKUP_EXPIRE_SECONDS = 4 * 60 * 60;

export const OFFHOST_BACKUP_QUEUE = "data-backup-offhost";

/**
 * What the nightly schedule sends with: the four hours above, and the
 * heartbeat that notices a process that died under the pass within minutes
 * rather than at the end of them (`BACKUP_HEARTBEAT_SECONDS`).
 */
export const OFFHOST_BACKUP_SEND_OPTIONS = {
  expireInSeconds: OFFHOST_BACKUP_EXPIRE_SECONDS,
  heartbeatSeconds: BACKUP_HEARTBEAT_SECONDS,
} as const;
