/**
 * v1.40 (#1041) — the category filter on the medications list. Pure, so the
 * page and its tests share one definition of what the filter offers and what
 * it keeps.
 */
import { getMedicationCategoryLabel } from "@/lib/medications/category-label";

type Translator = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/** The "no filter" sentinel, the value `FilterBarSelect` resets to. */
export const ALL_MEDICATION_CATEGORIES = "ALL";

interface CategorisedMedication {
  category: string;
  categoryLabel?: string | null;
}

/**
 * The categories the given medications use, each once, labelled the way the
 * card badge labels it, sorted by label. The filter offers only these, so a
 * pick can never empty the list.
 */
export function medicationCategoryOptions(
  medications: readonly CategorisedMedication[],
  t: Translator,
): { value: string; label: string }[] {
  const byValue = new Map<string, string>();
  for (const m of medications) {
    if (!byValue.has(m.category)) {
      byValue.set(
        m.category,
        getMedicationCategoryLabel(m.category, t, m.categoryLabel),
      );
    }
  }
  return [...byValue.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The filter value that actually applies: a stored pick whose category no
 * medication uses any more (deleted, or every medication moved) falls back to
 * All rather than showing an empty list.
 */
export function effectiveCategoryFilter(
  stored: string,
  options: readonly { value: string }[],
): string {
  return options.some((option) => option.value === stored)
    ? stored
    : ALL_MEDICATION_CATEGORIES;
}

/** Keep the medications the filter admits, in their order. */
export function filterMedicationsByCategory<T extends CategorisedMedication>(
  medications: readonly T[],
  filter: string,
): T[] {
  return filter === ALL_MEDICATION_CATEGORIES
    ? [...medications]
    : medications.filter((m) => m.category === filter);
}
