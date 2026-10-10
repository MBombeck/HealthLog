/**
 * The atomic weights the molar-mass conversions are derived from.
 *
 * Conventional atomic weights as published by the IUPAC Commission on Isotopic
 * Abundances and Atomic Weights (CIAAW), "Standard atomic weights". Only the
 * elements a conversion in the registry needs are listed; one more element is
 * one more line here, with a conversion that uses it.
 *
 * A molar mass is summed from these, never typed, so a long decimal cannot be
 * copied wrong into a factor that then touches every reading of a marker.
 */
export const ATOMIC_WEIGHTS_SOURCE =
  "IUPAC CIAAW, Standard atomic weights (conventional values)";

export const ATOMIC_WEIGHTS = {
  H: 1.008,
  C: 12.011,
  N: 14.007,
  O: 15.999,
  Ca: 40.078,
} as const;

export type Element = keyof typeof ATOMIC_WEIGHTS;

/** Atoms per molecule, by element: urea is `{ C: 1, H: 4, N: 2, O: 1 }`. */
export type Formula = Readonly<Partial<Record<Element, number>>>;

/** g/mol of a formula, summed from `ATOMIC_WEIGHTS`. */
export function molarMass(formula: Formula): number {
  let total = 0;
  for (const [element, count] of Object.entries(formula) as Array<
    [Element, number]
  >) {
    total += ATOMIC_WEIGHTS[element] * count;
  }
  // Summing decimals leaves float noise past the sixth place (180.15600000000001).
  return Math.round(total * 1e6) / 1e6;
}

/** `C6H12O6` for `{ C: 6, H: 12, O: 6 }`: for a citation, in a stable order. */
export function formulaLabel(formula: Formula): string {
  const order: Element[] = ["C", "H", "N", "O", "Ca"];
  return order
    .filter((element) => (formula[element] ?? 0) > 0)
    .map((element) => {
      const count = formula[element]!;
      return count === 1 ? element : `${element}${count}`;
    })
    .join("");
}
