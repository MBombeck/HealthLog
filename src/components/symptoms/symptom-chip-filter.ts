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
