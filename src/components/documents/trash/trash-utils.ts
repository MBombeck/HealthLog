/**
 * How long a document in Recently deleted has left, in whole days, read from
 * the server's `purgeAt`.
 *
 * Rounded up: a document due in 26 days and 3 hours still has 27 days in which
 * it can be restored. Zero once the moment has passed; the nightly purge then
 * takes it at its next run.
 */
const DAY_MS = 86_400_000;

export function daysUntilPurge(
  purgeAt: string,
  now: Date = new Date(),
): number {
  const left = new Date(purgeAt).getTime() - now.getTime();
  if (!Number.isFinite(left) || left <= 0) return 0;
  return Math.ceil(left / DAY_MS);
}

/**
 * The translation key and parameters for a row's countdown line. The purge
 * runs once a night, so the last day is said as "within a day" rather than a
 * time the job does not keep.
 */
export function purgeCountdownKey(days: number): {
  key: "documents.trash.removesIn" | "documents.trash.removesSoon";
  params?: { days: number };
} {
  if (days <= 1) return { key: "documents.trash.removesSoon" };
  return { key: "documents.trash.removesIn", params: { days } };
}
