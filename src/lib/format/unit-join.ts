/**
 * The space between a number and its unit.
 *
 * Server-worded text ("im Mittel bei 91 %", "120/80 mmHg") is rendered as
 * delivered by both clients, and a plain space lets a narrow line break
 * between the figure and its unit, leaving "%" or "mmHg" alone at the start
 * of the next line. The join is therefore U+00A0, the no-break space, in
 * every locale: it is also the space the French bundle already sets before
 * its high punctuation, and French sets a no-break space before a unit.
 *
 * The message bundles carry the same character between a placeholder and a
 * unit (`{value} {unit}`, `{value} %`), so a value filled into a
 * template and a value joined here read the same. zh-CN keeps no space at
 * all before a Chinese measure word; a Latin unit keeps its (no-break) space
 * there too. `src/__tests__/number-unit-nbsp-guard.test.ts` holds both.
 */
export const NBSP = " ";

/**
 * `value` and `unit` joined by a no-break space; `value` alone when there is
 * no unit.
 */
export function withUnit(
  value: string | number,
  unit: string | null | undefined,
): string {
  return unit ? `${value}${NBSP}${unit}` : String(value);
}
