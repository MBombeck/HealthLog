/**
 * The account copy a data wipe takes before it deletes anything.
 *
 * "Delete all my data" keeps the account and empties the record. Until v1.46
 * it also deleted every stored copy of the record in the same transaction and
 * purged the off-host objects at once, so a wipe pressed by mistake was
 * final. Now, with a grace window, the wipe first stores the whole record
 * through the same writer the weekly copy uses (`writeAccountCopy`), as a
 * copy of its own type, `PRE_WIPE_<unix-ms>`:
 *
 *   - its own type, because `DataBackup` is unique on `(userId, type)` and the
 *     weekly pass overwrites `WEEKLY_AUTO` in place every Sunday;
 *   - a timestamped type, so a second wipe inside the window (after the
 *     person recorded a few days of new data) cannot overwrite the copy of
 *     the record the first wipe emptied.
 *
 * The wipe leaves these copies alone (`WIPE_KEPT_ROWS`), the admin backups
 * page lists them beside the weekly copy, and the ordinary restore brings the
 * record back, because the owner still exists. The account-deletion purge job
 * deletes each one when its window ends. The off-host purge the wipe asks for
 * waits for the same moment (`OffhostPurgeRequest.notBefore`).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { writeAccountCopy } from "@/lib/export/account-copy";
import { PRE_WIPE_BACKUP_TYPE_PREFIX } from "./pre-wipe-type";

/** Store `userId`'s whole record as a new `PRE_WIPE_<ms>` copy. */
export async function takePreWipeCopy(
  prisma: PrismaClient,
  userId: string,
  takenAt: Date = new Date(),
): Promise<{ id: string; type: string; bytes: number }> {
  const type = `${PRE_WIPE_BACKUP_TYPE_PREFIX}${takenAt.getTime()}`;
  const { id, bytes } = await writeAccountCopy(prisma, userId, type);
  return { id, type, bytes };
}
