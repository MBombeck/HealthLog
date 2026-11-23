/** The quick-entry chip row's filter, kept apart so it tests without a DOM. */

/**
 * Above this many symptoms the chip row gets a filter field: the person's
 * own ones plus the built-in ones Apple Health created no longer fit a
 * glance on a phone.
 */
export const SYMPTOM_FILTER_THRESHOLD = 12;

/**
 * The chips a filter leaves: every one whose name holds the text, plus every
 * picked one, so a choice never disappears while the person looks for the
 * next.
 */
export function filterSymptomChips<
  T extends { id: string; label: string | null },
>(list: readonly T[], filter: string, picked: readonly string[]): T[] {
  const needle = filter.trim().toLocaleLowerCase();
  if (!needle) return [...list];
  return list.filter(
    (d) =>
      picked.includes(d.id) ||
      (d.label ?? "").toLocaleLowerCase().includes(needle),
  );
}

interface RecentUse {
  recent: { count30d: number; lastOccurredAt: string | null };
}

/**
 * The chip row in order of use: the symptoms felt most often over the last
 * 30 days first, a tie broken by the one felt most recently, then every
 * other symptom in the order the person keeps them. The row used to follow
 * creation order only, so thirty imported Apple Health symptoms pushed the
 * two a person logs every week out of sight.
 */
export function orderSymptomsByUse<T extends RecentUse>(
  list: readonly T[],
): T[] {
  const time = (d: T) =>
    d.recent.lastOccurredAt ? Date.parse(d.recent.lastOccurredAt) : -Infinity;
  const used = list
    .filter((d) => d.recent.count30d > 0)
    .sort((a, b) => b.recent.count30d - a.recent.count30d || time(b) - time(a));
  return [...used, ...list.filter((d) => d.recent.count30d === 0)];
}

/**
 * Each symptom's most recent intensity, from occurrences listed newest
 * first: the value its slider starts on the next time it is picked.
 */
export function latestIntensityById(
  events: ReadonlyArray<{ definitionId: string; intensity: number }>,
): Map<string, number> {
  const latest = new Map<string, number>();
  for (const event of events) {
    if (!latest.has(event.definitionId)) {
      latest.set(event.definitionId, event.intensity);
    }
  }
  return latest;
}
