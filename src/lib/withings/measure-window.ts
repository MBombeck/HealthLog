/**
 * The measure read's window. An incremental run filters on when Withings
 * received a group (`lastupdate`), never on its measure date: the watermark is
 * wall-clock time, and a reading the phone app uploads hours late carries a
 * measure date before it. The first and the full sync read by measure date.
 */
export function measureReadWindow(
  lastSyncedAt: Date | null,
  overlapMs: number,
  fullSync?: boolean,
): { startDate?: Date; updatedSince?: Date } {
  if (fullSync) return { startDate: undefined, updatedSince: undefined };
  if (!lastSyncedAt) {
    return { startDate: new Date(Date.now() - 30 * 86_400_000) };
  }
  const since = lastSyncedAt.getTime() - overlapMs;
  return { startDate: undefined, updatedSince: new Date(since) };
}
