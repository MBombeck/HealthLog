export type MedicationTableSortColumn =
  "name" | "nextDue" | "compliance" | "stock";

export interface MedicationTableSort {
  column: MedicationTableSortColumn;
  direction: "asc" | "desc";
}

/**
 * Tri-state header click cycle: none → ascending → descending → none.
 * `null` = the manual (user-defined) order the page passed in.
 */
export function nextSortState(
  current: MedicationTableSort | null,
  column: MedicationTableSortColumn,
): MedicationTableSort | null {
  if (!current || current.column !== column) {
    return { column, direction: "asc" };
  }
  if (current.direction === "asc") return { column, direction: "desc" };
  return null;
}

export interface SortableTableMedication {
  id: string;
  name: string;
  nextDueAt?: string | null;
  stockDosesRemaining?: number | null;
}

/**
 * Client-side sort over the loaded list. Rows without a value for the
 * chosen column (no next due, no compliance row yet, inventory tracking
 * off) sort last in BOTH directions — an unknown must never outrank a
 * known value. `null` sort returns the input order untouched (the
 * manual order).
 */
export function sortMedicationRows<T extends SortableTableMedication>(
  rows: readonly T[],
  sort: MedicationTableSort | null,
  shortRateById?: ReadonlyMap<string, number>,
  /** Active UI locale for name collation; omitted = runtime default. */
  locale?: string,
): T[] {
  if (!sort) return [...rows];
  const dir = sort.direction === "asc" ? 1 : -1;
  const value = (m: T): number | string | null => {
    switch (sort.column) {
      case "name":
        return m.name;
      case "nextDue": {
        if (!m.nextDueAt) return null;
        const ms = new Date(m.nextDueAt).getTime();
        return Number.isFinite(ms) ? ms : null;
      }
      case "compliance":
        return shortRateById?.get(m.id) ?? null;
      case "stock":
        return m.stockDosesRemaining ?? null;
    }
  };
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === "string" && typeof vb === "string") {
      return va.localeCompare(vb, locale, { sensitivity: "base" }) * dir;
    }
    return ((va as number) - (vb as number)) * dir;
  });
}
